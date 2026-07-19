// Menu-bar (tray) desktop wrapper for Joule (Battery, Power & Charging Analyzer).
// On launch it: spawns the bundled `battery-life serve` sidecar (local web server),
// on first run asks (once) whether to enable auto-recording, and shows a tray icon
// with "뷰어 열기 / 기록 시작 / 기록 중지 / 앱 종료". Build: see TAURI.md. Tauri v2.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod live;
mod smc;
mod power;

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use std::process::Command as Sh;
use std::sync::{Arc, LazyLock, Mutex};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Instant;

// When the popover loses focus we hide it. A tray click on an already-open popover fires
// focus-loss (hide) BEFORE the click event, so remember when we last hid it and skip the
// re-show if that was just now — otherwise clicking the icon to close would reopen it.
static LAST_POPOVER_HIDE: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));
fn note_popover_hidden() { if let Ok(mut g) = LAST_POPOVER_HIDE.lock() { *g = Some(Instant::now()); } }
// Last tray-icon screen rect (physical px) so menu-triggered opens (설정 열기 / ⌥⌘B) can anchor
// under the icon too, not just left-clicks.
static LAST_ICON_RECT: LazyLock<Mutex<Option<(f64, f64, f64, f64)>>> = LazyLock::new(|| Mutex::new(None));
fn hidden_just_now() -> bool {
    LAST_POPOVER_HIDE.lock().ok().and_then(|g| *g).map_or(false, |t| t.elapsed().as_millis() < 300)
}
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

// macOS activation lifecycle: 0 = Accessory, 1 = waiting for Dock registration, 2 = Regular-ready.
// A popover/viewer is shown only in state 2, so its focus event updates Cmd+Tab's MRU ordering.
#[cfg(target_os = "macos")]
static APP_MODE: AtomicU8 = AtomicU8::new(0);

#[cfg(target_os = "macos")]
fn with_regular_app<F>(app: &AppHandle, action: F)
where
    F: FnOnce(AppHandle) + Send + 'static,
{
    if APP_MODE.load(Ordering::SeqCst) == 2 {
        action(app.clone());
        return;
    }
    if APP_MODE.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return; // another click is already waiting for the same promotion
    }
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        if APP_MODE.compare_exchange(1, 2, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return; // the UI was dismissed while Dock registration was pending
        }
        let h2 = h.clone();
        let _ = h.run_on_main_thread(move || action(h2));
    });
}

#[cfg(not(target_os = "macos"))]
fn with_regular_app<F>(app: &AppHandle, action: F)
where
    F: FnOnce(AppHandle) + Send + 'static,
{
    action(app.clone());
}

#[cfg(target_os = "macos")]
fn demote_if_no_visible_ui(app: &AppHandle) {
    let main_visible = app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false));
    let pop_visible = app.get_webview_window("popover").is_some_and(|w| w.is_visible().unwrap_or(false));
    if !main_visible && !pop_visible {
        // 승격 대기(1) 중엔 취소하지 않는다 — 팝오버가 승격 없이 뜨게 된 뒤(574675a), '3D 리포트'
        // 클릭 시 [팝오버 hide → 이 demote가 뷰어의 진행 중 승격을 0으로 리셋 → 300ms 뒤 CAS(1→2)
        // 실패 → show_main 액션 증발]로 뷰어가 안 열리는 레이스가 있었다. 취소는 완료 상태(2)만.
        if APP_MODE.compare_exchange(2, 0, Ordering::SeqCst, Ordering::SeqCst).is_ok()
            || APP_MODE.load(Ordering::SeqCst) == 0 {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn demote_if_no_visible_ui(_app: &AppHandle) {}

const LABEL: &str = "com.kdr.3d-battery-life.sampler";

fn home() -> PathBuf { PathBuf::from(std::env::var("HOME").unwrap_or_default()) }
fn plist_path() -> PathBuf { home().join("Library/LaunchAgents").join(format!("{LABEL}.plist")) }
fn data_dir() -> PathBuf { home().join("Library/Application Support/3d-battery-life") }

fn status_text(on: bool) -> &'static str {
    if on { "🟢 배터리 기록: 켜짐 (백그라운드 · 앱과 무관)" } else { "⚪ 배터리 기록: 꺼짐" }
}

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
    let script = "display dialog \"배터리 방전을 60초마다 자동 기록할까요?\n\n· 로그인 시 자동 시작, 백그라운드(거의 0% CPU)\n· 데이터는 이 맥에만 저장됩니다\n\n메뉴바 아이콘에서 언제든 켜고 끌 수 있어요.\" with title \"Joule\" buttons {\"나중에\", \"기록 켜기\"} default button \"기록 켜기\"";
    match Sh::new("osascript").args(["-e", script]).output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains("기록 켜기"),
        Err(_) => false,
    }
}

// Low Power Mode state (`pmset -g` → "lowpowermode  1"). Read on a slow cadence from the ticker —
// through the timeout runner, so a hung pmset can't block the ticker.
fn low_power_mode() -> bool {
    live::cmd_timeout("pmset", &["-g"], 1500).is_some_and(|out| {
        out.lines().any(|l| l.contains("lowpowermode") && l.split_whitespace().last() == Some("1"))
    })
}

// macOS notification via osascript (no plugin / entitlement). Quotes sanitized.
// FIRE-AND-FORGET on a detached thread: osascript can hang (TCC prompt / Notification Center,
// especially after the app moves to a new path), and it used to run synchronously ON THE TICKER
// THREAD — both observed tray freezes happened right at the ≤20% alert crossing. A hung notifier
// must never stall the tray.
fn notify(title: &str, body: &str) {
    let clean = |s: &str| s.replace('\\', "").replace('"', "'").replace(['\n', '\r'], " ");
    let script = format!(
        "display notification \"{}\" with title \"{}\" sound name \"Ping\"",
        clean(body), clean(title)
    );
    std::thread::spawn(move || { let _ = Sh::new("osascript").args(["-e", &script]).status(); });
}
// Low/high battery alerts (like Stats/iStat), with hysteresis so each crossing fires once.
// Long-form ETA for notification bodies, e.g. "1시간 20분" / "45분"; "" when unknown.
fn fmt_eta(min: Option<i64>) -> String {
    match min {
        Some(m) if m > 0 && m >= 60 => format!("{}시간 {}분", m / 60, m % 60),
        Some(m) if m > 0 => format!("{m}분"),
        _ => String::new(),
    }
}

