COMPETITIVE FEATURE INVENTORY — macOS battery menu-bar apps (features NOT already covered by Stats / coconutBattery / iStat Menus). Each item tagged [DISPLAY] = read-only, we can implement freely, or [CONTROL] = writes hardware / power state, needs privileged helper / SMC / IOKit power-management entitlement. Sources cited per app at end of each block.

════════════════════════════════════════
1) APPLE BUILT-IN — macOS menu-bar battery + System Settings ▸ Battery
════════════════════════════════════════
Menu-bar item (Control Center "Battery" module):
- [DISPLAY] Battery glyph fills to charge level; lightning bolt overlaid when on AC; a small plug/"charged" state when 100% on AC.
- [DISPLAY] Optional "Show Percentage" toggle next to icon (System Settings ▸ Control Center ▸ Battery). On Tahoe/Sequoia this moved to Control Center "Other Modules".
- [DISPLAY] Click-menu header shows estimated "Time to Full" when charging ("X hours until full") and, historically, "Time Remaining" on battery (Apple removed the always-on time estimate years ago; now shown only in the dropdown, not the bar).
- [DISPLAY] "Battery is charging" / "Battery is charged" / "Power Source: Power Adapter/Battery" line.
- [DISPLAY] "Apps Using Significant Energy" list right inside the battery dropdown (per-app names; click to reveal in Activity Monitor). This is a native per-app drain readout most trackers omit.
- [CONTROL] "Low Power Mode" toggle appears directly in the dropdown on some macOS versions.
Notifications (native, NOT user-tunable):
- [DISPLAY] Low-battery alert fires at ~10% (and a second nudge near ~5%); thresholds are fixed and cannot be changed to 20%/80% without 3rd-party software.
- [DISPLAY] "Optimized Battery Charging" notification "Charging on Hold — Your Mac won't charge past 80% to prolong battery lifespan" / "…will finish charging by [time]".
System Settings ▸ Battery pane (these graphs are the distinctive part — richer than iStat's simple history):
- [DISPLAY] Two tabs: "Last 24 Hours" and "Last 10 Days".
- [DISPLAY] "Battery Level" graph (24h only): average charge in 15-minute increments; green shading + lightning-bolt marks show when plugged in/charging.
- [DISPLAY] "Screen On Usage" bar graph: minutes-per-hour (24h view, minutes on right axis) or hours-per-day (10-day view).
- [DISPLAY] "Energy Usage" bar graph (10-day view) — relative daily energy consumed.
- [DISPLAY] "Battery Health" status: "Normal" vs "Service Recommended"; plus "Maximum Capacity" percentage.
- [CONTROL] "Optimized Battery Charging" on/off.
- [CONTROL] Native charge-limit control (macOS Sonoma 14 / Sequoia 15): Battery Health ▸ Charging shows "80% Limit" / "Optimized" / "None" (or a slider on some builds) — Apple's own AlDente-style cap.
- [CONTROL] "Low Power Mode" dropdown with 4 states: "Never", "Always", "Only on Battery", "Only on Power Adapter".
Sources: https://support.apple.com/guide/mac-help/mchlp1115/mac , https://support.apple.com/guide/mac-help/change-battery-settings-mchlfc3b7879/mac , https://apple.fandom.com/wiki/Battery_(System_Preferences) , https://osxdaily.com/2025/10/21/how-to-show-battery-percent-in-menu-bar-of-macos-tahoe/ , https://getjuicy.app/blog/how-to-set-custom-battery-alerts-mac/

════════════════════════════════════════
2) BATTERY MONITOR (Bresink — the classic "Battery Monitor" menu-bar app)
════════════════════════════════════════
Menu-bar icon behaviors (distinctive, configurable):
- [DISPLAY] Icon "continuously visualizes the current charge level" as a filling bar (not just Apple's discrete glyph).
- [DISPLAY] Bar "switches to a red bar indicator" when the Mac is running on reserve power — a built-in low-charge color threshold in the icon itself.
- [DISPLAY] Menu-bar display options: "Show battery status in menu bar", "Show percentage", "Show percentage only, suppressing battery icon" (text-only mode), and "Remove Dock icon".
Dropdown menu contents:
- [DISPLAY] Line 1 = short battery-health summary sentence.
- [DISPLAY] "Estimated remaining time until the battery is either empty or full."
- [DISPLAY] Current power source line.
- [DISPLAY] Bluetooth device charge-state summary for connected battery-powered BT devices (in the menu).
- [DISPLAY] Quick items: "Show Overview Window", "Show Percentage" toggle, "Suppress Battery Icon", energy-control navigation.
Note: Bresink explicitly does NOT show per-app energy (defers to Apple). No amperage/voltage/temp in the bar itself.
Source: https://www.bresink.com/osx/0BatteryMonitor/Docs-en/pgs/0035-MenuBar.html

════════════════════════════════════════
3) BATTERY HEALTH 2 / BATTERY HEALTH 3 (FIPLAB)  — mostly [DISPLAY]
════════════════════════════════════════
Menu-bar:
- [DISPLAY] Menu-bar text can show either charge percentage OR time-remaining next to the icon (user picks). "Takes up no more room than the stock battery report."
- [DISPLAY] Menu-bar text turns RED when charge drops low (built-in low-charge color threshold).
Charge / battery detail fields (exact labels & sample values from BH3):
- [DISPLAY] "Charge: 4350 / 5000 mAh 87%" (current/max mAh + %).
- [DISPLAY] "Health: 92%" plus a health-status word.
- [DISPLAY] "Cycles: 247".
- [DISPLAY] "Temperature: 34.2 °C" (Celsius/Fahrenheit selectable).
- [DISPLAY] "Power Usage: 12.4 W" (instantaneous wattage).
- [DISPLAY] "Voltage: 11,420 mV".
- [DISPLAY] "Amperage: -1,086 mA" (negative = discharging — a signed live current field).
- [DISPLAY] "Time Remaining", current/original mAh, manufacture date.
Power History (paid unlock — distinctive graphing):
- [DISPLAY] Three chart types — power consumption, charge levels, and health history — each with Day / Week / Month / Year period selector; a timeline of charging vs battery power.
- [DISPLAY] "Energy Hogs" list: apps with highest energy impact, shown with process IDs (per-app drain).
Extra device monitoring:
- [DISPLAY] iPhone/iPad battery over Wi-Fi or USB (cycle count, health %, temp, manufacture date).
- [DISPLAY] Bluetooth accessory battery (AirPods, peripherals).
Notifications (configurable — beats Apple's fixed 10%):
- [DISPLAY] Low-battery threshold alert (user-set %), charging-threshold alerts, "fully charged" alert, and an "on-battery duration" reminder ("you've been on battery for N hours").
Sources: https://fiplab.com/apps/battery-health-3-for-mac , https://apps.apple.com/us/app/battery-health-2-stats-info/id1120214373 , https://support.fiplab.com/battery-health-3/getting-started

════════════════════════════════════════
4) ENDURANCE (enduranceapp.com) — battery-EXTENDER, almost all [CONTROL]
════════════════════════════════════════
Distinctive because it ACTS to save power rather than just reporting:
- [CONTROL] "Slow Down Your Processor" — turns OFF Intel Turbo Boost to cut power (Intel Macs). User can forbid it entirely.
- [CONTROL] "Auto-Dim Your Screen" — gradually dims brightness over time, slow enough to be unnoticed.
- [CONTROL] Background-app throttling — "hides"/minimizes hidden apps and slows apps that chew CPU when not in use.
- [CONTROL] Reduce animations / disable power-hungry features when triggered.
- [CONTROL] Activation threshold: kicks in when battery drops below a user-set level; DEFAULT trigger ≈ 70% charge; also an "activate on unplug" mode; each module can be toggled independently; manual vs automatic activation.
Displayed metrics / claims:
- [DISPLAY] Estimated runtime gain "~20% more" with concrete example "4 h 25 m → 5 h 13 m".
- [DISPLAY] Per-app battery-usage callout (e.g. "Chrome ~20% battery usage") to justify throttling.
Notification:
- [DISPLAY] Prompt when battery crosses the designated activation level.
Sources: https://enduranceapp.com/ , https://setapp.com/apps/endurance , https://getjuicy.app/directory/mac-battery-apps/endurance/
(NOTE: I could not find any distinct macOS battery app named "Aes" — no product by that name surfaced. If "Aes" was shorthand, the closest real apps in that niche are Endurance above and the wattage cluster in §8.)

