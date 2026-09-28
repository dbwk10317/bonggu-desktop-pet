// 릴리스 빌드에서 콘솔 창을 띄우지 않는다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    Emitter, Manager, PhysicalPosition, PhysicalSize,
};

/// 작업 영역 바닥에 붙는 띠 창의 높이(논리 픽셀).
const STRIP_HEIGHT: f64 = 300.0;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 주 모니터 작업 영역(작업 표시줄 제외) 바닥에 전체 너비로 붙인다.
            let win = app.get_webview_window("main").expect("main window");
            if let Some(monitor) = win.primary_monitor()? {
                let area = monitor.work_area();
                let height = (STRIP_HEIGHT * monitor.scale_factor()).round() as u32;
                win.set_size(PhysicalSize::new(area.size.width, height))?;
                win.set_position(PhysicalPosition::new(
                    area.position.x,
                    area.position.y + area.size.height as i32 - height as i32,
                ))?;
            }
            win.show()?;

            let small = MenuItem::with_id(app, "size:small", "작게", true, None::<&str>)?;
            let medium = MenuItem::with_id(app, "size:medium", "보통", true, None::<&str>)?;
            let large = MenuItem::with_id(app, "size:large", "크게", true, None::<&str>)?;
            let size = Submenu::with_items(app, "크기", true, &[&small, &medium, &large])?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&size, &PredefinedMenuItem::separator(app)?, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("봉구")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    id => {
                        if let Some(size) = id.strip_prefix("size:") {
                            let _ = app.emit("size", size);
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