// Read the SMC once, push into the rolling 60s window, and publish live-smc.json with BOTH the
// instantaneous values AND TIME-WEIGHTED 1-minute averages (∫W dt / span, trapezoidal) for the
// recorder. Called at ~0.5s cadence so the recorded 1-min average power captures every ~1Hz SMC
// update (2s used to undersample). Returns the latest instantaneous (sysW, adpW, batW/PPBR, temp).
fn sample_smc(
    smc: &Option<smc::Smc>,
    pwin: &mut Vec<(u64, f64, f64, f64)>,
    smc_seq: &mut u64,
    t0: &std::time::Instant,
) -> (Option<f64>, Option<f64>, Option<f64>, Option<f64>) {
    let s = match smc { Some(s) => s, None => return (None, None, None, None) };
    let sys_w = s.system_watts();
    let adp_w = s.adapter_watts();
    let bat_w = s.battery_watts();
    let temp = s.battery_temp_c();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let (Some(sw), Some(aw), Some(bw)) = (sys_w, adp_w, bat_w) { pwin.push((now, sw, aw, bw)); }
    pwin.retain(|(t, ..)| now.saturating_sub(*t) <= 60);
    // trapezoidal ∫W dt / span over the window — a true time-weighted 1-min mean (was a plain sum/n).
    let (mut asys, mut aadp, mut abat, mut span) = (0.0, 0.0, 0.0, 0.0);
    for w in pwin.windows(2) {
        let dt = w[1].0.saturating_sub(w[0].0) as f64;
        if dt <= 0.0 { continue; }
        asys += (w[0].1 + w[1].1) / 2.0 * dt;
        aadp += (w[0].2 + w[1].2) / 2.0 * dt;
        abat += (w[0].3 + w[1].3) / 2.0 * dt;
        span += dt;
    }
    let last = pwin.last().copied();
    let av_sys = if span > 0.0 { Some(asys / span) } else { last.map(|x| x.1) };
    let av_adp = if span > 0.0 { Some(aadp / span) } else { last.map(|x| x.2) };
    let av_bat = if span > 0.0 { Some(abat / span) } else { last.map(|x| x.3) };
    let f = |o: Option<f64>| o.map(|v| format!("{:.3}", v)).unwrap_or_else(|| "null".into());
    *smc_seq += 1;
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mono_ms = t0.elapsed().as_millis() as u64;
    let j = format!("{{\"tempC\":{},\"systemW\":{},\"adapterW\":{},\"batteryW\":{},\"systemWAvg\":{},\"adapterWAvg\":{},\"batteryWAvg\":{},\"dcInV\":{},\"dcInA\":{},\"at\":{},\"seq\":{},\"sampleAtMs\":{},\"monoMs\":{}}}",
        f(temp), f(sys_w), f(adp_w), f(bat_w), f(av_sys), f(av_adp), f(av_bat), f(s.dc_in_volts()), f(s.dc_in_amps()), now, *smc_seq, now_ms, mono_ms);
    let (tmp, fin) = (data_dir().join("live-smc.json.tmp"), data_dir().join("live-smc.json"));
    if std::fs::write(&tmp, j).is_ok() { let _ = std::fs::rename(&tmp, &fin); }
    (sys_w, adp_w, bat_w, temp)
}

fn notify_check(l: &live::Live, cfg: &live::Cfg, low: &mut bool, crit: &mut bool, high: &mut bool) {
    let pct = l.pct.round() as i64;
    let eta = fmt_eta(l.time_min);
    let low_t = cfg.low_pct as f64;    // 0 = off
    let high_t = cfg.high_pct as f64;  // 0 = off
    if l.discharging {
        *high = false;
        let left = if eta.is_empty() { String::new() } else { format!(" (약 {eta} 남음)") };
        // "매우 부족" is a hard floor at 10% (or the user's low threshold if they set it below 10).
        let crit_t = low_t.min(10.0);
        if low_t > 0.0 {
            if l.pct <= crit_t && !*crit { notify("배터리 매우 부족", &format!("{pct}% 남음{left} — 지금 충전하세요")); *crit = true; *low = true; }
            else if l.pct <= low_t && !*low { notify("배터리 부족", &format!("{pct}% 남음{left} — 곧 충전하세요")); *low = true; }
        }
        if l.pct > low_t + 5.0 { *low = false; *crit = false; }   // hysteresis: re-arm above threshold
    } else if l.charging {
        *low = false; *crit = false;
        let full = if eta.is_empty() { String::new() } else { format!(" (완충까지 약 {eta})") };
        if high_t > 0.0 && l.pct >= high_t && !*high { notify(&format!("충전 {}% 도달", high_t as i64), &format!("배터리 수명을 위해 뽑아도 좋아요{full}")); *high = true; }
        if l.pct < high_t - 5.0 { *high = false; }
    } else {
        // AC idle / full / on-hold — reset the LOW side (we're plugged) but keep HIGH sticky so
        // optimized-charging flapping between Charging↔AC-idle can't re-fire the high alert.
        *low = false; *crit = false;
        if l.pct < high_t - 5.0 { *high = false; }
    }
}