════════════════════════════════════════
5) AlDente Pro (AppHouseKitchen) — the reference "charge-limit" app; heavy [CONTROL]
════════════════════════════════════════
Core charge control:
- [CONTROL] "Charge Limiter" (free): cap max charge; slider or typed %, range 20–100% (recommended 50–80%). Pauses charging at limit.
- [CONTROL] "Discharge" (free): actively drains battery down to the limit WHILE plugged in.
- [CONTROL] "Automatic Discharge" (Pro): auto-discharges whenever current % > set limit on AC.
- [CONTROL] "Top Up": temporarily raises limit to 100%, auto-reverts to previous limit once unplugged.
- [CONTROL] "Sailing Mode": defines a lower re-charge threshold band (recommend ~5–10% below limit) to stop constant micro-charging.
- [CONTROL] "Calibration Mode": scripted cycle — charge→100%, discharge→10%, recharge→100%, hold 1 hour, return to limit; suggested cadence "every 3 weeks" (always plugged) to "4–6 weeks" (infrequent).
- [CONTROL] "Heat Protection": halts charging when battery temp exceeds a user threshold (Apple-recommended ~35 °C) with a 5-minute-countdown hysteresis to avoid flapping.
- [CONTROL] "Stop Charging when Sleeping"; "Disable Sleep until Charge Limit"; "Stop Charging when App Closed" (Apple-Silicon only — cap survives quitting the app, resets to 100% only on power-off).
- [CONTROL] "Control MagSafe LED": force LED color — green = limit reached, orange = charging/discharging; MagSafe 3 static or blinking orange during discharge; MagSafe 2 alternating orange/green during discharge. (Unique hardware-LED control.)
Displayed metrics:
- [DISPLAY] "Hardware Battery Percentage" — reads the actual BMS %, "typically differs from macOS by 2–7%" (more accurate than OS %).
- [DISPLAY] Real-time stats: battery health, design capacity, maximum capacity, cycle count, temperature.
- [DISPLAY] "Power Flow" — real-time Sankey diagram of energy from charger/battery → MacBook + charging system, WITH wattage and power-source labels (distinctive live power-flow viz).
- [DISPLAY] "Live Status Icons": four distinct charging-state icons in the menu bar (power source + activity).
Menu-bar & UX:
- [DISPLAY] Full menu-bar icon customization: show/hide %, pick icon style from many options.
- Single-click menu shows the current limit + quick "Discharge" and "Top Up" buttons.
Automation / integration:
- [CONTROL] "Schedule": 5 task types (Set Charge Limit / Start Calibration / Top Up / Pause Charging / Discharge to), repeat Daily/Weekdays/Weekly/Biweekly/Monthly/Never, executes up to 10 min after set time, with task history.
- [CONTROL] Apple Shortcuts: ~15 actions — Get Battery Percentage, Get Charge Limit, Get State (Charging/Pause/Sailing/Discharging/Topup/HeatProtect/Calibration/Exit), Get Temperature, Pause Charging, Set Charge Limit, Set MagSafe LED (green/orange/blinking orange/off), Start Calibration, Start Discharge, Top Up, High Power Mode toggle.
- [CONTROL] Fast User Switching support (per-user limits).
Sources: https://apphousekitchen.com/aldente-overview/features/ , https://apphousekitchen.com/aldente-overview/ , https://thesweetbits.com/tools/aldente-pro-review/

