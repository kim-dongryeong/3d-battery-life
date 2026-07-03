// Native live battery read for the menu-bar tray title (Stats-parity live glance).
// Uses `starship-battery` (IOKit under the hood, ~0.4ms) so the 2s ticker never spawns a subprocess.
// The rich popover reads the node server's /api/live (fresh ioreg sample) instead — this module only
// needs enough for the tray title: level %, power (W), and charge state.
use starship_battery::units::{
    electric_potential::volt, energy::watt_hour, power::watt, ratio::percent,
    thermodynamic_temperature::degree_celsius, time::second,
};
use starship_battery::{Manager, State};

#[derive(Clone, Default, serde::Serialize)]
pub struct Live {
    pub ok: bool,
    pub pct: f64,          // 0..100
    pub watts: f64,        // |energy_rate| magnitude
    pub charging: bool,
    pub discharging: bool,
    pub full: bool,
    pub volts: f64,
    pub temp_c: Option<f64>,
    pub cycles: Option<u32>,
    pub health_pct: Option<f64>,
    pub time_min: Option<i64>, // to-empty (discharging) or to-full (charging)
    pub state: String,         // 충전 / 방전 / 완충 / AC
}

// A reusable reader — hold the Manager + Battery across ticks and just refresh().
// Everything is fallible (no panics): this runs on a detached ticker thread, so a panic here
// would freeze the tray title forever. On any failure it returns Live::default() and retries next tick.
pub struct Reader {
    manager: Option<Manager>,
    battery: Option<starship_battery::Battery>,
}

impl Reader {
    pub fn new() -> Self {
        let manager = Manager::new().ok();
        let battery = manager
            .as_ref()
            .and_then(|m| m.batteries().ok().and_then(|mut it| it.next().and_then(Result::ok)));
        Reader { manager, battery }
    }

    pub fn read(&mut self) -> Live {
        if self.manager.is_none() {
            self.manager = Manager::new().ok();
        }
        let Some(manager) = self.manager.as_ref() else { return Live::default() };
        if self.battery.is_none() {
            self.battery = manager.batteries().ok().and_then(|mut it| it.next().and_then(Result::ok));
        }
        let Some(b) = self.battery.as_mut() else { return Live::default() };
        if manager.refresh(b).is_err() {
            self.battery = None;
            return Live::default();
        }
        let st = b.state();
        let charging = st == State::Charging;
        let discharging = st == State::Discharging;
        let full = st == State::Full;
        let full_wh = b.energy_full().get::<watt_hour>() as f64;
        let design_wh = b.energy_full_design().get::<watt_hour>() as f64;
        let health = if design_wh > 0.0 { Some((full_wh / design_wh * 100.0 * 10.0).round() / 10.0) } else { None };
        // only a meaningful time while actively charging/discharging (full/AC-idle → no countdown)
        let secs = if charging { b.time_to_full().map(|t| t.get::<second>() as f64) }
            else if discharging { b.time_to_empty().map(|t| t.get::<second>() as f64) }
            else { None };
        Live {
            ok: true,
            pct: (b.state_of_charge().get::<percent>() as f64 * 10.0).round() / 10.0,
            watts: (b.energy_rate().get::<watt>() as f64).abs(),
            charging,
            discharging,
            full,
            volts: (b.voltage().get::<volt>() as f64 * 100.0).round() / 100.0,
            temp_c: b.temperature().map(|t| (t.get::<degree_celsius>() as f64 * 10.0).round() / 10.0),
            cycles: b.cycle_count(),
            health_pct: health,
            time_min: secs.map(|s| (s / 60.0).round() as i64).filter(|&m| m > 0),
            state: if charging { "충전".into() } else if full { "완충".into() } else if discharging { "방전".into() } else { "AC".into() },
        }
    }
}