fn main() {
    // keep the serve sidecar's handle so quitting the app kills it (otherwise it's orphaned
    // and the next launch fails on the busy port)
    let sidecar: Arc<Mutex<Option<CommandChild>>> = Arc::new(Mutex::new(None));
    let sidecar_for_exit = sidecar.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(move |app| {
            // Menu-bar-only until a popover/viewer is requested. with_regular_app waits for Dock to
            // finish its async registration before showing and focusing that first window.
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            // 1) start the local server (bundled single binary) as a sidecar.
            // First reap any orphan from a previous run: RunEvent::Exit's kill is skipped on
            // SIGKILL/crash, and an orphaned server keeps port 4317 + stale measure state alive
            // (유령 측정 세션). BATTERY_SIDECAR=1 lets the server also self-exit when re-parented
            // to launchd (ppid 1); the pkill here covers servers too old to know that trick.
            let _ = Sh::new("/usr/bin/pkill").args(["-f", "battery-life serve"]).status();
            std::thread::sleep(std::time::Duration::from_millis(200));   // let the port release (server also retries EADDRINUSE)
            let cmd = app.shell().sidecar("battery-life").expect("sidecar 'battery-life' missing")
                .args(["serve"]).env("BATTERY_SIDECAR", "1");
            let (mut rx, child) = cmd.spawn().expect("failed to spawn battery-life serve");
            *sidecar.lock().unwrap() = Some(child);
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = rx.recv().await {
                    if let CommandEvent::Stdout(b) | CommandEvent::Stderr(b) = ev {
                        print!("{}", String::from_utf8_lossy(&b));
                    }
                }
            });

            // 1b) The "main" window is created from config and loads http://localhost:4317 immediately —
            // which RACES the sidecar above. If the web server hasn't bound the port yet, WKWebView gets
            // connection-refused and shows a blank white page that never retries (unlike Chrome's error
            // page + reload). So: wait until the server accepts a TCP connection, then (re)navigate the
            // main window to a guaranteed-live server. The window is hidden at this point, so the reload
            // is invisible; it just ensures content is there when the user first opens the viewer.
            let ready = app.handle().clone();
            std::thread::spawn(move || {
                for _ in 0..150 {
                    if std::net::TcpStream::connect("127.0.0.1:4317").is_ok() { break; }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                let h = ready.clone();
                let _ = ready.run_on_main_thread(move || {
                    if let Some(w) = h.get_webview_window("main") {
                        if let Ok(url) = "http://localhost:4317/".parse() { let _ = w.navigate(url); }
                    }
                });
            });

            // 2) tray menu (menu-bar item).
            // Recording (launchd) is INDEPENDENT of the app — quitting the app never stops it.
            let recording = plist_path().exists();
            let status = MenuItem::with_id(app, "status", status_text(recording), false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Joule 분석 리포트 열기", true, None::<&str>)?;
            // all display/menu-bar/alert settings now live in the popover's settings panel (gear)
            let settings_item = MenuItem::with_id(app, "settings", "설정 열기…", true, None::<&str>)?;
            // one recording item that toggles (was separate 시작/중지 — no need for both)
            let rec_item = MenuItem::with_id(app, "rec_toggle", if recording { "배터리 기록 중지" } else { "배터리 기록 시작" }, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "앱 종료 (기록은 계속됨)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&status, &open, &settings_item, &rec_item, &quit])?;
            let status_for_menu = status.clone();
            let rec_for_menu = rec_item.clone();
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Joule — Battery, Power & Charging Analyzer")
                .menu(&menu)
                .show_menu_on_left_click(false)   // left-click = popover; right-click = menu
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Down, rect, .. } = event {   // Down에 즉시(Stats처럼) — Up까지 기다리면 클릭 시간만큼 늦게 느껴짐
                        // rect is the icon's screen box in PHYSICAL px, top-left origin (tray-icon flips
                        // macOS' bottom-left coords for us). Position/Size are dpi enums → already the
                        // Physical variant here, so to_physical just casts (scale arg ignored).
                        let p = rect.position.to_physical::<f64>(1.0);
                        let sz = rect.size.to_physical::<f64>(1.0);
                        let anchor = (p.x, p.y, sz.width, sz.height);
                        if let Ok(mut g) = LAST_ICON_RECT.lock() { *g = Some(anchor); }
                        toggle_popover(tray.app_handle(), Some(anchor));
                    }
                })
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "settings" => open_popover(app, true),   // show the popover straight in its settings panel
                    "rec_toggle" => {
                        let turning_on = !plist_path().exists();   // toggle relative to the live launchd state
                        let _ = status_for_menu.set_text(status_text(turning_on));
                        let _ = rec_for_menu.set_text(if turning_on { "배터리 기록 중지" } else { "배터리 기록 시작" });
                        std::thread::spawn(move || run_record(if turning_on { "on" } else { "off" }));
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // 3) first-run consent — only if recording isn't set up and we haven't asked before.
            //    The marker is written AFTER the dialog resolves: writing it up-front meant a
            //    quit/crash while the dialog was open suppressed consent forever.
            let marker = data_dir().join(".consent-asked");
            if !plist_path().exists() && !marker.exists() {
                let status_for_consent = status.clone();
                let rec_for_consent = rec_item.clone();
                std::thread::spawn(move || {
                    let yes = ask_consent();
                    let _ = std::fs::create_dir_all(data_dir());
                    let _ = std::fs::write(&marker, if yes { "yes\n" } else { "later\n" });
                    if yes {
                        run_record("on");
                        let _ = status_for_consent.set_text(status_text(true));
                        let _ = rec_for_consent.set_text("배터리 기록 중지");   // keep the toggle in sync
                    }
                });
            }

            // 4) live tray title — a 2s ticker reads the battery natively and shows "87% · 5.2W" (or ⚡)
            //    next to the menu-bar icon, so the app earns its always-resident spot (Stats-parity).
            let handle = app.handle().clone();
            let rec_ticker = rec_item.clone();      // keep the tray recording label in sync from the ticker
            let status_ticker = status.clone();
            let rec0 = recording;
            std::thread::spawn(move || {
                let mut reader = live::Reader::new();
                let smc = smc::Smc::open();   // live temp/system-power (real-time; ioreg is 60s-quantized)
                if smc.is_some() { let _ = std::fs::create_dir_all(data_dir()); }   // so the bridge write can't silently fail
                power::start_notifier();      // wake instantly on AC plug/unplug (else just the 2s poll)
                let mut last_key = String::new();
                let mut last_pv_key = String::new();   // settings-panel preview dump key
                let (mut low, mut crit, mut high) = (false, false, false);
                let mut sc_on = false;   // whether the global ⌥⌃B is currently registered
                let (mut lpm, mut tick) = (low_power_mode(), 0u32);
                // slow-cadence system fact refreshed with lpm (~6s): macOS's displayed battery %
                // (the tray digits must match the system's own figure)
                let mut disp_pct = live::displayed_pct();
                let mut rec_state = rec0;
                let mut last_pop_h = 0.0f64;   // last height the popover reported (to size its window)
                let mut last_title = String::new();   // last native window title the viewer requested (i18n)
                let mut pwin: Vec<(u64, f64, f64, f64)> = Vec::new();   // rolling 60s (t, sysW, adpW, batW) → 1-min avg for the recorder
                // measurement sessions (lib/measure.js): seq lets the consumer dedupe samples, monoMs is
                // the monotonic clock its integrator uses for dt (wall-clock steps must not distort ∫W dt).
                // A process restart resets BOTH (seq=0, monoMs≈0) — the consumer treats that as a new baseline.
                let t0 = std::time::Instant::now();
                let mut smc_seq: u64 = 0;
                loop {
                    // A panic ANYWHERE in one tick must not kill this thread — a dead ticker freezes
                    // the tray at a stale % and stops the SMC bridge (popover loses PPBR/system power)
                    // until the app restarts. Catch per-tick, breadcrumb the payload, keep looping.
                    let tick_ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let mut l = reader.read();
                        let c = live::load_cfg();   // re-read each tick so menu AND popover-settings changes apply live
                        if tick % 3 == 0 { lpm = low_power_mode(); disp_pct = live::displayed_pct(); }   // refresh every ~6s
                        if l.ok { if let Some(p) = disp_pct { l.pct = p; } }   // starship's ratio % can sit 1–2% off macOS's shown %
                        tick = tick.wrapping_add(1);
                        // keep the tray recording label synced to the real launchd state (menu/popover/external)
                        let now_rec = plist_path().exists();
                        if now_rec != rec_state {
                            rec_state = now_rec;
                            let (r, st) = (rec_ticker.clone(), status_ticker.clone());
                            let _ = handle.run_on_main_thread(move || {
                                let _ = r.set_text(if now_rec { "배터리 기록 중지" } else { "배터리 기록 시작" });
                                let _ = st.set_text(status_text(now_rec));
                            });
                        }
                        if l.ok { notify_check(&l, &c, &mut low, &mut crit, &mut high); }
                        // register/unregister the global open-popover hotkey to match the setting (live)
                        if c.shortcut != sc_on {
                            use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                            let gs = handle.global_shortcut();
                            let hk = Shortcut::new(Some(Modifiers::ALT | Modifiers::CONTROL), Code::KeyB); // ⌥⌃B
                            if c.shortcut {
                                let _ = gs.on_shortcut(hk, |app, _s, ev| {
                                    // toggle: pressing it again (or ESC) closes the popover
                                    if ev.state() == ShortcutState::Pressed { toggle_popover(app, None); }
                                });
                            } else {
                                let _ = gs.unregister(hk);
                            }
                            sc_on = c.shortcut;
                        }
                        // Sample the SMC (also sampled at ~0.5s in the inner poll loop below): seeds the
                        // menu-bar W and the 60s window; publishes the bridge with time-weighted 1-min avgs.
                        let (sys_w, adp_smc, ppbr_smc, temp_smc) = sample_smc(&smc, &mut pwin, &mut smc_seq, &t0);
                        // battery W for the WIDGET/title — 혼합 method (viewer의 '혼합'): 방전 → SMC PPBR
                        // 실측(매 틱 갱신, 음수), 그 외 → 수지(어댑터−시스템, 충전 시 양수). ioreg 셀 실측
                        // (l.watts)은 ~60초 양자화라 SMC가 없을 때의 폴백으로만 쓴다.
                        let bat_disp: f64 = if l.discharging {
                            ppbr_smc.map(|w| -w.abs()).unwrap_or_else(|| live::signed_watts(&l))
                        } else {
                            match (adp_smc, sys_w) { (Some(a), Some(s)) => a - s, _ => live::signed_watts(&l) }
                        };
                        if let Some(tray) = handle.tray_by_id("tray") {
                            // menu-bar "W" = live system draw (SMC) when we have it, else battery-rail watts.
                            // tray_title composes the enabled 텍스트 chips itself (incl. skipping % when the
                            // glyph draws it) — the rules live in ONE place and the settings UI mirrors them.
                            let title = live::tray_title(&l, &c, sys_w.unwrap_or(l.watts), bat_disp, adp_smc, temp_smc);
                            // ALWAYS Some(…): set_title(None) leaves the previous text in place on
                            // macOS, so turning the last 텍스트 chip off left a zombie "9.8W" behind
                            // widget "wstack" draws a live power number → resolve it (sys plain, battery
                            // SIGNED +charge/−discharge per w7_src) and fold it (rounded) into the redraw key
                            let w7_bat = c.w7_battery();
                            let w7 = if w7_bat { bat_disp } else { sys_w.unwrap_or(l.watts) };
                            // both sources show one decimal → key at 0.1W so the glyph tracks it
                            let wkey = if c.widget != "wstack" { 0 } else { (w7 * 10.0).round() as i64 };
                            // redraw the glyph only when something visible changes (including bolt style)
                            let key = format!("{}-{}-{}-{}-{}-{}-{}-{}-{}-{}", l.pct.round() as i64, l.charging, l.full, c.colorize, c.widget, c.glyph_xl, lpm, c.digit_deco, c.bolt_style, wkey);
                            let icon_changed = l.ok && key != last_key;
                            if icon_changed { last_key = key.clone(); }
                            // 아이콘+타이틀을 ONE 메인스레드 작업으로 원자 갱신 — set_icon(18pt 리셋)→
                            // grow(23pt)→타이틀의 다단계 사이에 프레임이 끼며 항목이 '살짝 흔들리던' 문제 제거.
                            // 버튼 탐색 3회 연속 실패 시(비정상) 기존 tray API 폴백.
                            if ATTR_MISS.load(Ordering::Relaxed) < 3 {
                                let icon = if icon_changed {
                                    Some(live::menu_icon(&l, c.colorize, &c.widget, c.glyph_xl, lpm, c.digit_deco, w7, w7_bat, c.bolt_id(), c.chg_mode(), c.small_unit))
                                } else { None };   // None = 아이콘 유지 (타이틀만 갱신)
                                let t2 = title.clone();
                                let su = c.small_unit;
                                let _ = handle.run_on_main_thread(move || set_tray_visuals(icon, &t2, su));
                            } else {
                                // ALWAYS Some(…): set_title(None)은 이전 텍스트를 남긴다(좀비 "9.8W")
                                let _ = tray.set_title(Some(title.clone()));
                                if icon_changed {
                                    match live::menu_icon(&l, c.colorize, &c.widget, c.glyph_xl, lpm, c.digit_deco, w7, w7_bat, c.bolt_id(), c.chg_mode(), c.small_unit) {
                                        Some((rgba, w, h)) => { let _ = tray.set_icon(Some(tauri::image::Image::new_owned(rgba, w, h))); }
                                        None => { let _ = tray.set_icon(None); }   // text-only widget
                                    }
                                }
                                let _ = handle.run_on_main_thread(grow_menu_glyph);
                            }
                        }
                        // settings-panel preview bridge: dump the real glyph renders (all styles ×
                        // color/mono × normal/XL) when their inputs change (~every 1% of battery).
                        // cfg toggles need no re-dump — the popover picks the matching variant itself.
                        let pv_key = format!("{}-{}-{}-{}-{}-{}", l.pct.round() as i64, l.charging, l.full, lpm, c.chg_fill, c.small_unit);
                        if l.ok && pv_key != last_pv_key {
                            last_pv_key = pv_key;
                            live::write_preview(&data_dir(), &l, lpm, c.chg_mode(), c.small_unit);
                        }
                        // ~2s tray-redraw cadence, but SAMPLE THE SMC every ~0.5s (i%2==1 → +500/1000/1500/2000ms;
                        // combined with the tick-top sample = 0.5s) so the 60s window — and thus the recorded
                        // 1-min average power — captures every ~1Hz SMC update. Also poll popover actions each
                        // 250ms for fast response, and break early on a power-source change (plug/unplug).
                        for i in 0..8 {
                            std::thread::sleep(std::time::Duration::from_millis(250));
                            if i % 2 == 1 { let _ = sample_smc(&smc, &mut pwin, &mut smc_seq, &t0); }
                            let af = data_dir().join("action");
                            if let Ok(a) = std::fs::read_to_string(&af) {
                                let _ = std::fs::remove_file(&af);
                                match a.trim() {
                                    "report" => { let h = handle.clone(); let _ = handle.run_on_main_thread(move || { if let Some(w) = h.get_webview_window("popover") { let _ = w.hide(); } show_main(&h); }); }
                                    "quit" => { let h = handle.clone(); let _ = handle.run_on_main_thread(move || h.exit(0)); }
                                    "record" => { let on = !plist_path().exists(); std::thread::spawn(move || run_record(if on { "on" } else { "off" })); }
                                    "hide" => { let h = handle.clone(); let _ = handle.run_on_main_thread(move || { if let Some(w) = h.get_webview_window("popover") { let _ = w.hide(); } demote_if_no_visible_ui(&h); }); }
                                    _ => {}
                                }
                                break;   // re-read state promptly after acting
                            }
                            // viewer reported its native window title (localized) → set it. Tauri doesn't
                            // mirror document.title, and Tauri IPC is unreliable for this external-URL window,
                            // so it comes through the same file bridge as the height/actions.
                            if let Ok(tt) = std::fs::read_to_string(data_dir().join("main-title")) {
                                let tt = tt.trim().to_string();
                                if !tt.is_empty() && tt != last_title {
                                    last_title = tt.clone();
                                    let ht = handle.clone();
                                    let _ = handle.run_on_main_thread(move || {
                                        if let Some(w) = ht.get_webview_window("main") { let _ = w.set_title(&tt); }
                                    });
                                }
                            }
                            // popover reported its content height → size its window to fit exactly (no scrollbar)
                            if let Ok(h) = std::fs::read_to_string(data_dir().join("popover-h")).map(|s| s.trim().parse::<f64>()) {
                                if let Ok(h) = h {
                                    if (h - last_pop_h).abs() > 1.0 {
                                        last_pop_h = h;
                                        let hh = handle.clone();
                                        let _ = handle.run_on_main_thread(move || {
                                            if let Some(w) = hh.get_webview_window("popover") { let _ = w.set_size(tauri::LogicalSize::new(320.0, h)); }
                                        });
                                    }
                                }
                            }
                            if power::take_dirty() { break; }
                        }
                    }));
                    if let Err(e) = tick_ok {
                        let msg = e.downcast_ref::<&str>().map(|s| s.to_string())
                            .or_else(|| e.downcast_ref::<String>().cloned())
                            .unwrap_or_else(|| "non-string panic payload".into());
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                        let _ = std::fs::write(data_dir().join("ticker-panic.log"), format!("t={now} panic: {msg}\n"));
                        std::thread::sleep(std::time::Duration::from_secs(2));   // no hot spin if every tick panics
                    }
                }
            });

            // pre-warm the popover once the sidecar server is up (loads the page hidden), so the
            // first icon click just show()s an already-rendered window — near-instant, like Stats.
            let prewarm = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1800));
                let p2 = prewarm.clone();
                let _ = prewarm.run_on_main_thread(move || { let _ = ensure_popover(&p2); });
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // closing the viewer window must not quit the tray app — hide it instead
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    demote_if_no_visible_ui(window.app_handle());
                }
                // popover auto-hides when it loses focus (menu-bar popover convention)
                WindowEvent::Focused(false) if window.label() == "popover" => {
                    note_popover_hidden();   // so a tray click that caused this doesn't re-show it
                    let _ = window.hide();
                    demote_if_no_visible_ui(window.app_handle());
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app, event| {
        if let RunEvent::Exit = event {
            // covers menu quit AND Cmd+Q / logout: take the sidecar and kill it
            if let Some(child) = sidecar_for_exit.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}

fn show_main(app: &AppHandle) {
    with_regular_app(app, |app| show_main_ready(&app));
}

fn show_main_ready(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // 창은 시작 시점의 Space에 귀속돼, 다른 Desktop에서 열면 macOS가 그 Space로 '이동'해버린다
        // (kdr: 항상 Desktop 2에서 열림). MoveToActiveSpace(1<<1)를 켜서 창이 현재 Space로 따라오게.
        #[cfg(target_os = "macos")]
        if let Ok(ptr) = w.ns_window() {
            use objc::runtime::Object;
            use objc::{msg_send, sel, sel_impl};
            unsafe {
                let nsw = ptr as *mut Object;
                let cur: u64 = msg_send![nsw, collectionBehavior];
                let _: () = msg_send![nsw, setCollectionBehavior: cur | 2u64];
            }
        }
        let _ = w.unminimize();
        let _ = w.show();   // 포커스 없이 표시 — cmd+Tab 활성화는 아래 LaunchServices가 담당
        // cmd+Tab MRU 순서 (Apple 버그 FB7743313 우회 — 복원). 팝오버(574675a)로 앱이 이미 활성-Accessory
        // 인 상태에서 Regular로 승격하면, 앱이 스스로 하는 활성화(NSApp activate/activateWithOptions)는
        // Dock 전환기 MRU에 반영되지 않아 뷰어가 ⌘Tab 맨 오른쪽(오래된 순서)에 박힌다. Dock 아이콘 클릭/
        // Spotlight와 같은 경로인 **LaunchServices 활성화(`open -b <bundle id>`)** 로 시스템이 우리를
        // "밖에서" 활성화하게 하면 진짜 사용자 전환으로 기록돼 뷰어가 맨 앞(왼쪽)으로 온다. set_focus는 안전망.
        // (2026-07-13 89d2df8에서 도입·검증됐다가 574675a의 '팝오버 즉시표시'가 전제를 깨 무력화된 것을 복원.)
        // ⚠️ 자기 activate/deactivate 바운스(1·2차)는 그때도, 2026-07-19에도 실패 확인 — open -b만 통한다.
        #[cfg(target_os = "macos")]
        {
            let app2 = app.clone();
            std::thread::spawn(move || {
                let _ = Sh::new("/usr/bin/open").args(["-b", "com.kdr.battery-life"]).status();
                std::thread::sleep(std::time::Duration::from_millis(140));
                let app3 = app2.clone();
                let _ = app2.run_on_main_thread(move || {
                    if let Some(w) = app3.get_webview_window("main") { let _ = w.set_focus(); }
                });
            });
        }
        #[cfg(not(target_os = "macos"))]
        let _ = w.set_focus();
    }
}

// Round the popover's NATIVE window: making the webview background transparent (CSS) alone leaves a
// square opaque NSWindow behind the rounded body. Here we clip the content view's layer to a corner
// radius and clear the window background, so the window itself is a rounded, transparent card.
#[cfg(target_os = "macos")]
fn round_popover_window(w: &tauri::WebviewWindow) {
    use objc::runtime::{Object, NO, YES};
    use objc::{class, msg_send, sel, sel_impl};
    let Ok(ns_window) = w.ns_window() else { return };
    let ns_window = ns_window as *mut Object;
    unsafe {
        let _: () = msg_send![ns_window, setOpaque: NO];
        let clear: *mut Object = msg_send![class!(NSColor), clearColor];
        let _: () = msg_send![ns_window, setBackgroundColor: clear];
        let content_view: *mut Object = msg_send![ns_window, contentView];
        let _: () = msg_send![content_view, setWantsLayer: YES];
        let layer: *mut Object = msg_send![content_view, layer];
        let _: () = msg_send![layer, setCornerRadius: 34.0_f64];
        let _: () = msg_send![layer, setMasksToBounds: YES];
    }
}

// Grow the menu-bar glyph beyond tray-icon's hardcoded 18pt. tray-icon sizes the NSImage to
// 18pt on every set_icon, leaving the top ~4pt of the menu bar unused (Stats fills it). We can't
// reach Tauri's NSStatusItem (it's private), so we find our status button in the app's own window
// tree (NSStatusBarButton is a public class) and enlarge its image to `target_h` points, keeping
// aspect. Fully isolated: if the button isn't found the glyph just stays 18pt — the tray's
// click/menu behaviour is never touched. Must run on the main thread.
fn grow_menu_glyph() {
    use objc2_app_kit::{NSApplication, NSStatusBar, NSStatusBarButton, NSView};
    use objc2_foundation::{MainThreadMarker, NSSize};
    let Some(mtm) = MainThreadMarker::new() else { return };   // no-op off the main thread
    // Fill the ACTUAL menu-bar height (NSStatusBar thickness, ~24pt on modern Macs) rather than a
    // fixed 22 — that's the true maximum. A 1pt inset keeps the glyph off the very top/bottom edges.
    let target_h = (NSStatusBar::systemStatusBar().thickness() - 1.0).clamp(18.0, 30.0);
    // resize in place when the status button is reached → no need to own (retain) it
    fn resize(view: &NSView, target_h: f64) -> bool {
        if let Some(btn) = view.downcast_ref::<NSStatusBarButton>() {
            if let Some(img) = unsafe { btn.image() } {
                let sz = img.size();
                if sz.height > 1.0 && (sz.height - target_h).abs() > 0.5 {
                    img.setSize(NSSize::new(sz.width * target_h / sz.height, target_h));
                    unsafe { btn.setNeedsDisplay() };
                }
            }
            return true;
        }
        for sub in view.subviews().iter() { if resize(&sub, target_h) { return true; } }
        false
    }
    let app = NSApplication::sharedApplication(mtm);
    for win in app.windows().iter() {
        if let Some(cv) = win.contentView() { if resize(&cv, target_h) { return; } }
    }
}

// '단위 W 작게': 트레이 타이틀을 NSAttributedString으로 다시 그려 숫자 뒤의 W를 REAL 아래첨자
// (작은 폰트 + 음수 baselineOffset)로. Tauri set_title은 일반 문자열만 받으므로, 같은 트리 탐색으로
// NSStatusBarButton을 찾아 setAttributedTitle을 덧씌운다(매 틱 재적용 — set_title이 되돌려도 다음
// 틱에 복구). 버튼을 못 찾으면 일반 W 그대로 — 동작은 절대 깨지지 않는다. Must run on main thread.
static ATTR_MISS: AtomicU8 = AtomicU8::new(0);   // 버튼 탐색 연속 실패 수 — 3회면 ticker가 평문 폴백

// 트레이 아이콘+타이틀을 ONE 메인스레드 작업으로 원자적으로 갱신 — tray.set_icon(18pt로 리셋)
// → grow(23pt) → attributed title의 3단계 사이에 프레임이 끼면 아이콘 폭이 잠깐 좁아졌다 넓어져
// 항목 전체가 '살짝 흔들리는' 문제의 근본 해결. RGBA를 NSBitmapImageRep(비승산 알파)로 직접
// NSImage화해 처음부터 목표 크기(메뉴바 높이-1pt)로 세팅한다. icon: None=아이콘 유지,
// Some(None)=아이콘 제거(텍스트 전용), Some(Some(rgba,w,h))=교체.
fn set_tray_visuals(icon: Option<Option<(Vec<u8>, u32, u32)>>, title: &str, small_unit: bool) {
    use objc2::{AnyThread, Message};
    use objc2_app_kit::{NSApplication, NSStatusBar, NSStatusBarButton, NSView, NSBitmapImageRep, NSImage, NSDeviceRGBColorSpace, NSBitmapFormat};
    use objc2_foundation::{MainThreadMarker, NSSize};
    let Some(mtm) = MainThreadMarker::new() else { return };
    fn find_btn(view: &NSView) -> Option<objc2::rc::Retained<NSStatusBarButton>> {
        if let Some(btn) = view.downcast_ref::<NSStatusBarButton>() { return Some(btn.retain()); }
        for sub in view.subviews().iter() { if let Some(b) = find_btn(&sub) { return Some(b); } }
        None
    }
    let app = NSApplication::sharedApplication(mtm);
    let mut btn = None;
    for win in app.windows().iter() {
        if let Some(cv) = win.contentView() { if let Some(b) = find_btn(&cv) { btn = Some(b); break; } }
    }
    let Some(btn) = btn else {
        let _ = ATTR_MISS.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| Some(v.saturating_add(1)));
        return;
    };
    ATTR_MISS.store(0, Ordering::Relaxed);
    if let Some(icon) = icon {
        match icon {
            Some((rgba, w, h)) => unsafe {
                // 비승산(straight) 알파 RGBA → NSBitmapImageRep. planes=null이면 rep이 버퍼를 소유.
                let rep = NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel(
                    NSBitmapImageRep::alloc(), std::ptr::null_mut(), w as isize, h as isize,
                    8, 4, true, false, NSDeviceRGBColorSpace, NSBitmapFormat::AlphaNonpremultiplied,
                    (w * 4) as isize, 32);
                if let Some(rep) = rep {
                    let dst = rep.bitmapData();
                    if !dst.is_null() {
                        std::ptr::copy_nonoverlapping(rgba.as_ptr(), dst, rgba.len());
                        // 처음부터 목표 포인트 크기 — 18pt 중간 상태 없음
                        let target_h = (NSStatusBar::systemStatusBar().thickness() - 1.0).clamp(18.0, 30.0);
                        let size = NSSize::new(w as f64 * target_h / h as f64, target_h);
                        let img = NSImage::initWithSize(NSImage::alloc(), size);
                        img.addRepresentation(&rep);
                        btn.setImage(Some(&img));
                    }
                }
            },
            None => unsafe { btn.setImage(None); },   // 텍스트 전용 위젯
        }
    }
    apply_title_to_btn(&btn, title, small_unit);
    // tray-icon은 버튼 위에 '클릭 가로채기 오버레이'(TrayTarget subview)를 얹어 왼클릭=팝오버/
    // 우클릭=메뉴를 분기한다(메뉴는 status item에 상시 attach — 오버레이 밖 클릭은 macOS 기본
    // 동작이라 왼클릭에도 메뉴가 뜬다!). 원래는 tray.set_icon()이 내부에서 update_dimensions()로
    // 오버레이를 버튼 크기에 맞췄지만, 우리는 set_icon을 우회하므로 여기서 직접 맞춰준다
    // (upstream update_dimensions와 동일: overlay.setFrame(button.frame())).
    unsafe {
        let f = btn.frame();
        for sub in btn.subviews().iter() { sub.setFrame(f); }
    }
}

