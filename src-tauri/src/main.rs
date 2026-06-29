// Menu-bar (tray) desktop wrapper for 3D Battery Life.
// On launch it spawns the bundled `battery-life serve` sidecar (the local web server),
// shows a tray icon, and reveals a window pointing at the local viewer when clicked.
// NOTE: scaffold — needs the Rust/Tauri toolchain to build (see TAURI.md). APIs target Tauri v2.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 1) start the local server (bundled single binary) as a sidecar
            let cmd = app.shell().sidecar("battery-life").expect("sidecar 'battery-life' missing").args(["serve"]);
            let (mut rx, _child) = cmd.spawn().expect("failed to spawn battery-life serve");
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = rx.recv().await {
                    match ev {
                        CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => print!("{}", String::from_utf8_lossy(&b)),
                        _ => {}
                    }
                }
            });

            // 2) tray menu (menu-bar item)
            let open = MenuItem::with_id(app, "open", "뷰어 열기", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("3D Battery Life")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
