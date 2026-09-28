// 릴리스 빌드에서 콘솔 창을 띄우지 않는다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::PathBuf, thread, time::Duration};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, Wry,
};

const TRAY_ID: &str = "main";
/// 모니터 연결·해상도·작업 표시줄 변화를 확인하는 주기.
const MONITOR_POLL: Duration = Duration::from_secs(3);

/// 연결된 모니터를 왼쪽부터 정렬해 돌려준다.
fn monitors(app: &AppHandle) -> Vec<Monitor> {
    let mut all = app.available_monitors().unwrap_or_default();
    all.sort_by_key(|m| (m.position().x, m.position().y));
    all
}

fn saved_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("monitor.txt"))
}

fn saved_monitor(app: &AppHandle) -> Option<String> {
    fs::read_to_string(saved_path(app)?).ok().map(|s| s.trim().to_string())
}

fn save_monitor(app: &AppHandle, name: &str) {
    if let Some(path) = saved_path(app) {
        let _ = path.parent().map(fs::create_dir_all);
        let _ = fs::write(path, name);
    }
}

/// 트레이에서 고른 모니터가 연결돼 있으면 그것, 아니면 주 모니터.
fn target_monitor(app: &AppHandle) -> Option<Monitor> {
    let saved = saved_monitor(app);
    monitors(app)
        .into_iter()
        .find(|m| saved.is_some() && m.name() == saved.as_ref())
        .or_else(|| app.primary_monitor().ok().flatten())
}

/// 대상 모니터 작업 영역(작업 표시줄 제외)을 덮는다. 평소에는 앱이 바닥 띠만 그리고,
/// 봉구를 들어 올릴 때만 창 전체를 그린다. 창 크기를 바꾸면 깜빡여서 크기는 고정한다.
fn place(app: &AppHandle) -> tauri::Result<()> {
    let (Some(win), Some(monitor)) = (app.get_webview_window("main"), target_monitor(app)) else {
        return Ok(());
    };
    let area = monitor.work_area();
    let pos = PhysicalPosition::new(area.position.x, area.position.y);
    // 배율이 다른 모니터로 옮기면 Windows가 크기를 다시 맞추므로, 옮긴 뒤 크기를 정하고 위치를 한 번 더 맞춘다.
    win.set_position(pos)?;
    win.set_size(PhysicalSize::new(area.size.width, area.size.height))?;
    win.set_position(pos)?;
    Ok(())
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let current = target_monitor(app).and_then(|m| m.name().cloned());
    let primary = app.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    let screens = Submenu::new(app, "모니터 (왼쪽부터)", true)?;
    for (i, m) in monitors(app).iter().enumerate() {
        let name = m.name().cloned().unwrap_or_default();
        let mut label = format!("모니터 {} ({}×{})", i + 1, m.size().width, m.size().height);
        if Some(&name) == primary.as_ref() {
            label.push_str(" · 주 모니터");
        }
        let checked = Some(&name) == current.as_ref();
        screens.append(&CheckMenuItem::with_id(app, format!("monitor:{name}"), label, true, checked, None::<&str>)?)?;
    }

    let small = MenuItem::with_id(app, "size:small", "작게", true, None::<&str>)?;
    let medium = MenuItem::with_id(app, "size:medium", "보통", true, None::<&str>)?;
    let large = MenuItem::with_id(app, "size:large", "크게", true, None::<&str>)?;
    let size = Submenu::with_items(app, "크기", true, &[&small, &medium, &large])?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    Menu::with_items(app, &[&screens, &size, &PredefinedMenuItem::separator(app)?, &quit])
}

/// 체크 표시를 현재 모니터에 맞추려고 메뉴를 새로 만든다.
fn refresh_menu(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    if id == "quit" {
        app.exit(0);
    } else if let Some(size) = id.strip_prefix("size:") {
        let _ = app.emit("size", size);
    } else if let Some(name) = id.strip_prefix("monitor:") {
        save_monitor(app, name);
        let _ = place(app);
        refresh_menu(app);
    }
}

/// 모니터를 꽂고 빼거나 해상도·작업 표시줄이 바뀌면 창을 다시 붙이고 메뉴를 갱신한다.
/// 고른 모니터가 빠지면 주 모니터로 가고, 다시 꽂히면 돌아간다.
fn watch_monitors(app: AppHandle) {
    thread::spawn(move || {
        let signature = |app: &AppHandle| {
            monitors(app)
                .iter()
                .map(|m| format!("{:?}{:?}{:?}{:?}{};", m.name(), m.position(), m.size(), m.work_area(), m.scale_factor()))
                .collect::<String>()
        };
        let mut last = signature(&app);
        loop {
            thread::sleep(MONITOR_POLL);
            let now = signature(&app);
            if now != last {
                last = now;
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = place(&handle);
                    refresh_menu(&handle);
                });
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            place(&handle)?;
            app.get_webview_window("main").expect("main window").show()?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("봉구")
                .menu(&tray_menu(&handle)?)
                .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
                .build(app)?;

            watch_monitors(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