fn apply_title_to_btn(btn: &objc2_app_kit::NSStatusBarButton, title: &str, small_unit: bool) {
    use objc2_app_kit::{NSFont, NSFontAttributeName, NSBaselineOffsetAttributeName};
    use objc2_foundation::{NSMutableAttributedString, NSNumber, NSRange, NSString};
    // 숫자 바로 뒤의 'W'들의 UTF-16 위치 (타이틀은 BMP 문자뿐 → 1글자=1유닛).
    // W가 없거나 빈 문자열이어도 attributed로 항상 세팅 — 이 경로가 유일한 타이틀 쓰기
    // (평문 set_title과 이중 쓰기하면 폭이 다른 두 상태가 번갈아 렌더돼 깜빡였다).
    let mut ranges: Vec<usize> = Vec::new();
    if small_unit {
        let mut prev_digit = false;
        for (i, ch) in title.chars().enumerate() {
            if ch == 'W' && prev_digit { ranges.push(i); }
            prev_digit = ch.is_ascii_digit();
        }
    }
    unsafe {
        // 등폭 숫자(tabular figures) 시스템 폰트: 생김새는 메뉴바 기본과 동일, 숫자 폭만
        // 균일 — 값이 바뀔 때 항목 폭이 출렁이지 않는다 (시계·Stats와 같은 방식).
        let sz = btn.font().map(|f| f.pointSize()).unwrap_or_else(|| NSFont::menuBarFontOfSize(0.0).pointSize());
        let base = NSFont::monospacedDigitSystemFontOfSize_weight(sz, objc2_app_kit::NSFontWeightRegular);
        let attr = NSMutableAttributedString::from_nsstring(&NSString::from_str(title));
        let n = title.chars().count();
        if n > 0 {
            attr.addAttribute_value_range(NSFontAttributeName, &*base, NSRange::new(0, n));
            let small = NSFont::monospacedDigitSystemFontOfSize_weight((base.pointSize() * 0.62).max(7.0), objc2_app_kit::NSFontWeightRegular);
            let drop = NSNumber::new_f64(-(base.pointSize() * 0.10));   // 살짝 내려 붙는 아래첨자
            for at in ranges {
                let r = NSRange::new(at, 1);
                attr.addAttribute_value_range(NSFontAttributeName, &*small, r);
                attr.addAttribute_value_range(NSBaselineOffsetAttributeName, &*drop, r);
            }
        }
        btn.setAttributedTitle(&attr);
    }
}

