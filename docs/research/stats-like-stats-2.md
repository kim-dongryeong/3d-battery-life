# exelban/Stats — BATTERY module + menu-bar icon: EXHAUSTIVE feature inventory

Scope note on tags: The ENTIRE Stats Battery module is **read-only [DISPLAY]**. It only READS battery state (IOKit `AppleSmartBattery` / `IOPS*` / SMC keys) and draws it. It writes NO hardware, sets NO charge limit, toggles NO OS setting (no low-power-mode toggle, no charge-hold, unlike AlDente). The only privileged surfaces are: (1) macOS notification authorization `UNUserNotificationCenter.requestAuthorization([.alert,.sound])`, and (2) spawning `/usr/bin/top` to list processes. So every feature below is [DISPLAY] except those two, which I mark [PRIV] (needs OS permission, not hardware control). There are **zero [CONTROL] (hardware-writing) features** — a key competitive fact.

Sources (fetched from github.com/exelban/stats @ master): `Kit/Widgets/Battery.swift`, `Kit/Widgets/Mini.swift`, `Modules/Battery/{main,settings,readers,popup,portal,notifications}.swift`, `Modules/Battery/config.plist`, `Kit/extensions.swift` (color fns), `Kit/types.swift` (option arrays), `Kit/notifications.swift` (`checkDouble`), `Kit/helpers.swift` (`temperature()`), `en.lproj/Localizable.strings`.

---

