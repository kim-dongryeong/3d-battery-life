// Menu-bar (tray) desktop wrapper for 3D Battery Life.
// On launch it: spawns the bundled `battery-life serve` sidecar (local web server),
// on first run asks (once) whether to enable auto-recording, and shows a tray icon
// with "뷰어 열기 / 기록 시작 / 기록 중지 / 종료". Build: see TAURI.md. Tauri v2.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Command as Sh;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const LABEL: &str = "com.kdr.3d-battery-life.sampler";

fn home() -> PathBuf { PathBuf::from(std::env::var("HOME").unwrap_or_default()) }
fn plist_path() -> PathBuf { home().join("Library/LaunchAgents").join(format!("{LABEL}.plist")) }
fn data_dir() -> PathBuf { home().join("Library/Application Support/3d-battery-life") }

// The sidecar binary sits next to this executable inside the .app (Contents/MacOS/battery-life).
fn sidecar_bin() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|d| d.join("battery-life"))
}
// Run `battery-life record <sub>` (on|off|status) — sets up / tears down the launchd sampler.
fn run_record(sub: &'static str) {
    if let Some(bin) = sidecar_bin() {
        let _ = Sh::new(bin).args(["record", sub]).status();
    }
}

// First-run consent via a native macOS dialog (osascript — no extra plugin/permission needed).
fn ask_consent() -> bool {
    let script = "display dialog \"배터리 방전을 60초마다 자동 기록할까요?\n\n· 로그인 시 자동 시작, 백그라운드(거의 0% CPU)\n· 데이터는 이 맥에만 저장됩니다\n\n메뉴바 아이콘에서 언제든 켜고 끌 수 있어요.\" with title \"3D Battery Life\" buttons {\"나중에\", \"기록 켜기\"} default button \"기록 켜기\"";
    match Sh::new("osascript").args(["-e", script]).output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains("기록 켜기"),
        Err(_) => false,
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 1) start the local server (bundled single binary) as a sidecar
            let cmd = app.shell().sidecar("battery-life").expect("sidecar 'battery-life' missing").args(["serve"]);
            let (mut rx, _child) = cmd.spawn().expect("failed to spawn battery-life serve");
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = rx.recv().await {
                    if let CommandEvent::Stdout(b) | CommandEvent::Stderr(b) = ev {
                        print!("{}", String::from_utf8_lossy(&b));
                    }
                }
            });

            // 2) first-run consent (only if recording isn't set up yet and we haven't asked before).
            //    Runs off-thread so the tray/window appear immediately; the dialog pops right after.
            let marker = data_dir().join(".consent-asked");
            if !plist_path().exists() && !marker.exists() {
                let _ = std::fs::create_dir_all(data_dir());
                let _ = std::fs::write(&marker, "asked\n");
                std::thread::spawn(|| { if ask_consent() { run_record("on"); } });
            }

            // 3) tray menu (menu-bar item)
            let open = MenuItem::with_id(app, "open", "뷰어 열기", true, None::<&str>)?;
            let rec_on = MenuItem::with_id(app, "rec_on", "배터리 기록 시작", true, None::<&str>)?;
            let rec_off = MenuItem::with_id(app, "rec_off", "배터리 기록 중지", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &rec_on, &rec_off, &quit])?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("3D Battery Life")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "rec_on" => { std::thread::spawn(|| run_record("on")); }
                    "rec_off" => { std::thread::spawn(|| run_record("off")); }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