// The popover: a small borderless window loading the node server's /popover.html (pure web,
// no Tauri commands → safe to load from localhost). Lazily created, then reused.
fn ensure_popover(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window("popover") { return Some(w); }
    let w = WebviewWindowBuilder::new(
        app,
        "popover",
        WebviewUrl::External("http://localhost:4317/popover.html".parse().unwrap()),
    )
    .title("배터리")
    .inner_size(320.0, 700.0)   // roomy fallback; popover.js fitWindow() trims it to content when it can
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .ok()?;
    #[cfg(target_os = "macos")]
    round_popover_window(&w);
    Some(w)
}

// Current on-screen rect of the tray icon (physical px) — so a shortcut/menu open (no click) still
// anchors the popover under the icon. Falls back to the last click rect, then place_popover's corner.
fn icon_anchor(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    if let Some(tray) = app.tray_by_id("tray") {
        if let Ok(Some(rect)) = tray.rect() {
            let p = rect.position.to_physical::<f64>(1.0);
            let sz = rect.size.to_physical::<f64>(1.0);
            return Some((p.x, p.y, sz.width, sz.height));
        }
    }
    LAST_ICON_RECT.lock().ok().and_then(|g| *g)
}

// Left-click a tray icon: toggle the popover, anchored under the clicked icon. A fresh show always
// lands on the dashboard (closeSettings), so re-opening never gets stuck in the settings panel.

