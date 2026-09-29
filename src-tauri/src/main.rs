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

fn save_monitor(app: &AppHandle, selection: &str) {
    if let Some(path) = saved_path(app) {
        let _ = path.parent().map(fs::create_dir_all);
        let _ = fs::write(path, selection);
    }
}

// macOS의 이름은 모델 번호라 같을 수 있다. 해상도·배율과 무관한 위치를 함께 쓴다.
fn monitor_key(monitor: &Monitor) -> String {
    format!("{}:{}:{}", monitor.position().x, monitor.position().y, monitor.name().map(String::as_str).unwrap_or_default())
}

fn key_name(key: &str) -> &str {
    key.splitn(3, ':').nth(2).unwrap_or_default()
}

fn unique_name_index(name: &str, keys: &[String]) -> Option<usize> {
    if name.is_empty() { return None; }
    let mut matches = keys.iter().enumerate().filter(|(_, key)| key_name(key) == name);
    let (index, _) = matches.next()?;
    if matches.next().is_none() { Some(index) } else { None }
}

fn monitor_selection(key: &str, keys: &[String]) -> String {
    let mode = if unique_name_index(key_name(key), keys).is_some() { "unique" } else { "position" };
    format!("v1:{mode}\n{key}")
}

fn saved_monitor_index(saved: &str, keys: &[String]) -> Option<usize> {
    if let Some((mode, key)) = saved.split_once('\n') {
        if !matches!(mode, "v1:unique" | "v1:position") { return None; }
        keys.iter().position(|candidate| candidate == key).or_else(|| {
            // 중복 이름에서 고른 화면이 빠졌을 때 남은 같은 모델을 잘못 선택하지 않는다.
            if mode == "v1:unique" { unique_name_index(key_name(key), keys) } else { None }
        })
    } else {
        // 이전 monitor.txt의 이름만 있는 값은 유일한 경우에만 복원한다.
        unique_name_index(saved, keys)
    }
}

/// 트레이에서 고른 모니터가 연결돼 있으면 그것, 아니면 주 모니터.
fn target_monitor(app: &AppHandle) -> Option<Monitor> {
    let all = monitors(app);
    let keys: Vec<_> = all.iter().map(monitor_key).collect();
    saved_monitor(app)
        .and_then(|saved| saved_monitor_index(&saved, &keys))
        .map(|index| all[index].clone())
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

/// 마지막 마우스·키보드 입력 뒤로 지난 초(시스템 전체). 오래 입력이 없으면 봉구가 잔다.
#[tauri::command]
fn idle_seconds() -> f64 {
    seconds_since_input()
}

#[cfg(windows)]
fn seconds_since_input() -> f64 {
    #[repr(C)]
    struct LastInputInfo {
        size: u32,
        time: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }
    let mut info = LastInputInfo { size: std::mem::size_of::<LastInputInfo>() as u32, time: 0 };
    // 틱은 49일마다 한 바퀴 돌아서 wrapping_sub로 뺀다.
    unsafe {
        if GetLastInputInfo(&mut info) == 0 {
            return 0.0;
        }
        GetTickCount().wrapping_sub(info.time) as f64 / 1000.0
    }
}

#[cfg(target_os = "macos")]
fn seconds_since_input() -> f64 {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event: u32) -> f64;
    }
    // kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType
    unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn seconds_since_input() -> f64 {
    0.0
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let current = target_monitor(app).as_ref().map(monitor_key);
    let primary = app.primary_monitor().ok().flatten().as_ref().map(monitor_key);
    let screens = Submenu::new(app, "모니터 (왼쪽부터)", true)?;
    for (i, m) in monitors(app).iter().enumerate() {
        let key = monitor_key(m);
        let mut label = format!("모니터 {} ({}×{})", i + 1, m.size().width, m.size().height);
        if Some(&key) == primary.as_ref() {
            label.push_str(" · 주 모니터");
        }
        let checked = Some(&key) == current.as_ref();
        screens.append(&CheckMenuItem::with_id(app, format!("monitor:{key}"), label, true, checked, None::<&str>)?)?;
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
    } else if let Some(key) = id.strip_prefix("monitor:") {
        let keys: Vec<_> = monitors(app).iter().map(monitor_key).collect();
        if !keys.iter().any(|candidate| candidate == key) { return; }
        save_monitor(app, &monitor_selection(key, &keys));
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
            let win = app.get_webview_window("main").expect("main window");
            // WebGL·모델 로딩이 실패해도 투명 창이 바탕화면 입력을 막지 않는다.
            win.set_ignore_cursor_events(true)?;
            place(&handle)?;
            win.show()?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("봉구")
                .menu(&tray_menu(&handle)?)
                .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
                .build(app)?;

            watch_monitors(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![idle_seconds])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{monitor_selection, saved_monitor_index};

    #[test]
    fn same_model_displays_are_selected_and_restored_separately() {
        let keys: Vec<String> = vec!["0:0:Monitor #123".into(), "1920:0:Monitor #123".into()];
        for index in 0..keys.len() {
            let saved = monitor_selection(&keys[index], &keys);
            assert_eq!(saved_monitor_index(&saved, &keys), Some(index));
            let remaining = vec![keys[1 - index].clone()];
            assert_eq!(saved_monitor_index(&saved, &remaining), None);
            assert_eq!(saved_monitor_index(&saved, &keys), Some(index));
        }
        assert_eq!(saved_monitor_index("Monitor #123", &keys), None);
    }

    #[test]
    fn unique_name_survives_position_changes_and_legacy_settings() {
        let keys: Vec<String> = vec!["0:0:DISPLAY1".into(), "1920:0:DISPLAY2".into()];
        let saved = monitor_selection(&keys[1], &keys);
        let moved = vec!["0:0:DISPLAY1".into(), "2560:0:DISPLAY2".into()];
        assert_eq!(saved_monitor_index(&saved, &moved), Some(1));
        assert_eq!(saved_monitor_index("DISPLAY2", &moved), Some(1));
        assert_eq!(saved_monitor_index(&saved, &[]), None);
    }

    #[test]
    fn unnamed_monitors_use_position_without_a_name_fallback() {
        let keys: Vec<String> = vec!["-1920:0:".into(), "0:0:".into()];
        let saved = monitor_selection(&keys[0], &keys);
        assert_eq!(saved_monitor_index(&saved, &keys), Some(0));
        assert_eq!(saved_monitor_index(&saved, &keys[1..]), None);
        assert_eq!(saved_monitor_index("", &keys), None);
        assert_eq!(saved_monitor_index("v9:unknown\n0:0:", &keys), None);
    }
}