// ---- menu-bar display settings (persisted; changed from the tray menu) ----
// The persisted settings, shared by the menu-bar (Rust) and the popover settings panel
// (which reads/writes them through the node server's /api/config → the same tray.json).
// Every field has a #[serde(default)] so a partial or older JSON still deserializes.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Cfg {
    #[serde(default = "d_info")] pub info: u8,      // title next to icon: 0 icon-only · 1 % · 2 time · 3 W · 4 %+W · 5 %+time
    #[serde(default = "d_true")] pub colorize: bool,// color the glyph fill by level (else monochrome except red <20%)
    #[serde(default = "d_low")] pub low_pct: u8,    // discharge warning at ≤ this % (0 = off)
    #[serde(default = "d_high")] pub high_pct: u8,  // charge-complete alert at ≥ this % (0 = off)
    #[serde(default = "d_widget")] pub widget: String, // menu-bar widget: "icon" | "bar" | "text"
    #[serde(default)] pub glyph_xl: bool,           // draw the glyph at a larger body size
    #[serde(default)] pub shortcut: bool,           // register a global ⌥⌘B to open the popover
}
fn d_info() -> u8 { 4 }
fn d_true() -> bool { true }
fn d_low() -> u8 { 20 }
fn d_high() -> u8 { 80 }
fn d_widget() -> String { "icon".into() }
impl Default for Cfg {
    fn default() -> Self { Cfg { info: 4, colorize: true, low_pct: 20, high_pct: 80, widget: "icon".into(), glyph_xl: false, shortcut: false } }
}
// Preset steps the tray menu cycles through (last = 0 = off).
pub const LOW_STEPS: [u8; 6] = [10, 15, 20, 25, 30, 0];
pub const HIGH_STEPS: [u8; 7] = [70, 75, 80, 85, 90, 100, 0];
pub fn next_step(steps: &[u8], cur: u8) -> u8 {
    let i = steps.iter().position(|&v| v == cur).unwrap_or(steps.len() - 1);
    steps[(i + 1) % steps.len()]
}
pub fn alert_label(prefix: &str, v: u8) -> String {
    if v == 0 { format!("{prefix}: 끄기") } else { format!("{prefix}: {v}%") }
}
pub fn cfg_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join("Library/Application Support/3d-battery-life/tray.json")
}
pub fn load_cfg() -> Cfg {
    let mut c: Cfg = std::fs::read_to_string(cfg_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if c.info > 5 { c.info = 4; }   // clamp so `(info + 1) % 6` never overflows u8
    c
}
pub fn save_cfg(c: &Cfg) {
    if let Ok(s) = serde_json::to_string(c) {
        let _ = std::fs::create_dir_all(cfg_path().parent().unwrap());
        let _ = std::fs::write(cfg_path(), s);
    }
}
pub const INFO_LABELS: [&str; 6] = ["아이콘만", "퍼센트", "남은 시간", "전력(W)", "퍼센트+전력", "퍼센트+시간"];

fn time_str(l: &Live) -> String {
    match l.time_min {
        Some(m) if m > 0 => format!("{}:{:02}", m / 60, m % 60),
        _ => "–".into(),
    }
}

// ---- menu-bar battery GLYPH (like Stats): a battery outline filling proportional to charge,
// colored by level (red <20% / orange <40% / green), teal + bolt while charging. Returns raw
// RGBA + dims; main.rs wraps it in tauri::image::Image and calls tray.set_icon().
pub fn battery_icon(l: &Live, colorize: bool) -> (Vec<u8>, u32, u32) {
    let (w, h) = (40u32, 20u32);
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let px = |buf: &mut Vec<u8>, x: i32, y: i32, c: (u8, u8, u8, u8)| {
        if x < 0 || y < 0 || x as u32 >= w || y as u32 >= h { return; }
        let i = ((y as u32 * w + x as u32) * 4) as usize;
        buf[i] = c.0; buf[i + 1] = c.1; buf[i + 2] = c.2; buf[i + 3] = c.3;
    };
    let rect = |buf: &mut Vec<u8>, x0: i32, y0: i32, x1: i32, y1: i32, c: (u8, u8, u8, u8)| {
        for y in y0..y1 { for x in x0..x1 { px(buf, x, y, c); } }
    };
    let outline = (170u8, 176u8, 188u8, 255u8); // mid-gray: readable on light & dark menu bars
    let mono = (170u8, 176u8, 188u8, 255u8);
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = if pct <= 20.0 { (229, 72, 77, 255) }   // red <20% regardless (Stats behavior)
        else if !colorize { mono }
        else if l.charging || l.full { (77, 208, 192, 255) }
        else if pct <= 40.0 { (232, 133, 12, 255) }
        else { (74, 200, 120, 255) };

    // body outline (2px) from (1,3) to (33,17); nub cap at right
    let (bx0, by0, bx1, by1) = (1i32, 3i32, 33i32, 17i32);
    rect(&mut buf, bx0, by0, bx1, by0 + 2, outline);         // top
    rect(&mut buf, bx0, by1 - 2, bx1, by1, outline);         // bottom
    rect(&mut buf, bx0, by0, bx0 + 2, by1, outline);         // left
    rect(&mut buf, bx1 - 2, by0, bx1, by1, outline);         // right
    rect(&mut buf, bx1, 7, bx1 + 3, 13, outline);            // cap

    // inner fill proportional to %
    let (ix0, iy0, ix1, iy1) = (bx0 + 3, by0 + 3, bx1 - 3, by1 - 3);
    let full_w = (ix1 - ix0) as f64;
    let fw = (full_w * pct / 100.0).round() as i32;
    rect(&mut buf, ix0, iy0, ix0 + fw.max(1), iy1, fill);

    // charging bolt (dark, over the fill) — a tiny lightning
    if l.charging {
        let bolt = (20u8, 24u8, 30u8, 255u8);
        for &(x, y) in &[(18, 6), (17, 7), (16, 8), (18, 8), (17, 9), (16, 10), (15, 11), (18, 10), (19, 9), (20, 8)] {
            px(&mut buf, x, y, bolt); px(&mut buf, x, y + 1, bolt);
        }
    } else if l.full {
        // plugged-but-done: a tiny power-plug (two prongs + body) — like Stats, so the glyph
        // distinguishes "plugged & holding" from "on battery" (which draws nothing).
        let plug = (20u8, 24u8, 30u8, 255u8);
        for &(x, y) in &[(15, 6), (15, 7), (18, 6), (18, 7)] { px(&mut buf, x, y, plug); } // prongs
        rect(&mut buf, 14, 8, 20, 12, plug);                                               // body
        for y in 12..15 { px(&mut buf, 16, y, plug); px(&mut buf, 17, y, plug); }           // cord
    }
    (buf, w, h)
}

// The compact tray-title text macOS shows next to the icon (per the chosen info mode).
// `watts` is the figure to show in the W modes — the ticker passes live SMC system power
// (the real draw) when available, falling back to the battery-rail watts (0 while plugged/holding).
pub fn tray_title(l: &Live, info: u8, watts: f64) -> String {
    if !l.ok {
        return String::new();
    }
    let pct = l.pct.round() as i64;
    match info {
        0 => String::new(),                                   // icon only
        1 => format!("{pct}%"),
        2 => time_str(l),
        3 => format!("{watts:.1}W"),
        5 => format!("{pct}% · {}", time_str(l)),
        _ => format!("{pct}% · {watts:.1}W"),                 // 4 = %+W (default)
    }
}