// 팝오버용 초경량 활성화: Regular 승격(300ms Dock 등록 대기) 없이 앱만 활성화해 팝오버가
// key window가 되게 한다 — key가 아니면 바깥 클릭의 Focused(false)가 안 와 자동숨김이 죽는다.
#[cfg(target_os = "macos")]
fn activate_for_popover() {
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;
    if let Some(mtm) = MainThreadMarker::new() {
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    }
}
#[cfg(not(target_os = "macos"))]
fn activate_for_popover() {}

fn toggle_popover(app: &AppHandle, anchor: Option<(f64, f64, f64, f64)>) {
    if let Some(w) = app.get_webview_window("popover") {
        if w.is_visible().unwrap_or(false) { let _ = w.hide(); demote_if_no_visible_ui(app); return; }
        if hidden_just_now() { return; }   // this same click may have just hidden it via focus-loss
    }
    // Stats처럼 즉시 표시: with_regular_app(Accessory→Regular 승격 + 300ms 대기)을 팝오버엔 쓰지
    // 않는다 — 승격은 Cmd+Tab 순서 갱신용이라 transient 팝오버엔 불필요하고, 닫힐 때마다
    // Accessory로 내려가 매 클릭 300ms 지연을 만들었다. Accessory 앱도 set_focus(activate+makeKey)로
    // 키 윈도우가 되므로 포커스-이탈 자동 숨김은 그대로 동작한다.
    if let Some(w) = ensure_popover(app) {
        fit_popover(&w);
        place_popover(&w, anchor.or_else(|| icon_anchor(app)));
        let _ = w.eval("window.closeSettings&&closeSettings()");
        let _ = w.show();
        activate_for_popover();
        let _ = w.set_focus();
    }
}

