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
    #[serde(default = "d_true")] pub shortcut: bool, // register a global ⌥⌃B to open the popover (default on)
}
fn d_info() -> u8 { 4 }
fn d_true() -> bool { true }
fn d_low() -> u8 { 20 }
fn d_high() -> u8 { 80 }
fn d_widget() -> String { "icon".into() }
impl Default for Cfg {
    fn default() -> Self { Cfg { info: 4, colorize: true, low_pct: 20, high_pct: 80, widget: "icon".into(), glyph_xl: false, shortcut: true } }
}
pub fn cfg_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join("Library/Application Support/3d-battery-life/tray.json")
}
// The popover's settings panel writes tray.json (via the node server's /api/config); the tray
// menu no longer mutates it, so we only ever READ it here.
pub fn load_cfg() -> Cfg {
    let mut c: Cfg = std::fs::read_to_string(cfg_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if c.info > 5 { c.info = 4; }   // clamp the menu-bar text mode to a valid variant
    c
}
fn time_str(l: &Live) -> String {
    match l.time_min {
        Some(m) if m > 0 => format!("{}:{:02}", m / 60, m % 60),
        _ => "–".into(),
    }
}

// Level → fill color (shared by the icon + bar glyphs). Low Power Mode → yellow, like macOS' own
// battery icon (overrides level). Else: red <20% always, amber <40% / green, teal while
// charging/full; monochrome gray when colorize is off.
fn fill_color(l: &Live, colorize: bool, lpm: bool) -> (u8, u8, u8, u8) {
    if lpm { return (255, 204, 10, 255); }   // macOS systemYellow — the LPM signal
    let pct = l.pct.clamp(0.0, 100.0);
    if pct <= 20.0 { (229, 72, 77, 255) }
    else if !colorize { (170, 176, 188, 255) }
    else if l.charging || l.full { (77, 208, 192, 255) }
    else if pct <= 40.0 { (232, 133, 12, 255) }
    else { (74, 200, 120, 255) }
}

// Which menu-bar glyph to draw: "text" → None (title only), "bar" → vertical bar,
// "iconpct" → battery outline with the % number inside (one compact slot), else the battery.
pub fn menu_icon(l: &Live, colorize: bool, widget: &str, xl: bool, lpm: bool) -> Option<(Vec<u8>, u32, u32)> {
    match widget {
        "text" => None,
        "bar" => Some(bar_glyph(l, colorize, lpm)),
        "iconpct" => Some(battery_pct_icon(l, colorize, lpm)),
        _ => Some(battery_icon(l, colorize, xl, lpm)),
    }
}

// 3×5 pixel font for 0-9 (each row's low 3 bits, MSB = leftmost pixel).
const DIGITS: [[u8; 5]; 10] = [
    [7, 5, 5, 5, 7], [2, 6, 2, 2, 7], [7, 1, 7, 4, 7], [7, 1, 7, 1, 7], [5, 5, 7, 1, 1],
    [7, 4, 7, 1, 7], [7, 4, 7, 5, 7], [7, 1, 2, 2, 2], [7, 5, 7, 5, 7], [7, 5, 7, 1, 7],
];

// Battery outline with the % number inside, digits colored by state (macOS "show percentage in
// icon" style). Compact: the number lives in the icon, so no separate title text is needed.
pub fn battery_pct_icon(l: &Live, colorize: bool, lpm: bool) -> (Vec<u8>, u32, u32) {
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
    let outline = (170u8, 176u8, 188u8, 255u8);
    let ink = fill_color(l, colorize, lpm);   // number colored by level / LPM
    // thin battery outline + cap
    let (bx0, by0, bx1, by1) = (1i32, 2i32, 33i32, 18i32);
    rect(&mut buf, bx0, by0, bx1, by0 + 1, outline);
    rect(&mut buf, bx0, by1 - 1, bx1, by1, outline);
    rect(&mut buf, bx0, by0, bx0 + 1, by1, outline);
    rect(&mut buf, bx1 - 1, by0, bx1, by1, outline);
    rect(&mut buf, bx1, 7, bx1 + 3, 13, outline);
    // left indicator so iconpct still shows charge state: bolt (charging) / plug (full).
    let ind_w = if l.charging || l.full { 8i32 } else { 0 };
    if l.charging {
        for &(x, y) in &[(6, 4), (5, 5), (5, 6), (4, 7), (7, 8), (6, 9), (6, 10), (5, 11)] { px(&mut buf, x, y, ink); }
        rect(&mut buf, 4, 7, 8, 8, ink);                       // crossbar → lightning
    } else if l.full {
        for &(x, y) in &[(4, 4), (4, 5), (6, 4), (6, 5)] { px(&mut buf, x, y, ink); }   // prongs
        rect(&mut buf, 3, 6, 8, 10, ink);                                              // plug body
        for y in 10..13 { px(&mut buf, 5, y, ink); }                                    // cord
    }
    // % digits, 2× scale, centered in the space to the right of the indicator
    let digits: Vec<u8> = (l.pct.clamp(0.0, 100.0).round() as u32).to_string().bytes().map(|b| b - b'0').collect();
    let (scale, gap) = (2i32, 1i32);
    let dw = 3 * scale + gap;
    let total = digits.len() as i32 * dw - gap;
    let (dl, dr) = (bx0 + 1 + ind_w, bx1 - 1);
    let mut x = (dl + dr) / 2 - total / 2;
    let y0 = (h as i32 - 5 * scale) / 2;
    for &d in &digits {
        let g = DIGITS[d as usize % 10];
        for (row, bits) in g.iter().enumerate() {
            for col in 0..3i32 {
                if bits & (1 << (2 - col)) != 0 {
                    rect(&mut buf, x + col * scale, y0 + row as i32 * scale, x + col * scale + scale, y0 + row as i32 * scale + scale, ink);
                }
            }
        }
        x += dw;
    }
    (buf, w, h)
}

// ---- menu-bar battery GLYPH (like Stats): a battery outline filling proportional to charge,
// teal + bolt while charging, plug while plugged-and-holding. `xl` shrinks the vertical margin so
// the body fills more of the canvas — since macOS scales the tray image to the menu-bar height,
// that renders the glyph visibly larger. Returns raw RGBA + dims.
pub fn battery_icon(l: &Live, colorize: bool, xl: bool, lpm: bool) -> (Vec<u8>, u32, u32) {
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
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = fill_color(l, colorize, lpm);

    // body outline (2px). XL uses a smaller vertical margin so the body is taller.
    let m = if xl { 1i32 } else { 3 };
    let (bx0, by0, bx1, by1) = (1i32, m, 33i32, h as i32 - m);
    rect(&mut buf, bx0, by0, bx1, by0 + 2, outline);         // top
    rect(&mut buf, bx0, by1 - 2, bx1, by1, outline);         // bottom
    rect(&mut buf, bx0, by0, bx0 + 2, by1, outline);         // left
    rect(&mut buf, bx1 - 2, by0, bx1, by1, outline);         // right
    rect(&mut buf, bx1, 7, bx1 + 3, 13, outline);            // nub cap (vertically centered)

    // inner fill proportional to %
    let (ix0, iy0, ix1, iy1) = (bx0 + 3, by0 + 3, bx1 - 3, by1 - 3);
    let full_w = (ix1 - ix0) as f64;
    let fw = (full_w * pct / 100.0).round() as i32;
    rect(&mut buf, ix0, iy0, ix0 + fw.max(1), iy1, fill);

    // charging bolt / plug (dark, over the fill), roughly centered in the body
    if l.charging {
        let bolt = (20u8, 24u8, 30u8, 255u8);
        for &(x, y) in &[(18, 6), (17, 7), (16, 8), (18, 8), (17, 9), (16, 10), (15, 11), (18, 10), (19, 9), (20, 8)] {
            px(&mut buf, x, y, bolt); px(&mut buf, x, y + 1, bolt);
        }
    } else if l.full {
        let plug = (20u8, 24u8, 30u8, 255u8);
        for &(x, y) in &[(15, 6), (15, 7), (18, 6), (18, 7)] { px(&mut buf, x, y, plug); } // prongs
        rect(&mut buf, 14, 8, 20, 12, plug);                                               // body
        for y in 12..15 { px(&mut buf, 16, y, plug); px(&mut buf, 17, y, plug); }           // cord
    }
    (buf, w, h)
}

// ---- vertical bar glyph (Stats' "bar_chart"): a thin upright cell filling from the bottom.
pub fn bar_glyph(l: &Live, colorize: bool, lpm: bool) -> (Vec<u8>, u32, u32) {
    let (w, h) = (14u32, 20u32);
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let px = |buf: &mut Vec<u8>, x: i32, y: i32, c: (u8, u8, u8, u8)| {
        if x < 0 || y < 0 || x as u32 >= w || y as u32 >= h { return; }
        let i = ((y as u32 * w + x as u32) * 4) as usize;
        buf[i] = c.0; buf[i + 1] = c.1; buf[i + 2] = c.2; buf[i + 3] = c.3;
    };
    let rect = |buf: &mut Vec<u8>, x0: i32, y0: i32, x1: i32, y1: i32, c: (u8, u8, u8, u8)| {
        for y in y0..y1 { for x in x0..x1 { px(buf, x, y, c); } }
    };
    let outline = (170u8, 176u8, 188u8, 255u8);
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = fill_color(l, colorize, lpm);
    let (bx0, by0, bx1, by1) = (3i32, 1i32, 11i32, 19i32);   // upright cell
    rect(&mut buf, bx0, by0, bx1, by0 + 2, outline);
    rect(&mut buf, bx0, by1 - 2, bx1, by1, outline);
    rect(&mut buf, bx0, by0, bx0 + 2, by1, outline);
    rect(&mut buf, bx1 - 2, by0, bx1, by1, outline);
    rect(&mut buf, bx0 + 2, by0 - 2, bx1 - 2, by0, outline); // top terminal
    // fill from the bottom
    let (ix0, ix1) = (bx0 + 2, bx1 - 2);
    let inner_top = by0 + 2;
    let inner_bot = by1 - 2;
    let fh = ((inner_bot - inner_top) as f64 * pct / 100.0).round() as i32;
    rect(&mut buf, ix0, inner_bot - fh.max(1), ix1, inner_bot, fill);
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
