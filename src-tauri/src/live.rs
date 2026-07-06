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
    #[serde(default = "d_info")] pub info: u8,      // LEGACY title enum (0–7) — superseded by text_*; kept so old tray.json still works
    #[serde(default = "d_true")] pub colorize: bool,// color the glyph fill by level (else monochrome except red <20%)
    #[serde(default = "d_low")] pub low_pct: u8,    // discharge warning at ≤ this % (0 = off)
    #[serde(default = "d_high")] pub high_pct: u8,  // charge-complete alert at ≥ this % (0 = off)
    #[serde(default = "d_widget")] pub widget: String, // menu-bar widget: "icon" | "iconpct" | "combo" | "stack" | "bar" | "text"
    #[serde(default)] pub glyph_xl: bool,           // draw the glyph at a larger body size ("icon" style only)
    #[serde(default = "d_true")] pub shortcut: bool, // register a global ⌥⌃B to open the popover (default on)
    // independent title items (the popover's 텍스트 chips). None = file predates the chips UI →
    // fall back to the legacy `info` enum (see title_items) so old configs keep their meaning.
    #[serde(default)] pub text_pct: Option<bool>,   // append "67%"
    #[serde(default)] pub text_time: Option<bool>,  // append "5:12" (time to empty/full, when known)
    #[serde(default)] pub text_w: Option<bool>,     // append "7.4W"
    #[serde(default)] pub w_src: Option<String>,    // which W: "sys" (SMC system draw) | "bat" (battery rail)
}

impl Cfg {
    // Effective title items as (pct, time, w, w_is_battery). New keys win; old files map the
    // legacy 표시 텍스트 enum: 0 none · 1 % · 2 time · 3 sysW · 4 %+sysW · 5 %+time · 6 batW · 7 %+batW.
    pub fn title_items(&self) -> (bool, bool, bool, bool) {
        if self.text_pct.is_none() && self.text_time.is_none() && self.text_w.is_none() {
            let i = if self.info > 7 { 4 } else { self.info };
            return (matches!(i, 1 | 4 | 5 | 7), matches!(i, 2 | 5), matches!(i, 3 | 4 | 6 | 7), matches!(i, 6 | 7));
        }
        (self.text_pct.unwrap_or(false), self.text_time.unwrap_or(false),
         self.text_w.unwrap_or(false), self.w_src.as_deref() == Some("bat"))
    }
    // styles that draw the % digits inside the glyph — the % title item is redundant there
    // (the settings UI shows this as a locked "아이콘에 포함" chip, so the rule is visible)
    pub fn digits_in_icon(&self) -> bool { matches!(self.widget.as_str(), "combo" | "iconpct" | "stack") }
}
fn d_info() -> u8 { 4 }
fn d_true() -> bool { true }
fn d_low() -> u8 { 20 }
fn d_high() -> u8 { 80 }
fn d_widget() -> String { "icon".into() }
impl Default for Cfg {
    fn default() -> Self {
        Cfg { info: 4, colorize: true, low_pct: 20, high_pct: 80, widget: "icon".into(), glyph_xl: false, shortcut: true,
              text_pct: None, text_time: None, text_w: None, w_src: None }   // None → title_items falls back to `info`
    }
}
pub fn cfg_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join("Library/Application Support/3d-battery-life/tray.json")
}
// The popover's settings panel writes tray.json (via the node server's /api/config); the tray
// menu no longer mutates it, so we only ever READ it here.
pub fn load_cfg() -> Cfg {
    let mut c: Cfg = std::fs::read_to_string(cfg_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if c.info > 7 { c.info = 4; }   // clamp the menu-bar text mode to a valid variant
    c
}
fn time_str(l: &Live) -> String {
    match l.time_min {
        Some(m) if m > 0 => format!("{}:{:02}", m / 60, m % 60),
        _ => "–".into(),
    }
}

// macOS's DISPLAYED battery % (`pmset -g batt` → "… 67%; discharging …"). starship's energy-ratio
// % can sit 1–2% off the number macOS itself shows — the tray digits must match the system's own
// figure (and the popover's ioreg %), so when this parses the ticker overrides Live.pct with it.
pub fn displayed_pct() -> Option<f64> {
    let out = std::process::Command::new("pmset").args(["-g", "batt"]).output().ok()?;
    parse_pmset_pct(&String::from_utf8_lossy(&out.stdout))
}
fn parse_pmset_pct(s: &str) -> Option<f64> {
    let head = &s[..s.find('%')?];
    let start = head.rfind(|c: char| !c.is_ascii_digit()).map_or(0, |j| j + 1);
    head[start..].parse::<f64>().ok().filter(|p| (0.0..=100.0).contains(p))
}

// Menu-bar glyph ink: WHITE with a subtle dark shadow — the way macOS itself (and every other
// menu-bar app) draws bar contents over the wallpaper, in light AND dark system mode. The shadow
// is what keeps white legible on light backdrops, so no appearance detection is needed (an
// AppleInterfaceStyle-based dark-ink variant looked alien next to the neighboring icons).
const INK: (u8, u8, u8, u8) = (255, 255, 255, 255);
const SHADOW: (u8, u8, u8, u8) = (0, 0, 0, 135);        // soft +1,+1 drop under body outlines
const DIGIT_SHADOW: (u8, u8, u8, u8) = (0, 0, 0, 205);  // crisp backing for digits/bolt/plug
const OUT4: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];   // 4-side outline offsets

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