## MODULE-LEVEL DEFAULTS (config.plist)
- [DISPLAY] Module `Name` = "Battery"; `State` default = **true** (module enabled by default).
- [DISPLAY] Module `Symbol` = `battery.100` (SF Symbol used in Stats' own module list).
- [DISPLAY] Registered widgets w/ default-on flags & order: `label`(off, order0), `mini`(off, order1), `bar_chart`(off, order2), **`battery`(ON, order3)** ← the default menu-bar widget, `battery_details`(off, order4).
- [DISPLAY] `Settings`: popup=true, notifications=true.
- [DISPLAY] mini-widget config defaults: `Title`="BAT", `Color`="monochrome", `Label`=false; preview `Value`=0.72; `bar_chart` & `mini` list "pressure" (and bar_chart "cluster") as `Unsupported colors`.

---

## (a) THE MENU-BAR "battery" WIDGET ICON — class `BatteryWidget` (Kit/Widgets/Battery.swift)

### Icon geometry / glyph drawing [all DISPLAY]
- Battery body is hand-drawn with `NSBezierPath(roundedRect:)`, NOT an SF Symbol. Base frame width 30pt.
- Body size: normal **22×12 pt**, XL **26×14 pt** (`xlSizeState`). Corner radius: normal 2, XL 3. Inner-fill radius: normal 1, XL 2. Border width 1pt.
- Border stroke color = `NSColor.textColor` @ **alpha 0.5**.
- Positive terminal "nub": a 2×4 pt rounded shape drawn to the right of the body, filled with `NSColor.textColor` (full alpha). Adds 2pt width.
- Fill (charge level): rounded rect whose width = `max(1, maxWidth * percentage)` where `maxWidth = batteryWidth - offsets`. So fill is **directly proportional to %**, min 1pt so it never fully disappears.
- Percentage text uses `Int(percentage.rounded(toPlaces:2) * 100)` → e.g. 0.72 → "72%".

### Fill COLOR ZONES — `Double.batteryColor(color:lowPowerMode:)` (Kit/extensions.swift L160) [DISPLAY]
This is the exact fill-color logic. `color` = the "Colorize" toggle. Thresholds are on the 0–1 level:
- **level < 0.20** → `NSColor.systemRed` (ALWAYS red, even when Colorize is OFF).
- **0.20 ≤ level ≤ 0.40** → Colorize OFF: `NSColor.textColor` (monochrome); Colorize ON: `NSColor.systemOrange`.
- **0.40 < level < 1.00** → Colorize OFF: `NSColor.textColor`; Colorize ON: `NSColor.systemGreen`.
- **level == 1.00 (exactly)** → `NSColor.textColor` (monochrome even when Colorize ON).
- (`lowPowerMode` param, if true, forces `systemOrange`, but the menu-bar widget does NOT pass it — always nil. Low-Power-Mode-orange only appears in the popup/portal V2 path below.)
- Net: **Colorize OFF (default)** = monochrome everywhere EXCEPT <20% which is red. **Colorize ON** = red <20 / orange 20–40 / green 40–100 (100 exact = mono).

### Charging bolt / plugged-plug symbol — `drawACIcon()` [DISPLAY]
- Shown only when `ACStatus` (i.e. `!isBatteryPowered`, on external power).
- If `isCharging` → a **lightning-bolt** polygon (6-point zig-zag), icon size 9×(h+6).
- If on AC but **not** charging (plugged/full/on-hold) → a **power-plug** polygon (17-point plug outline), icon size 9×(h+2).
- Drawn by filling with `NSColor.textColor` then a `.destinationOut` stroke pass to punch a 1pt outline gap (so the glyph reads as a cut-out silhouette over the fill).
- Placement depends on the "Charger state inside the battery" toggle:
  - `chargerIconInside` = **true (default)** → glyph drawn centered INSIDE the battery body.
  - `chargerIconInside` = false → glyph drawn as a separate 6pt-wide icon to the **LEFT** of the battery body (at x+3), height 12.

### Low / unknown states [DISPLAY]
- **Unknown %** (`percentage == nil`): instead of a fill, draws a "**?**" glyph (SF system font 11pt, white in dark mode / textColor in light) centered in the body.
- **Low**: no separate "low icon" — low is expressed purely via the red fill (<20%) described above.

### Toggles / settings on THIS widget (BatteryWidget.settings()) — all persisted in `Store`, keys shown
- [DISPLAY] **"Additional information"** popup select — key `\(title)_battery_additional`, default **`none`**. (Full option list in section (b).)
- [DISPLAY] **"Hide additional information when full"** switch — key `..._hideAdditionalWhenFull`, default **true**. When on, the additional text is suppressed if `percentage == 1` OR `optimizedCharging`.
- [DISPLAY] **"Colorize"** switch — key `..._color`, default **false**. Drives the `color` arg of `batteryColor` above.
- [DISPLAY] **"XL size"** switch — key `..._xlSize`, default **false**. (String literal "XL size", no localization entry → shown verbatim.)
- [DISPLAY] **"Charger state inside the battery"** switch — key `..._chargerInside`, default **true**.
- (Also reads `\(title)_timeFormat`, the module-shared Short/Long time format, default "short".)
- Note: iconState/`..._icon` key exists (default true) as a leftover flag but the battery glyph is always drawn.
- Special case: if the widget's owning module title == "Bluetooth", the Additional-information list is filtered to only {none, percentage} — irrelevant for the Battery module, but the same widget class is reused for Bluetooth-device battery.

---

## (b) "Additional information" text next to the icon — array `BatteryAdditionals` (Kit/types.swift L156)
Exact menu (key → visible label), default = **None**:
- [DISPLAY] `none` → **"None"** (default)
- (separator)
- [DISPLAY] `innerPercentage` → **"Percentage inside the icon"** — draws the integer % (no "%" sign) as a **cut-out** number inside the fill via `.destinationIn` blend, over a 0.5-alpha "underground" track. Font: 8pt bold (XL 9pt), bold, centered. Auto-disabled (falls back to plain fill) when `ACStatus && chargerIconInside` (charger glyph occupies the inside). Forces monochrome fill.
- (separator)
- [DISPLAY] `percentage` → **"Percentage"** — one row, e.g. "72%" (12pt regular). Shows "n/a" if unknown.
- [DISPLAY] `time` → **"Time"** — one row, formatted time-to-empty (or time-to-charge). Uses Short/Long format.
- [DISPLAY] `percentageAndTime` → **"Percentage and time"** — two stacked rows (9pt, centered), % on top, time below.
- [DISPLAY] `timeAndPercentage` → **"Time and percentage"** — two rows, time on top, % below.
- Time source rule (main.swift): `time = (timeToEmpty==0 && timeToCharge!=0) ? timeToCharge : timeToEmpty`.
- Time string format (`printSecondsToHoursMinutesSeconds`): **short** = "H:MM" (e.g. "1:20", "0:45"); **long** = "45min" / "2h" / "1h 20min"; returns "n/a" when 0/negative.

---

## (c) OTHER BATTERY WIDGETS

### `battery_details` widget — class `BatteryDetailsWidget` (Kit/Widgets/Battery.swift L485) [DISPLAY]
- Text-only widget (no glyph). Base width 20pt. Preview: 0.72 / 415 min / mode percentageAndTime.
- Single setting **"Details"** select — array `BatteryInfo` (Kit/types.swift L167), key `\(title)_batteryDetails_mode`, default **`percentage`**:
  - `percentage` → "Percentage" (default), `time` → "Time", `percentageAndTime` → "Percentage and time", `timeAndPercentage` → "Time and percentage".
- Two-row modes collapse to one row (just %) when `time <= 0`.

### `mini` widget — class `Mini` (Kit/Widgets/Mini.swift) [DISPLAY]
- Shows the % number as text (e.g. "72%"), optional label "BAT" above (7pt light). Value font 14pt (12pt if label shown).
- Color select (default from config = **`monochrome`** → white in dark / black in light). Battery feeds it `setColorZones((0.15, 0.3))`.
- When Color = "Based on utilization", uses `usageColor(zones:(0.15,0.3), reversed:true)` (reversed because title=="BAT"): **level < 0.15 → red (`NSColor.red`), 0.15–0.30 → orange (`NSColor.orange`), > 0.30 → blue (`NSColor.systemBlue`)**. (Note the inverted logic: full battery = "safe" blue.)
- Other options: **Label** on/off (default from config false), **Alignment** left/center/right (default left).

### `bar_chart` widget — class `BarChart` [DISPLAY]
- Battery feeds `setValue([[ColorValue(value.level)]])` and `setColorZones((0.15,0.3))`. One vertical bar whose height ∝ level; same 0.15/0.30 zone coloring (red/orange/blue via usageColor) when colorized. "pressure"/"cluster" colors unsupported.

### `label` widget [DISPLAY]
- Generic Kit vertical text label ("Battery"); no battery-specific behavior; off by default.

---

## (d) POPOVER — class `Popup` (Modules/Battery/popup.swift). EVERY row/section top-to-bottom:

### Dashboard (top, 160pt) [DISPLAY]
- Big drawn battery graphic `BatteryView` (rounded pill, 90pt tall). Fill color via `batteryColorV2()` (Kit/extensions.swift L184): **<20% red / 20–40% orange / 40–100% green** (no monochrome; low-power-mode→orange). Fill width = min 8pt + proportional.
- On external power, overlays an SF Symbol centered in the pill: **`bolt.fill`** if charging, **`powerplug.fill`** if plugged-not-charging. White when level>55%, else colored with a black outline halo.
- Large level number: `ValueField` 28pt medium + "%" 16pt tertiary. Tooltip on the number = "`<currentCapacity>` mAh".
- `BatteryStatus` pill (rounded badge, 11pt bold, colored bg @0.18 alpha) with icon+text:
  - Charging → text **"Charging"**, green, `bolt.fill`.
  - On battery → **"On battery"**; gray if level>0.15 else **red** (icon hidden on battery).
  - Plugged & charged & level≥1 → **"Plugged in"**, `powerplug.fill`.
  - Optimized charging engaged → **"On hold"**, gray, `powerplug.fill`.

### Section "Details" (SeparatorView label "Details") [DISPLAY]
- Row **"Source:"** → localized power source: **"AC Power"** / **"Battery Power"** (from `kIOPSPowerSourceStateKey`); default "Unknown".
- Row **"Time to discharge:"** (relabels to **"Time to charge:"** when on AC) → formatted time; special values: **"Calculating"** when raw time == -1; **"Fully charged"** when `isCharged`; **"On hold"** when optimized-charging; else **"Unknown"** when 0.
- Row **"Power:"** → on battery `abs(batteryPower)` W (2 dp); on AC `adapterPower` W. e.g. "18.5 W".
- Row **"Current:"** → on battery `abs(current)` mA; on AC computed `(adapterPower/adapterVoltage)*1000` mA. e.g. "1200 mA".
- Row **"Voltage:"** → battery voltage (2 dp) / adapter voltage. e.g. "12.6 V".

### Section "Power adapter" — only inserted when on AC (SeparatorView "Power adapter") [DISPLAY]
- Row **"Is charging:"** → StatusBadge **"Yes"/"No"** (green/red badge) from `isCharging`.
- Row **"Power:"** → adapter rated watts `\(ACwatts) W` (from `IOPSCopyExternalPowerAdapterDetails` `kIOPSPowerAdapterWattsKey`). e.g. "96 W".
- (This whole section is removed from the stack when the machine returns to battery power.)

### Section "Battery" (SeparatorView "Battery") [DISPLAY]
- Capacity block: two small (8pt tertiary) labels **"Max capacity"** (left) / **"Designed capacity"** (right), with values below (11pt secondary) as **"`<n>` mAh"** each.
- A horizontal `BarChartView` showing **health ratio** (maxCapacity/designedCapacity), colored `.systemGreen`.
- Row **"Health:"** → **"`<health>`%"** (health = round(100*maxCapacity/designedCapacity)).
- Row **"Cycles:"** → integer cycle count (IORegistry "CycleCount").
- Row **"Temperature:"** → formatted via `temperature()` respecting global unit (see (e)). e.g. "30°C" / "86°F".

### Section "Top processes" (SeparatorView "Top processes") — hidden entirely if Number-of-processes == 0 [PRIV: spawns /usr/bin/top]
- Column header **"Usage"**. Each row: process icon + name + power figure rendered as **"`<usage>`%"** (from `top -o power`). Count = the "Number of top processes" setting. Sorted descending by power.

### Popup settings [DISPLAY]
- Row **"Keyboard shortcut"** — a `KeyboardShartcutView` to bind a hotkey that opens this popup.

---

## (e) MODULE SETTINGS — class `Settings` (Modules/Battery/settings.swift)
- [PRIV/DISPLAY] **"Number of top processes"** select — array `NumbersOfProcesses = [0, 3, 5, 8, 10, 15]`, key `Battery_processes`, default **8**. Value 0 disables the top-processes reader AND removes the popup section. (Feeds `/usr/bin/top -o power -l 2 -n <N> -stats pid,command,power`.)
- [DISPLAY] **"Time format"** select — array `ShortLong` = {`short`→"Short", `long`→"Long"}, key `Battery_timeFormat`, default **`short`**. Only rendered when a battery-type widget (`.battery`) is active. Controls all time strings (widget + popup + portal).
- [DISPLAY] **Temperature unit** — NOT in the Battery panel; it is a GLOBAL app setting. Array `TemperatureUnits` = {`system`→"System" (default), `celsius`→"Celsius", `fahrenheit`→"Fahrenheit"}, key **`temperature_units`**, default **`system`** (auto-detects locale). The popup Temperature row uses `UnitTemperature.current` derived from this. Formatting via `temperature(value)` with `en_US` MeasurementFormatter, 0 fraction digits (e.g. "30°C").

---

## (f) NOTIFICATIONS — class `Notifications` (Modules/Battery/notifications.swift) + `checkDouble` (Kit/notifications.swift)

### Settings rows (two selects), array `notificationLevels` (Kit/types.swift L331) [DISPLAY of setting]
- **"Low level notification"** — key `Battery_notifications_low`, default **`""` = Disabled**.
- **"High level notification"** — key `Battery_notifications_high`, default **`""` = Disabled**.
- Shared option list (key stored as decimal string, label shown): `""`→**"Disabled"**, `0.03`→"3%", `0.05`→"5%", `0.1`→"10%", `0.15`→"15%", `0.2`→"20%", `0.25`→"25%", `0.3`→"30%", `0.35`→"35%", `0.4`→"40%", `0.45`→"45%", `0.5`→"50%", `0.55`→"55%", `0.6`→"60%", `0.65`→"65%", `0.7`→"70%", `0.75`→"75%", `0.8`→"80%", `0.85`→"85%", `0.9`→"90%", `0.95`→"95%", `0.97`→"97%", `1.0`→"100%". (Same list serves both low & high.)
- Legacy migration: old keys `Battery_lowLevelNotification` / `Battery_highLevelNotification` are auto-migrated to the new `_notifications_low/high` keys on init.

### LOW-battery notification behavior [PRIV — needs notification permission]
- Fires only when NOT charging. If `isCharging` OR `!isBatteryPowered`, any pending low notification is dismissed.
- Trigger via `checkDouble(value: level, threshold, less: true, consecutive: 2)`: requires **2 consecutive** reads with `level <= threshold` to fire; re-arms (clears) once `level > threshold`. So it fires once per crossing, not repeatedly.
- Title: **"Low battery"**.
- Subtitle: `"%0% remaining"` with `%0` = `Int(level*100)` → e.g. **"15% remaining"**. If `timeToEmpty > 0`, appends time in LONG format in parens → e.g. **"15% remaining (1h 20min)"**.
- Sound: `UNNotificationSound.default`.

### HIGH-battery notification behavior [PRIV — needs notification permission]
- Fires only when `isCharging`. If `isBatteryPowered`, pending high notification is dismissed.
- Trigger via `checkDouble(value: level, threshold, less: false, consecutive: 2)`: requires **2 consecutive** reads with `level >= threshold`; re-arms once `level < threshold`.
- Title: **"High battery"**.
- Subtitle: `"%0% to full charge"` with `%0` = `Int((1-level)*100)` → e.g. at 80% w/ threshold 80% → **"20% to full charge"**. If `timeToCharge > 0`, appends LONG-format time in parens → e.g. **"20% to full charge (45min)"**.
- Sound: default.

### Notification identifiers / lifecycle [PRIV]
- IDs: internal "low"/"high" → registered as `Stats_Battery_low` / `Stats_Battery_high`. Removed on module terminate and re-cleared on init.
- Authorization requested lazily on first `showNotification` via `requestAuthorization(options: [.alert, .sound])`.

---

## DATA SOURCE / READER FACTS (for parity of the underlying values) [all DISPLAY]
- Live updates are event-driven via `IOPSNotificationCreateRunLoopSource` (re-reads on every power-source change), plus reads on settings changes — not a fixed poll.
- `UsageReader` pulls from `IOServiceGetMatchingService("AppleSmartBattery")` + `IOPSCopyPowerSourcesList`. Fields: level=`kIOPSCurrentCapacityKey`/100; isCharging=IORegistry "IsCharging"; isCharged=`kIOPSIsChargedKey`; `optimizedChargingEngaged` = list["Optimized Battery Charging Engaged"]==1 OR (ChargerData NotChargingReason!=0 while <100% & not charging & on AC); timeToEmpty=`kIOPSTimeToEmptyKey`; timeToCharge=`kIOPSTimeToFullChargeKey`; cycles="CycleCount"; currentCapacity="AppleRawCurrentCapacity"; designedCapacity="DesignCapacity" (or BatteryData.DesignCapacity, min 1); maxCapacity= ARM:"AppleRawMaxCapacity" / Intel:"MaxCapacity" (or "NominalChargeCapacity"); health=round(100*max/designed); current="Amperage"; voltage="Voltage"/1000; temperature = avg of SMC `TB1T`/`TB2T` (>0), else IORegistry "Temperature"/100; ACwatts=`kIOPSPowerAdapterWattsKey`; batteryPower=SMC `PPBR` (else V·I/1000); adapterPower=SMC `PDTR`; adapterVoltage=AdapterDetails.AdapterVoltage/1000; chargingCurrent/Voltage from "ChargerData".
- Intel-only extra: `state` = `kIOPSBatteryHealthKey` (health string).

---

## QUICK PARITY CHECKLIST (defaults recap)
- Default menu-bar widget = drawn battery glyph, Additional info **None**, Colorize **OFF**, XL **OFF**, charger glyph **inside** battery, hide-when-full **ON**.
- Color thresholds to copy exactly: menu-bar fill = red<20% / mono 20–100 (Colorize off) OR red<20 / orange20–40 / green40–100, 100=mono (Colorize on). Popup+portal pill = red<20 / orange20–40 / green40–100 always. Mini/bar (utilization) = red<15 / orange15–30 / blue>30.
- Time format default **Short** ("H:MM"); Top processes default **8**; Temperature unit default **System** (global key `temperature_units`).
- Notifications default **Disabled** for both low & high; both require 2 consecutive reads; low needs on-battery, high needs charging.
- No hardware-control features exist anywhere in the module.