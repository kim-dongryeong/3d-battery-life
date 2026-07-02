# macOS Battery Menu-Bar App Feature Inventory (for feature-parity cataloguing)

Scope note: items below are the **distinctive** battery features/displayed items that go BEYOND what Stats / coconutBattery / iStat Menus already cover (those already cover: cycle count, max/design capacity, current mAh, temperature, voltage, amperage, health %, manufacture date/age, charger wattage, serial, basic menu-bar % + basic time-remaining + basic charge-% history charts). Each item is tagged **[DISPLAY]** (read-only, safe to implement) or **[CONTROL]** (writes charging hardware / needs a privileged helper/SMC access, admin password, and on Apple Silicon a signed daemon).

Terminology clarification: the task listed "Aes/Endurance." I could find no macOS battery app named "Aes." The real app is **Endurance** (enduranceapp.com). The closest name-match to "Aes" is **AirBattery** (open-source, lihaoyun6) — a multi-device battery monitor — which I include below in case that was intended.

---

## 1. Apple built-in — System Settings > Battery + menu-bar Battery Status menu (macOS Sonoma/Sequoia/Tahoe)

Menu-bar Battery Status menu (click the battery icon):
- [DISPLAY] Battery percentage in the dropdown; toggle "Show Percentage" so the number renders **inside/next to** the menu-bar battery glyph.
- [DISPLAY] "Time until full" when plugged in; time-remaining estimate is intentionally NOT shown on battery in recent macOS (only % + power source).
- [DISPLAY] **"Using Significant Energy"** section — live list of app names currently drawing heavy power. Key behavior: it only lists apps drawing heavily **at the present instant**, so it is usually empty even after hours of drain. (per Apple Support "What is the Battery Status menu")
- [DISPLAY] Power-source label: "Power Source: Battery" vs "Power Adapter."
- [DISPLAY] Charging-state strings: **"Charging,"** **"Not Charging,"** **"Charging on Hold,"** and the tooltip variant **"Charging on hold (Rarely used on battery)."**
- [CONTROL] **"Charge to Full Now"** menu command — overrides Optimized Battery Charging / charge limit to complete a 100% charge immediately.

System Settings > Battery pane:
- [DISPLAY] **Battery Health** info button → **Maximum Capacity** and **Condition** = **"Normal"** or **"Service Recommended."**
- [DISPLAY] **Energy usage history graphs** — two stacked bar charts: **"Battery Level"** (last 24 Hours / Last 10 Days) and **"Screen On Usage" / "Screen Off Usage"** hours, shaded during on-battery periods.
- [DISPLAY] **"Last charged to N%"** line with timestamp of last charge.
- [CONTROL] **Optimized Battery Charging** toggle (learns routine, delays past 80%; default ON since Big Sur).
- [CONTROL] **Charge Limit** picker — discrete options **80%, 85%, 90%, 95%** (macOS 15/Tahoe 26.x). Note: system periodically charges to 100% to recalibrate the state-of-charge estimate.
- [CONTROL] **Low Power Mode** scheduler: **Never / Always / Only on Battery / Only on Power Adapter**.
- Notification: **"Service Recommended"** health warning (per Apple Support 108376).
Sources: Apple Support 102338 (Optimized Charging & Charge Limit), 108376 (Service Recommended), mchl173fcc57 (Battery Status menu).

---

## 2. AlDente / AlDente Pro — AppHouseKitchen (closed source; the reference target)

Free tier:
- [CONTROL] **Charge Limiter** — slider or typed value, **20–100%**; recommended 50–80%. Charging pauses at limit, runs off AC only.
- [CONTROL] **Discharge** — actively drains battery while plugged in when limit is set below current %; disables sleep in **Clamshell mode**; auto-deactivates on reaching target.
- [CONTROL] **Automatic Discharge** toggle (Settings → Charge).
- [DISPLAY] **Live Status Icons** (4 distinct menu-bar states): Battery Charging (plugged+charging), Battery Charging **Paused** (plugged, paused), Battery **Discharging** (plugged, discharging), **Unplugged** Discharging.