════════════════════════════════════════
6) BatFi (rurza/BatFi — open source, github.com/rurza/BatFi) — [CONTROL] + rich [DISPLAY]
════════════════════════════════════════
Charge control:
- [CONTROL] "Custom Charge Limit, Held Indefinitely" — DEFAULT 80%; holds while on AC.
- [CONTROL] "Charge to 100%" on demand — from menu click OR a global keyboard shortcut.
- [CONTROL] "Run on Battery" — deliberately runs on battery with the lid OPEN (forces discharge without unplugging).
- [CONTROL] "Automatically pause charging when the Mac goes to sleep".
- [CONTROL] Toggle Low Power Mode / High Power Mode / Automatic — each without opening System Settings, each assignable to a global hotkey (menu-bar power-mode switcher is distinctive).
Automation rules (most distinctive vs competitors — location + time):
- [CONTROL] Time-based rules: one-off dates OR repeating days with time windows.
- [CONTROL] Location-based rules: map picker + address search + "current location", with adjustable radius (e.g. limit to 80% at the office, 100% before leaving home).
- [CONTROL] Ordered rule list — "the top rule that matches right now wins".
- [DISPLAY] Menu bar always shows WHICH rule is active and the limit it's enforcing; when an automation overrides the usual limit, BatFi names the rule + limit.
Displayed metrics (from status icon panel):
- [DISPLAY] Battery health, cycle count, temperature, "Time to Full", "Time Remaining", a power-usage graph, and an "apps using significant energy" list.
Notifications:
- [DISPLAY] "Charging mode changes" alerts; automation-rule-override notifications; battery-calibration-cycle reminders.
Requirements/notes: Apple Silicon + macOS Sonoma+, admin password for the privileged helper; localized 14 languages; opt-in crash reporting.
Sources: https://github.com/rurza/BatFi , https://micropixels.software/apps/batfi , https://github.com/rurza/BatFi/issues/86