// Size the popover to the height its web content last reported, so a fresh show is already
// fitted (no scrollbar, no square margin around the rounded/transparent body).
fn fit_popover(w: &tauri::WebviewWindow) {
    if let Ok(Ok(h)) = std::fs::read_to_string(data_dir().join("popover-h")).map(|s| s.trim().parse::<f64>()) {
        if (120.0..=2000.0).contains(&h) { let _ = w.set_size(tauri::LogicalSize::new(320.0, h)); }
    }
}

// Force-show the popover (menu "설정 열기" / global shortcut), anchored under the icon. `settings`
// opens it straight in the settings panel via the page's window.openSettings() hook — retried
// briefly in case the page is still loading.
fn open_popover(app: &AppHandle, settings: bool) {
    if let Some(w) = ensure_popover(app) {
        fit_popover(&w);
        place_popover(&w, icon_anchor(app));
        let _ = w.show();
        activate_for_popover();
        let _ = w.set_focus();
        let _ = w.eval(if settings {
            "(function r(n){if(window.openSettings){openSettings()}else if(n<40){setTimeout(function(){r(n+1)},50)}})(0)"
        } else {
            "window.closeSettings&&closeSettings()"
        });
    }
}

// Anchor the popover just below the clicked menu-bar icon, horizontally centered under it and
// clamped to that icon's monitor. `anchor` = the icon's screen rect in PHYSICAL px, top-left
// origin (exactly what the tray Click event gives). Everything here — anchor, monitor position/
// size, and the popover position — is in the same global physical coordinate space, so no
// scale-factor juggling between rails. Fallback (no anchor): menu-bar monitor's top-right corner.
fn place_popover(w: &tauri::WebviewWindow, anchor: Option<(f64, f64, f64, f64)>) {
    // Pick the monitor under the icon (multi-monitor safe), else the primary one.
    let mon = anchor
        .and_then(|(x, y, aw, ah)| {
            let (cx, cy) = (x + aw / 2.0, y + ah / 2.0);
            w.available_monitors().ok().and_then(|ms| {
                ms.into_iter().find(|m| {
                    let (p, s) = (m.position(), m.size());
                    let (l, t) = (p.x as f64, p.y as f64);
                    cx >= l && cx < l + s.width as f64 && cy >= t && cy < t + s.height as f64
                })
            })
        })
        .or_else(|| w.primary_monitor().ok().flatten());
    let Some(mon) = mon else { return; };
    let sf = mon.scale_factor();
    let (ml, mt, mw) = (mon.position().x as f64, mon.position().y as f64, mon.size().width as f64);
    let pop_w = 320.0 * sf;          // logical inner width → physical
    let gap = 6.0 * sf;
    let (x, y) = match anchor {
        Some((ax, ay, aw, ah)) => {
            let center = ax + aw / 2.0;
            let lo = ml + gap;
            let hi = (ml + mw - pop_w - gap).max(lo);   // never let hi < lo on a very narrow display
            ((center - pop_w / 2.0).clamp(lo, hi), ay + ah + 2.0 * sf)
        }
        None => ((ml + mw - pop_w - gap).max(ml + gap), mt + 32.0 * sf),
    };
    let _ = w.set_position(PhysicalPosition::new(x, y));
}