Pro-exclusive:
- [CONTROL] **Sailing Mode** — hysteresis band (e.g., 75–80%): after hitting upper, let battery drift down to lower before recharging; recommended interval **5–10%**; shown as a **dashed line** on the popover slider; suspended during Top Up / Calibration; does NOT actively discharge.
- [CONTROL] **Heat Protection** — pauses charging when battery temp exceeds threshold; default **35°C** (Apple ambient limit); **5-minute hysteresis** between state changes.
- [CONTROL] **Calibration Mode** — one-click cycle: charge to 100% → discharge to 10% → recharge to 100% → hold 1 hour → return to preset limit; disables Heat Protection during run; recommended every **3–6 weeks**; schedulable.
- [CONTROL] **Top Up** — temporarily sets limit to 100%, reverts to prior limit after the next unplug.
- [CONTROL] **Hardware Battery Percentage** — reads the BMS directly; noted to differ from the macOS % by **2–7%**; when on, all features key off this value. [DISPLAY of the raw BMS %.]
- [DISPLAY] **Power Flow** — real-time **Sankey diagram** of energy flow (charger/battery → MacBook); optional menu-bar popover (Settings → Stats).
- [CONTROL] **Disable Sleep until Charge Limit** (display sleeps, Mac stays awake).
- [CONTROL] **Stop Charging when Sleeping** (Apple Silicon only) — prevents sleep-charging to 100%.
- [CONTROL] **Stop Charging when App Closed** (Apple Silicon only) — limit persists after quit; resets to 100% only on full power-off.
- [CONTROL] **Control MagSafe LED** — MagSafe 3: Green = limit reached, Orange = charging/discharging toward limit, optional blinking orange during discharge, plus "Always Off." MagSafe 2: Green = limit reached OR Sailing active, Orange = charging OR Heat Protection active, alternating orange/green blink = discharging.
- [CONTROL] **Fast User Switching** support (default ON; per-account state).
- [CONTROL] **Schedule** — actions: Set Charge Limit, Start Calibration, Top Up, Pause Charging, Discharge to X; intervals **Daily / Weekdays / Weekly / Biweekly / Monthly / Never**; "Start Task at next Opportunity" (avoid skip during sleep); **Task History**; up to ~10-min execution delay.
- [CONTROL] **Apple Shortcuts** actions: Disable/Enable High Power Mode, Disable/Enable Low Power Mode, Get Battery Percentage, Get Charge Limit, **Get State** (returns one of: Charging, Pause, Sailing, Discharging, Topup, HeatProtect, Calibration, Exit), Get Temperature, Pause Charging, Set Charge Limit, **Set MagSafe LED** (Green/Orange/Orange blinking/Off), Start Calibration, Start Discharge, Top Up.
Sources: apphousekitchen.com/aldente-overview/features/, apphousekitchen.com.

---

## 3. Battery Toolkit — mhaeuser (open source, BSD-3-Clause; Apple Silicon only, Ventura→Sequoia)

- [CONTROL] **Upper limit** ("hard limit past which charging is turned off") — enforced **safety minimum 50%** (cannot set lower).
- [CONTROL] **Lower limit** ("limit below which charging turns on") — enforced **safety minimum 20%**; note: not honored across cold boots/reboots.
- [CONTROL] **Disable Power Adapter** — cut power WITHOUT unplugging, to discharge on demand.
- [CONTROL] Option: **disable sleep while power adapter is disabled**.
- [CONTROL] Auto-behavior: **disables sleep while charging**, re-enables when charging stops.
- [CONTROL] **Commands** menu items (exact operations): Enable Power Adapter, Disable Power Adapter, **Request Full Charge (100%)**, **Charge to Upper Limit**, **Stop Charging Now**, **Pause background activity**, Disable background activity (for uninstall).
- [DISPLAY] Menu-bar extra shows current battery **charge %** and battery **health status** + quick commands.
- [CONTROL] Requires disabling macOS **Optimized Charging**; charges to 100% when powered off with charger attached; uses **IOPowerManagement** events + an **XPC privileged daemon** (codesigned) as the implementation model (relevant if you build parity).
Sources: github.com/mhaeuser/Battery-Toolkit (README), onmymenubar.app/battery-toolkit/.

---

## 4. BatFi — micropixels (rurza; open source, Swift; Apple Silicon, Ventura/Sonoma+)