// Which menu-bar glyph to draw. Packs varying amounts of info into a tight menu-bar slot:
//   "text"    → None (title only)
//   "bar"     → thin vertical cell filling from the bottom
//   "iconpct" → battery outline with the % number inside (no fill)
//   "combo"   → battery FILLED by % + number overlaid + charge status (max info, min width)
//   "stack"   → % number stacked ABOVE a mini filled battery (narrowest footprint)
//   _ (icon)  → filled battery + charge status
pub fn menu_icon(l: &Live, colorize: bool, widget: &str, xl: bool, lpm: bool) -> Option<(Vec<u8>, u32, u32)> {
    match widget {
        "text" => None,
        "bar" => Some(bar_glyph(l, colorize, lpm)),
        "iconpct" => Some(battery_pct_icon(l, colorize, lpm)),
        "combo" => Some(combo_icon(l, colorize, lpm)),
        "stack" => Some(stack_icon(l, colorize, lpm)),
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
    let ink = fill_color(l, colorize, lpm);   // number colored by level / LPM
    // thin battery outline + cap — soft drop shadow first, white on top
    let (bx0, by0, bx1, by1) = (1i32, 2i32, 33i32, 18i32);
    for (o, c) in [(1i32, SHADOW), (0i32, INK)] {
        rect(&mut buf, bx0 + o, by0 + o, bx1 + o, by0 + 1 + o, c);
        rect(&mut buf, bx0 + o, by1 - 1 + o, bx1 + o, by1 + o, c);
        rect(&mut buf, bx0 + o, by0 + o, bx0 + 1 + o, by1 + o, c);
        rect(&mut buf, bx1 - 1 + o, by0 + o, bx1 + o, by1 + o, c);
        rect(&mut buf, bx1 + o, 7 + o, bx1 + 3 + o, 13 + o, c);
    }
    // left indicator (bolt/plug) + % digits — 4-side dark outline under the level-colored ink so
    // they stay crisp on any backdrop (a diagonal shadow would fill '4's open top → reads as 9)
    let ind_w = if l.charging || l.full { 8i32 } else { 0 };
    let draw_ind = |buf: &mut Vec<u8>, ox: i32, oy: i32, c: (u8, u8, u8, u8)| {
        if l.charging {
            for &(x, y) in &[(6, 4), (5, 5), (5, 6), (4, 7), (7, 8), (6, 9), (6, 10), (5, 11)] { px(buf, x + ox, y + oy, c); }
            rect(buf, 4 + ox, 7 + oy, 8 + ox, 8 + oy, c);      // crossbar → lightning
        } else if l.full {
            for &(x, y) in &[(4, 4), (4, 5), (6, 4), (6, 5)] { px(buf, x + ox, y + oy, c); }   // prongs
            rect(buf, 3 + ox, 6 + oy, 8 + ox, 10 + oy, c);                                     // plug body
            for y in 10..13 { px(buf, 5 + ox, y + oy, c); }                                    // cord
        }
    };
    let digits: Vec<u8> = (l.pct.clamp(0.0, 100.0).round() as u32).to_string().bytes().map(|b| b - b'0').collect();
    let (scale, gap) = (2i32, 1i32);
    let dw = 3 * scale + gap;
    let total = digits.len() as i32 * dw - gap;
    let (dl, dr) = (bx0 + 1 + ind_w, bx1 - 1);
    let x0 = (dl + dr) / 2 - total / 2;
    let y0 = (h as i32 - 5 * scale) / 2;
    let draw_digits = |buf: &mut Vec<u8>, ox: i32, oy: i32, c: (u8, u8, u8, u8)| {
        let mut x = x0;
        for &d in &digits {
            let g = DIGITS[d as usize % 10];
            for (row, bits) in g.iter().enumerate() {
                for col in 0..3i32 {
                    if bits & (1 << (2 - col)) != 0 {
                        rect(buf, x + col * scale + ox, y0 + row as i32 * scale + oy, x + col * scale + scale + ox, y0 + row as i32 * scale + scale + oy, c);
                    }
                }
            }
            x += dw;
        }
    };
    for &(ox, oy) in &OUT4 { draw_ind(&mut buf, ox, oy, DIGIT_SHADOW); draw_digits(&mut buf, ox, oy, DIGIT_SHADOW); }
    draw_ind(&mut buf, 0, 0, ink);
    draw_digits(&mut buf, 0, 0, ink);
    (buf, w, h)
}

// Compact single cell: battery FILLED proportional to % (color by level) + % number overlaid
// (white with a dark shadow so it reads over both the fill and the empty part) + charge status
// bolt/plug. Max info in one battery-width slot — no separate title text needed.
pub fn combo_icon(l: &Live, colorize: bool, lpm: bool) -> (Vec<u8>, u32, u32) {
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
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = fill_color(l, colorize, lpm);
    // battery body (soft drop shadow under the white outline) + proportional fill
    let (bx0, by0, bx1, by1) = (1i32, 2i32, 33i32, 18i32);
    for (o, c) in [(1i32, SHADOW), (0i32, INK)] {
        rect(&mut buf, bx0 + o, by0 + o, bx1 + o, by0 + 2 + o, c);
        rect(&mut buf, bx0 + o, by1 - 2 + o, bx1 + o, by1 + o, c);
        rect(&mut buf, bx0 + o, by0 + o, bx0 + 2 + o, by1 + o, c);
        rect(&mut buf, bx1 - 2 + o, by0 + o, bx1 + o, by1 + o, c);
        rect(&mut buf, bx1 + o, 7 + o, bx1 + 3 + o, 13 + o, c);
    }
    let (ix0, iy0, ix1, iy1) = (bx0 + 2, by0 + 2, bx1 - 2, by1 - 2);
    let fw = ((ix1 - ix0) as f64 * pct / 100.0).round() as i32;
    rect(&mut buf, ix0, iy0, ix0 + fw.max(1), iy1, fill);
    // charge status on the left of the body, dark ink so the number stays clear
    let ind_ink = (16u8, 20u8, 26u8, 255u8);
    let ind_w = if l.charging || l.full { 7i32 } else { 0 };
    if l.charging {
        for &(x, y) in &[(6, 4), (5, 5), (5, 6), (7, 8), (6, 9), (6, 10), (5, 11)] { px(&mut buf, x, y, ind_ink); }
        rect(&mut buf, 4, 7, 8, 8, ind_ink);
    } else if l.full {
        for &(x, y) in &[(4, 4), (6, 4)] { px(&mut buf, x, y, ind_ink); }
        rect(&mut buf, 3, 5, 8, 9, ind_ink);
        for y in 9..12 { px(&mut buf, 5, y, ind_ink); }
    }
    // % number, 2×, centered in the space right of the indicator. Backed by a 4-side OUTLINE
    // (was a +1,+1 drop shadow, which filled '4's open top and smeared two-digit numbers) so the
    // white strokes stay separated over both the fill and the empty part.
    let digits: Vec<u8> = (pct.round() as u32).to_string().bytes().map(|b| b - b'0').collect();
    let (scale, gap) = (2i32, 1i32);
    let dw = 3 * scale + gap;
    let total = digits.len() as i32 * dw - gap;
    let (dl, dr) = (bx0 + 2 + ind_w, bx1 - 1);
    let x0 = (dl + dr) / 2 - total / 2;
    let y0 = (h as i32 - 5 * scale) / 2;
    let passes: [(&[(i32, i32)], (u8, u8, u8, u8)); 2] = [(&OUT4, DIGIT_SHADOW), (&[(0, 0)], INK)];
    for (offs, col_c) in passes {
        for &(ox, oy) in offs {
            let mut x = x0;
            for &d in &digits {
                let g = DIGITS[d as usize % 10];
                for (row, bits) in g.iter().enumerate() {
                    for c in 0..3i32 {
                        if bits & (1 << (2 - c)) != 0 {
                            let (dx, dy) = (x + c * scale + ox, y0 + row as i32 * scale + oy);
                            rect(&mut buf, dx, dy, dx + scale, dy + scale, col_c);
                        }
                    }
                }
                x += dw;
            }
        }
    }
    (buf, w, h)
}

// % number stacked ABOVE a mini horizontal battery — narrowest horizontal footprint for a tight
// menu bar (packs level graphic + number into ~1 battery width, using height instead of width).
pub fn stack_icon(l: &Live, colorize: bool, lpm: bool) -> (Vec<u8>, u32, u32) {
    let (w, h) = (26u32, 22u32);
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let px = |buf: &mut Vec<u8>, x: i32, y: i32, c: (u8, u8, u8, u8)| {
        if x < 0 || y < 0 || x as u32 >= w || y as u32 >= h { return; }
        let i = ((y as u32 * w + x as u32) * 4) as usize;
        buf[i] = c.0; buf[i + 1] = c.1; buf[i + 2] = c.2; buf[i + 3] = c.3;
    };
    let rect = |buf: &mut Vec<u8>, x0: i32, y0: i32, x1: i32, y1: i32, c: (u8, u8, u8, u8)| {
        for y in y0..y1 { for x in x0..x1 { px(buf, x, y, c); } }
    };
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = fill_color(l, colorize, lpm);
    // number on top (2× tall but tight), centered, 4-side dark outline under it; charging/LPM
    // tints the digits with the fill color
    let dcol = if l.charging || l.full || lpm { fill } else { INK };
    let digits: Vec<u8> = (pct.round() as u32).to_string().bytes().map(|b| b - b'0').collect();
    let (scale, gap) = (2i32, 1i32);
    let dw = 3 * scale + gap;
    let total = digits.len() as i32 * dw - gap;
    let x0 = w as i32 / 2 - total / 2;
    let ny = 0;
    let passes: [(&[(i32, i32)], (u8, u8, u8, u8)); 2] = [(&OUT4, DIGIT_SHADOW), (&[(0, 0)], dcol)];
    for (offs, col_c) in passes {
        for &(ox, oy) in offs {
            let mut x = x0;
            for &d in &digits {
                let g = DIGITS[d as usize % 10];
                for (row, bits) in g.iter().enumerate() {
                    for c in 0..3i32 {
                        if bits & (1 << (2 - c)) != 0 { rect(&mut buf, x + c * scale + ox, ny + row as i32 * scale + oy, x + c * scale + scale + ox, ny + row as i32 * scale + scale + oy, col_c); }
                    }
                }
                x += dw;
            }
        }
    }
    // mini horizontal battery below (fills proportional to %) — shadowed white outline
    let (bx0, by0, bx1, by1) = (2i32, 13i32, 22i32, 22i32);
    for (o, c) in [(1i32, SHADOW), (0i32, INK)] {
        rect(&mut buf, bx0 + o, by0 + o, bx1 + o, by0 + 1 + o, c);
        rect(&mut buf, bx0 + o, by1 - 1 + o, bx1 + o, by1 + o, c);
        rect(&mut buf, bx0 + o, by0 + o, bx0 + 1 + o, by1 + o, c);
        rect(&mut buf, bx1 - 1 + o, by0 + o, bx1 + o, by1 + o, c);
        rect(&mut buf, bx1 + o, by0 + 2 + o, bx1 + 2 + o, by1 - 2 + o, c);
    }
    let (ix0, iy0, ix1, iy1) = (bx0 + 1, by0 + 1, bx1 - 1, by1 - 1);
    let fw = ((ix1 - ix0) as f64 * pct / 100.0).round() as i32;
    rect(&mut buf, ix0, iy0, ix0 + fw.max(1), iy1, fill);
    // charge status over the mini battery: bolt (charging) / plug (full), white with a dark
    // backing so it reads on the fill AND the transparent empty part
    if l.charging || l.full {
        for (off, c) in [(1i32, DIGIT_SHADOW), (0i32, INK)] {
            if l.charging {
                for &(x, y) in &[(13, 14), (12, 15), (13, 18), (12, 19)] { px(&mut buf, x + off, y + off, c); }
                rect(&mut buf, 10 + off, 16 + off, 15 + off, 18 + off, c);   // crossbar → lightning
            } else {
                for &(x, y) in &[(10, 14), (13, 14)] { px(&mut buf, x + off, y + off, c); }   // prongs
                rect(&mut buf, 9 + off, 15 + off, 15 + off, 18 + off, c);                     // plug body
                for y in 18..20 { px(&mut buf, 12 + off, y + off, c); }                       // cord
            }
        }
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
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = fill_color(l, colorize, lpm);

    // body outline (2px), soft drop shadow under the white. XL uses a smaller vertical margin
    // so the body is taller.
    let m = if xl { 1i32 } else { 3 };
    let (bx0, by0, bx1, by1) = (1i32, m, 33i32, h as i32 - m);
    for (o, c) in [(1i32, SHADOW), (0i32, INK)] {
        rect(&mut buf, bx0 + o, by0 + o, bx1 + o, by0 + 2 + o, c);   // top
        rect(&mut buf, bx0 + o, by1 - 2 + o, bx1 + o, by1 + o, c);   // bottom
        rect(&mut buf, bx0 + o, by0 + o, bx0 + 2 + o, by1 + o, c);   // left
        rect(&mut buf, bx1 - 2 + o, by0 + o, bx1 + o, by1 + o, c);   // right
        rect(&mut buf, bx1 + o, 7 + o, bx1 + 3 + o, 13 + o, c);      // nub cap (vertically centered)
    }

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

// ---- settings-panel preview bridge ----------------------------------------------------------
// Dumps every widget style (× colorized/mono × normal/XL) for the current battery state plus
// three fixed demo states (충전/부족/저전력) as raw-RGBA-base64 JSON. The popover's settings panel
// renders these directly, so the preview IS the tray renderer's output — zero drift by
// construction. Written only when the visible inputs change (~every 1% of battery), read via
// the node server's /api/tray-preview.
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = ((c[0] as u32) << 16) | ((*c.get(1).unwrap_or(&0) as u32) << 8) | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}
fn render_style(style: &str, l: &Live, colorize: bool, lpm: bool) -> (Vec<u8>, u32, u32) {
    match style {
        "icon_xl" => battery_icon(l, colorize, true, lpm),
        "combo" => combo_icon(l, colorize, lpm),
        "iconpct" => battery_pct_icon(l, colorize, lpm),
        "stack" => stack_icon(l, colorize, lpm),
        "bar" => bar_glyph(l, colorize, lpm),
        _ => battery_icon(l, colorize, false, lpm),
    }
}
pub fn write_preview(dir: &std::path::Path, cur: &Live, lpm: bool) {
    let mk = |pct: f64, charging: bool, min: i64, w: f64| Live {
        ok: true, pct, charging, time_min: Some(min), watts: w, ..Default::default()
    };
    // fixed demo states so the panel can preview 충전/부족/저전력 without waiting for them; the
    // popover composes the "cur" state's text from /api/live, so no live numbers are needed here
    let states = [
        ("cur", cur.clone(), lpm, 0.0),
        ("chg", mk(45.0, true, 78, 28.5), false, 31.2),
        ("low", mk(12.0, false, 54, 5.8), false, 6.1),
        ("lpm", mk(33.0, false, 190, 4.6), true, 4.8),
    ];
    let mut glyphs = serde_json::Map::new();
    let mut meta = serde_json::Map::new();
    for (name, l, is_lpm, sys_w) in &states {
        let mut styles = serde_json::Map::new();
        for style in ["icon", "icon_xl", "combo", "iconpct", "stack", "bar"] {
            let (col, w, h) = render_style(style, l, true, *is_lpm);
            let (mono, ..) = render_style(style, l, false, *is_lpm);
            styles.insert(style.into(), serde_json::json!({ "w": w, "h": h, "c": b64(&col), "m": b64(&mono) }));
        }
        glyphs.insert((*name).into(), styles.into());
        meta.insert((*name).into(), serde_json::json!({
            "pct": l.pct.round(), "charging": l.charging, "full": l.full, "lpm": is_lpm,
            "min": l.time_min, "sysW": sys_w, "batW": l.watts,
        }));
    }
    let out = serde_json::json!({ "states": meta, "glyphs": glyphs }).to_string();
    // tmp + rename so a concurrent /api/tray-preview read never sees a half-written file
    let tmp = dir.join("tray-preview.json.tmp");
    if std::fs::write(&tmp, out).is_ok() { let _ = std::fs::rename(&tmp, dir.join("tray-preview.json")); }
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
    let pct = l.pct.clamp(0.0, 100.0);
    let fill = fill_color(l, colorize, lpm);
    let (bx0, by0, bx1, by1) = (3i32, 1i32, 11i32, 19i32);   // upright cell
    for (o, c) in [(1i32, SHADOW), (0i32, INK)] {
        rect(&mut buf, bx0 + o, by0 + o, bx1 + o, by0 + 2 + o, c);
        rect(&mut buf, bx0 + o, by1 - 2 + o, bx1 + o, by1 + o, c);
        rect(&mut buf, bx0 + o, by0 + o, bx0 + 2 + o, by1 + o, c);
        rect(&mut buf, bx1 - 2 + o, by0 + o, bx1 + o, by1 + o, c);
        rect(&mut buf, bx0 + 2 + o, by0 - 2 + o, bx1 - 2 + o, by0 + o, c); // top terminal
    }
    // fill from the bottom
    let (ix0, ix1) = (bx0 + 2, bx1 - 2);
    let inner_top = by0 + 2;
    let inner_bot = by1 - 2;
    let fh = ((inner_bot - inner_top) as f64 * pct / 100.0).round() as i32;
    rect(&mut buf, ix0, inner_bot - fh.max(1), ix1, inner_bot, fill);
    // charge status overlaid on the cell: bolt (charging) / plug (full), white + dark backing
    // (the cell is only 4px of inner width, so the overlay spans the whole glyph)
    if l.charging || l.full {
        for (off, c) in [(1i32, DIGIT_SHADOW), (0i32, INK)] {
            if l.charging {
                for &(x, y) in &[(8, 4), (8, 5), (7, 6), (8, 9), (7, 10), (7, 11), (6, 12)] { px(&mut buf, x + off, y + off, c); }
                rect(&mut buf, 5 + off, 7 + off, 9 + off, 9 + off, c);   // crossbar → lightning
            } else {
                for &(x, y) in &[(5, 4), (8, 4)] { px(&mut buf, x + off, y + off, c); }   // prongs
                rect(&mut buf, 5 + off, 5 + off, 9 + off, 9 + off, c);                    // plug body
                for y in 9..12 { px(&mut buf, 7 + off, y + off, c); }                     // cord
            }
        }
    }
    (buf, w, h)
}

// The compact tray-title text macOS shows next to the icon, composed from the independent
// title items (잔량/시간/전력 chips) joined with " · ". `sys_w` is the live SMC system draw when
// available, falling back to the battery-rail watts (0 while plugged/holding).
// Rules the settings UI mirrors 1:1 (nothing hidden): % is skipped when the glyph already draws
// it; time is skipped while unknown (no countdown); a text-only widget never goes blank.
pub fn tray_title(l: &Live, c: &Cfg, sys_w: f64) -> String {
    if !l.ok {
        return String::new();
    }
    let (pct_on, time_on, w_on, w_bat) = c.title_items();
    let pct = l.pct.round() as i64;
    let mut parts: Vec<String> = Vec::new();
    if pct_on && !c.digits_in_icon() { parts.push(format!("{pct}%")); }
    if time_on && matches!(l.time_min, Some(m) if m > 0) { parts.push(time_str(l)); }
    if w_on { parts.push(format!("{:.1}W", if w_bat { l.watts.abs() } else { sys_w })); }
    if c.widget == "text" && parts.is_empty() { parts.push(format!("{pct}%")); }   // no glyph to fall back on
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(pct: f64, min: Option<i64>, watts: f64) -> Live {
        Live { ok: true, pct, watts, time_min: min, ..Default::default() }
    }

    // old tray.json (no text_* keys) must keep its legacy `info` meaning through title_items
    #[test]
    fn legacy_info_maps_to_chips() {
        let mut c = Cfg::default();
        for (info, want) in [
            (0u8, (false, false, false, false)),
            (1, (true, false, false, false)),
            (2, (false, true, false, false)),
            (3, (false, false, true, false)),
            (4, (true, false, true, false)),
            (5, (true, true, false, false)),
            (6, (false, false, true, true)),
            (7, (true, false, true, true)),
            (99, (true, false, true, false)),   // out of range → default (4)
        ] {
            c.info = info;
            assert_eq!(c.title_items(), want, "info={info}");
        }
        // explicit chips win over the legacy enum
        c.info = 0;
        c.text_time = Some(true);
        assert_eq!(c.title_items(), (false, true, false, false));
    }

    #[test]
    fn title_composition_rules() {
        let l = live(67.4, Some(312), 7.44);
        let mut c = Cfg { text_pct: Some(true), text_time: Some(true), text_w: Some(true), ..Cfg::default() };
        assert_eq!(tray_title(&l, &c, 9.96), "67% · 5:12 · 10.0W");
        c.w_src = Some("bat".into());
        assert_eq!(tray_title(&l, &c, 9.96), "67% · 5:12 · 7.4W");
        c.widget = "combo".into();                                   // % drawn in the glyph → skipped in text
        assert_eq!(tray_title(&l, &c, 9.96), "5:12 · 7.4W");
        let idle = live(67.4, None, 0.0);                            // unknown countdown → time part skipped
        assert_eq!(tray_title(&idle, &c, 9.96), "0.0W");
        let mut t = Cfg { text_pct: Some(false), text_time: Some(false), text_w: Some(false), ..Cfg::default() };
        t.widget = "text".into();                                    // text-only never goes blank
        assert_eq!(tray_title(&l, &t, 9.96), "67%");
        t.widget = "icon".into();
        assert_eq!(tray_title(&l, &t, 9.96), "");                    // icon-only: no title at all
    }

    #[test]
    fn pmset_pct_parse() {
        let out = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=5505123)\t67%; discharging; 5:12 remaining present: true\n";
        assert_eq!(parse_pmset_pct(out), Some(67.0));
        assert_eq!(parse_pmset_pct("no percent here"), None);
        assert_eq!(parse_pmset_pct("100%; charged"), Some(100.0));
    }

    // the preview dump must contain every state × style with RGBA buffers of the declared size
    #[test]
    fn preview_dump_shape() {
        let dir = std::env::temp_dir().join("bl-preview-test");
        let _ = std::fs::create_dir_all(&dir);
        write_preview(&dir, &live(67.0, Some(312), 7.4), false);
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("tray-preview.json")).unwrap()).unwrap();
        for s in ["cur", "chg", "low", "lpm"] {
            assert!(v["states"][s]["pct"].is_number(), "state {s}");
            for g in ["icon", "icon_xl", "combo", "iconpct", "stack", "bar"] {
                let e = &v["glyphs"][s][g];
                let n = (e["w"].as_u64().unwrap() * e["h"].as_u64().unwrap() * 4) as usize;
                for k in ["c", "m"] {
                    assert_eq!(e[k].as_str().unwrap().len(), n.div_ceil(3) * 4, "{s}/{g}/{k}");
                }
            }
        }
    }
}