════════════════════════════════════════
7) Battery Toolkit (mhaeuser/Battery-Toolkit — open-source, BSD-3, ARCHIVED read-only Mar 2026) — [CONTROL]
════════════════════════════════════════
- [CONTROL] Upper charge limit: charging turns OFF above it; enforced minimum 50% (safety floor).
- [CONTROL] Lower charge limit: charging turns ON only below it; enforced minimum 20% (safety floor). (Two-threshold hysteresis band — differs from single-cap AlDente.)
- [CONTROL] Menu-bar commands: "Enable/Disable Power Adapter", "Request Full Charge", "Charge to Limit", "Stop Charging", "Pause/Disable Background Activity".
- [CONTROL] "Disable the power adapter" without unplugging — for on-desk battery recalibration/discharge.
- [CONTROL] Setting "Disable sleeping when the power adapter is disabled".
- [CONTROL] Behavior: sleep auto-disabled while charging, re-enabled when charging stops; cold-boot/reboot IGNORES the lower limit and charges straight to upper limit; requires macOS "Optimized Battery Charging" turned OFF to work.
- [DISPLAY] Menu-bar extra shows current battery status (charging state / limit).
Architecture note (relevant if we clone it): privileged daemon + login item (macOS Ventura SMAppService), XPC with codesign-based auth — the safe pattern for our own charge-control helper.
Sources: https://github.com/mhaeuser/Battery-Toolkit , https://github.com/mhaeuser/Battery-Toolkit/blob/main/README.md , https://onmymenubar.app/battery-toolkit/

════════════════════════════════════════
7b) AlDente ALTERNATIVES worth cloning:
════════════════════════════════════════
- OpenDente (killerk3emstar/OpenDente) — open-source AlDente clone, charge-limit menu-bar tool. [CONTROL]. https://github.com/killerk3emstar/OpenDente
- BatteryBoi (thebarbican19/BatteryBoi) — open-source menu-bar battery INDICATOR replacement. Shipped: [DISPLAY] % or estimated time-remaining (hh:mm, falls back to % when estimate unavailable); [DISPLAY] connected Bluetooth-device battery levels pulled from System Information; [DISPLAY] "beautiful notifications"; dark-mode. Roadmap (documents intended feature-set to match): system-color charging-icon alerts, Low Power Mode toggle, sound-effects toggle, battery-replacement tracking, menu-bar position customization, custom keyboard shortcuts, IF/THEN conditional automations. https://github.com/thebarbican19/BatteryBoi

════════════════════════════════════════
8) DISCHARGE-RATE / WATTAGE menu-bar cluster (the "watts in the menu bar" niche — all [DISPLAY], strong parity targets)
════════════════════════════════════════
- WhatBattery (free, open source): [DISPLAY] LIVE charge AND discharge wattage ("watts in and out"), voltage, temperature; health % to one decimal; cycle count; max capacity mAh; service condition "Normal / Service Recommended"; distinctive "Charger wattage negotiated" field e.g. "58W of 96W" (shows adapter-negotiated power vs adapter rating); charging-session records; menu-bar dropdown lists health/charge/cycles/temp/power + connected Bluetooth accessory levels; Pro adds per-accessory menu-bar readout, accessory time-till-empty, low-battery alerts. https://www.whatbattery.app/
- MoniThor: [DISPLAY] real-time power DRAW in watts directly in the menu-bar text (shows both charge and discharge wattage as a signed/live number); battery panel = charge %, health %, cycle count, voltage, time-remaining, charging state; user-selectable refresh interval 1 / 2 / 5 seconds. https://monithor.dev/guides/mac-charging-wattage
- WattSec: [DISPLAY] real-time system power consumption in watts in the menu bar.
- Watts (macupdate): [DISPLAY] advanced battery data beyond the usual, menu-bar app.
- Battery Guru (macdaddy.io): [DISPLAY] real-time discharge/charge with live watt AND milliamp draw in the menu bar; cycle count + runtime monitor.
- Bettery ($9.99): [DISPLAY] comprehensive battery data incl. power consumption in watts in the menu bar.
- PowerTop (scavin/powertop, open source): [DISPLAY] native Apple-Silicon menu-bar real-time power monitoring (battery required). https://github.com/scavin/powertop
Sources: https://onmymenubar.app/blog/best-mac-battery-health-apps-for-your-menu-bar/ , https://macdaddy.io/mac-battery-guru/ , https://watts.macupdate.com/