- [CONTROL] **Custom Charge Limit**, held **indefinitely** (no ML guessing); **default 80%**.
- [CONTROL] **One-Click Charge to 100%** — menu command + assignable **global keyboard shortcut**.
- [CONTROL] **Run on Battery** mode — deliberately discharge with lid open (calibration/testing); "Inhibit charging on demand" + "Battery discharge on demand."
- [CONTROL] **System charging limit** integration on **macOS 15+** (uses Apple's native limit); also "Auto-pause charging on sleep" / activate system limit on sleep.
- [CONTROL] **Automation Rules** — ordered list, **first matching rule wins**; each rule gated by (a) **Schedule** (one-off date OR repeating days + time window) and (b) **Location** (map picker, address search, current-location, **adjustable radius**).
- [DISPLAY] Menu bar always shows **which rule is active** and its enforced limit.
- [CONTROL] Power-mode toggles from keyboard: **Low Power Mode / High Power Mode / Automatic**, each with assignable global hotkeys; Low Power Mode shows a **yellow icon background**.
- [DISPLAY] Battery/energy panel on icon click: **battery health %, cycle count, temperature, time-to-full, time remaining, power-usage graph, top energy-consuming apps.**
- [DISPLAY] Menu-bar icon options: **static icon**, hide icon entirely, show **% next to icon**, show **elapsed time**, **"Time Left"** label formatting, distinct **inhibited-charging icon**.
- [DISPLAY] **12-hour battery-percentage history chart**; "Last discharge time" and "Last full charge time."
- [CONTROL] **MagSafe LED**: green when charging paused at limit; blink-charger notification on discharge start.
- Notifications (exact triggers): alert when **charging mode changes**; **rule override** notification naming which rule + limit apply; **"Low Battery"** at an adjustable threshold; **battery-calibration reminder** after **30+ days without a discharge**.
- [DISPLAY] Reports temp "up to 40°C" range; App Intents/Siri Shortcuts support.
Sources: micropixels.software/apps/batfi, files.micropixels.software/batfi/BatFi-latest.html (changelog), github.com/rurza/BatFi.

---

## 5. Endurance — enduranceapp.com (closed source; runtime-extension utility, not a charge limiter)

- [CONTROL] **Slow Down Your Processor** — disables Intel **Turbo Boost** / limits CPU speed.
- [CONTROL] **Monitor Intense Apps** — detects energy-heavy apps (cites Chrome ~20% drain even when backgrounded) and **suspends** them, restoring tabs/state on reopen; supports Safari, Chrome, Firefox, Opera.
- [CONTROL] **Put Background Apps to Sleep** — auto-minimizes/suspends hidden apps.
- [CONTROL] **Auto-Dim Your Screen** — gradually lowers brightness over time (imperceptibly).
- [CONTROL] Pause background **Wi-Fi / Bluetooth / Spotlight**; block Flash.
- [DISPLAY/CONTROL] **Default activation at 70% charge** (prompts Low Power Mode); alternative trigger **on unplug**; all thresholds adjustable; each feature individually disable-able.
- [DISPLAY] Marketing metric: **~20% more runtime** (example: 4h25m → 5h13m) — could surface as an estimated "extended runtime" figure.
Sources: enduranceapp.com, setapp.com/apps/endurance, idownloadblog Endurance 3.0.

---

## 6. Battery Health 2 & Battery Health 3 — FIPLAB (Mac App Store)

Battery Health 3 (current) distinctive displays:
- [DISPLAY] **Power usage in Watts** (live).
- [DISPLAY] **Amperage (mA)** and **Voltage (mV)** live.
- [DISPLAY] **Battery age (years)** derived from manufacture date.
- [DISPLAY] **App energy-impact tracking** with **Process ID (PID)** column; **energy-hog detection + ranking**; **configurable energy thresholds**.
- [DISPLAY] **Historical charts**: Power-consumption history, Charge-level history, **Battery-health-degradation history**; period selectors **Day / Week / Month / Year**.
- [DISPLAY] Duration tracking: **On-battery duration**, **Fully-charged duration**, **Charging duration**.
- [DISPLAY] **iOS device monitoring** (iPhone/iPad over Wi-Fi or USB): connection type, current vs original max capacity, health %, cycle count, temperature, current draw (mAh).
- [DISPLAY] **Bluetooth accessory monitoring**: AirPods, Magic Keyboard, Mouse, Trackpad levels.
- [DISPLAY] Menu-bar: choose **% or time-remaining**; **red text when low**; auto light/dark; dockable corner-anchor position.
- Notifications: **low-battery**, **charging-threshold**, **fully-charged**, **on-battery-duration reminder**.

Battery Health 2 (older):
- [DISPLAY] Charge level, capacity, time remaining, power usage, cycle count.
- [DISPLAY] **Power History mode** (in-app purchase, $9.99) — history data + graphs.
- [DISPLAY] Menu-bar item "takes no more room than the stock battery"; earlier versions offered a **lightning-bolt icon option** (removed in v2 per reviews).
Sources: fiplab.com/apps/battery-health-3-for-mac, apps.apple.com/.../battery-health-2-stats-info/id1120214373.

---

## 7. WhatBattery — whatbattery.app (live-power monitor)

- [DISPLAY] **Watts in and out** (live charge/discharge wattage from SMC power rails).
- [DISPLAY] **Charger negotiation** string, e.g., **"58W of 96W"** (negotiated vs adapter max).
- [DISPLAY] **Voltage** + **Current** updated per second.
- [DISPLAY] **Health % to one decimal** (unrounded), computed from raw mAh.
- [DISPLAY] **Service condition** (Normal / Service Recommended).
- [DISPLAY] **Monthly health records** and **monthly cycle counts** tracked over years, per device.
- [DISPLAY] **Battery runway** — projected date battery reaches **80%** (replacement forecast); **wear-rate forecasting** with trend-deviation alerts.
- [DISPLAY] **Per-bud AirPods levels** + case level; keyboard/mouse/trackpad levels; per-accessory **time-till-empty** (Pro).
- [DISPLAY] Main-window tabs: **This Mac / iPhone-iPad / History / Accessories**; export **one-page PDF report** + **CSV/JSON**.
Sources: whatbattery.app.

---

## 8. BatteryBoi — thebarbican19 (open source; Intel + Apple Silicon, Big Sur→15)

- [DISPLAY] Replaces the stock menu-bar battery glyph with **time-remaining (h/m)**, falling back to **percentage** when estimate unavailable.
- [DISPLAY] **Bluetooth device battery levels** (AirPods, etc.) via System Information.
- Notifications: **"Beautiful" status-change notifications**; low-battery alerts; roadmap **Dynamic-Island-style modal** and **System-Colour charging alerts**.
- [DISPLAY] Dark mode (light mode roadmap); menu-bar **snap-to-position**.
- [CONTROL] Roadmap: **Low Power Mode toggle**, sound-effect toggles, custom keyboard shortcuts.
Source: github.com/thebarbican19/BatteryBoi.

---

## 9. AirBattery — lihaoyun6 (open source; likely the intended "Aes")

- [DISPLAY] Battery levels of **all Apple devices** — iPhone, iPad, Apple Watch, AirPods, Magic Mouse/Keyboard/Trackpad, and **other Macs** — in menu bar / Dock / desktop widget, **without installing anything on those devices**.
- [DISPLAY] **"Nearcast"** — track OTHER Macs and their gear over the local Wi-Fi network.
- Notification: alert when any tracked device drops **below a set threshold**.
Sources: github.com/lihaoyun6/AirBattery, macmenubar.com/airbattery.

---

## Cross-cutting "parity gaps" worth prioritizing (not already in Stats/coconut/iStat)

- [DISPLAY] **Live watts in/out** + **charger negotiated-vs-max wattage** ("58W of 96W") — WhatBattery, Battery Health 3.
- [DISPLAY] **Per-app energy drain list** with PID and ranking, and matching Apple "Using Significant Energy" behavior — Battery Health 3, BatFi, Apple.
- [DISPLAY] **Sankey power-flow diagram** — AlDente Power Flow (unique visualization).
- [DISPLAY] **Duration counters**: time-on-battery, time-plugged-fully-charged, time-charging — Battery Health 3, BatFi ("last discharge/last full charge").
- [DISPLAY] **Battery-replacement forecast / wear-rate trend** ("battery runway" to 80%) — WhatBattery.
- [DISPLAY] **Health-degradation-over-time chart** with Day/Week/Month/Year selectors — Battery Health 3.
- [DISPLAY] **Calibration reminder** ("30+ days without a full discharge") — BatFi.
- [DISPLAY] **Active-automation-rule indicator** + **4 distinct charging-state menu-bar icons** — BatFi, AlDente.
- [CONTROL] **Charge limit** (hard 20–100%), **Sailing/hysteresis band**, **Heat Protection (35°C)**, **Calibration cycle**, **Top Up**, **force-discharge while plugged**, **MagSafe LED color control**, **stop-charge-on-sleep / on-quit** — AlDente, Battery Toolkit, BatFi. All CONTROL: require SMC writes / a signed privileged helper daemon + admin auth, and on Apple Silicon are Ventura+ only. Battery Toolkit's enforced safety floors (upper ≥50%, lower ≥20%) are a good reference for safe defaults.
- [CONTROL] **Runtime-extension automation** (dim screen, throttle CPU/Turbo Boost, suspend browsers/background apps, pause Wi-Fi/BT/Spotlight, auto Low Power Mode at 70%) — Endurance (distinct product category from charge-limiting).
- [DISPLAY] **Multi-device / accessory battery aggregation** (per-AirPod buds + case, other Macs over Wi-Fi) — AirBattery, WhatBattery, Battery Health 3.

Primary sources: apphousekitchen.com (AlDente); github.com/mhaeuser/Battery-Toolkit; micropixels.software + github.com/rurza/BatFi; enduranceapp.com; fiplab.com (Battery Health 2/3); whatbattery.app; github.com/thebarbican19/BatteryBoi; github.com/lihaoyun6/AirBattery; Apple Support 102338 / 108376 / Battery Status menu guide.