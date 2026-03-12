use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

static MONITORING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
struct CursorPosition {
    x: i32,
    y: i32,
    window_x: i32,
    window_y: i32,
    window_w: u32,
    window_h: u32,
}

#[tauri::command]
async fn pick_vrm_file() -> Result<Option<String>, String> {
    let file = rfd::AsyncFileDialog::new()
        .add_filter("VRM Model", &["vrm"])
        .pick_file()
        .await;
    Ok(file.map(|f| f.path().to_string_lossy().to_string()))
}

#[tauri::command]
async fn start_cursor_monitor(window: tauri::Window) -> Result<(), String> {
    if MONITORING.load(Ordering::Relaxed) {
        return Ok(());
    }
    MONITORING.store(true, Ordering::Relaxed);

    tauri::async_runtime::spawn(async move {
        use tokio::time::{sleep, Duration};

        while MONITORING.load(Ordering::Relaxed) {
            sleep(Duration::from_millis(32)).await;

            #[cfg(target_os = "windows")]
            {
                use windows::Win32::Foundation::{POINT, RECT};
                use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};

                unsafe {
                    let mut cursor = POINT::default();
                    if GetCursorPos(&mut cursor).is_err() {
                        continue;
                    }

                    let hwnd = window.hwnd().unwrap();
                    let mut rect = RECT::default();
                    if GetWindowRect(hwnd, &mut rect).is_err() {
                        continue;
                    }

                    let _ = window.emit(
                        "cursor-position",
                        CursorPosition {
                            x: cursor.x,
                            y: cursor.y,
                            window_x: rect.left,
                            window_y: rect.top,
                            window_w: (rect.right - rect.left) as u32,
                            window_h: (rect.bottom - rect.top) as u32,
                        },
                    );
                }
            }

            #[cfg(target_os = "macos")]
            {
                use core_graphics::event::CGEvent;
                use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

                let Ok(source) = CGEventSource::new(CGEventSourceStateID::CombinedSessionState) else {
                    continue;
                };
                let Ok(event) = CGEvent::new(source) else {
                    continue;
                };
                let loc = event.location();

                let pos = window.outer_position().unwrap_or_default();
                let size = window.outer_size().unwrap_or_default();

                let _ = window.emit(
                    "cursor-position",
                    CursorPosition {
                        x: loc.x as i32,
                        y: loc.y as i32,
                        window_x: pos.x,
                        window_y: pos.y,
                        window_w: size.width,
                        window_h: size.height,
                    },
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn stop_cursor_monitor() -> Result<(), String> {
    MONITORING.store(false, Ordering::Relaxed);
    Ok(())
}


fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示/隐藏", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &settings, &sep, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Claw Sama")
        .menu(&menu)
        .on_menu_event(move |app: &tauri::AppHandle, event| {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            match event.id().as_ref() {
                "show" => {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "settings" => {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("open-settings", ());
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            pick_vrm_file,
            start_cursor_monitor,
            stop_cursor_monitor,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // Position window at bottom-right of screen
            {
                use tauri::PhysicalPosition;
                if let Some(monitor) = window.current_monitor().unwrap_or(None) {
                    let screen = monitor.size();
                    let win = window
                        .outer_size()
                        .unwrap_or(tauri::PhysicalSize::new(450, 600));
                    let x = screen.width.saturating_sub(win.width) as i32;
                    let y = screen.height.saturating_sub(win.height) as i32;
                    let _ = window.set_position(PhysicalPosition::new(x, y));
                }
            }

            setup_tray(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