════════════════════════════════════════
FEATURE-PARITY CHECKLIST — grouped for our roadmap (dedup of the above; each tagged)
════════════════════════════════════════
MENU-BAR ICON STYLES (implementable, [DISPLAY]):
- Filling-bar icon that visualizes exact charge level, going RED on reserve power (Bresink).
- Text-only mode: percentage-only, no glyph (Bresink, AlDente).
- Menu-bar text turns RED at low charge (Battery Health).
- Show time-remaining (hh:mm) instead of % next to icon (Battery Health, BatteryBoi, Bresink).
- Live WATTAGE as the menu-bar text (MoniThor, WattSec, Battery Guru, Bettery, WhatBattery).
- Four distinct charging-state icons (source + activity) (AlDente "Live Status Icons").
- Menu bar shows active automation rule + enforced limit as text (BatFi).
UNIQUE METRICS ([DISPLAY]):
- Signed live amperage "-1,086 mA" (Battery Health); live voltage "11,420 mV"; instantaneous watts "12.4 W".
- Live charge vs discharge wattage separately + adapter-negotiated "58W of 96W" (WhatBattery).
- Hardware/BMS true % vs macOS % (2–7% delta) (AlDente).
- Power-Flow Sankey diagram with wattage + source (AlDente).
- Apple energy graphs: Battery Level (15-min), Screen-On-Usage, Energy-Usage over Last 24h / Last 10 Days (Apple).
- Per-app "Energy Hogs" with PID (Battery Health), "Apps Using Significant Energy" (Apple/BatFi), per-app drain (Endurance).
- Time-on-battery / on-battery-duration counter + reminder (Battery Health, AlDente shortcuts).
NOTIFICATION TYPES ([DISPLAY]):
- User-settable low-battery % (vs Apple's fixed 10%/5%) (Battery Health, WhatBattery).
- Charging-threshold reached / "fully charged" alert (Battery Health).
- Charging-mode-changed alert (BatFi).
- Automation-rule-override alert naming rule+limit (BatFi).
- Calibration-cycle-due reminder (BatFi, AlDente).
- On-battery-duration reminder (Battery Health, AlDente).
- "Charging on Hold …will finish by [time]" Optimized-Charging notice (Apple).
CONTROL FEATURES (need privileged helper / SMC — [CONTROL]):
- Single charge cap 20–100% held indefinitely (AlDente, BatFi default 80%, OpenDente).
- Two-threshold hysteresis band, floors 50%/20% (Battery Toolkit).
- Force discharge on AC / "Run on Battery" lid-open / disable power adapter without unplugging (AlDente, BatFi, Battery Toolkit).
- Top-Up-to-100 then auto-revert on unplug (AlDente, BatFi).
- Sailing Mode / re-charge band (AlDente).
- Calibration cycle automation (AlDente).
- Heat-protection charge cutoff at temp threshold (~35 °C) w/ 5-min hysteresis (AlDente).
- Stop charging when sleeping / when app closed; disable sleep until limit (AlDente, BatFi, Battery Toolkit).
- MagSafe LED color control (AlDente) — hardware LED.
- Location-based + time-based charge-limit automation rules (BatFi) — most distinctive.
- Menu-bar Low/High/Automatic Power Mode toggle + global hotkey (BatFi).
- Native Apple charge-limit 80%/Optimized (Apple, Sonoma+).
- Energy-extender actions: disable Turbo Boost, auto-dim, throttle/hide background apps, at a % trigger (Endurance, default ~70%).
- Apple-Shortcuts / App-Intents surface for all of the above (AlDente ~15 actions, BatFi App Intents).

CAVEAT: "Aes" did not resolve to any real macOS battery app in searches — treat as unidentified; the intended app is most likely Endurance (covered) or one of the wattage-cluster apps in §8.