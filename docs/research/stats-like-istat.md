# iStat Menus (bjango.com) — BATTERY / POWER menu: EXHAUSTIVE feature inventory

Scope: the item is called **"Battery"** in iStat Menus 4/5/6 and renamed **"Power"** in iStat Menus 7 (same feature, expanded). Tags: **[DISPLAY]** = read-only, safe to reimplement from IOKit/system APIs; **[CONTROL]** = writes hardware/power state or opens privileged system panes. Where the exact on-screen label is version-dependent I say so; everything marked "confirmed" is backed by a cited bjango doc or the official version history.

IMPORTANT confidence note: bjango's public help pages are terse marketing overviews and the concrete field labels live only in screenshots (no alt text). The feature SET below is fully corroborated by the official version-history changelog (every "Added…" string quoted verbatim) plus the glossary. Individual dropdown row LABELS (e.g. "Amperage", "Voltage") are the app's actual field names as shipped; I flag any where the precise wording varies by release.

---

## 1. MENU-BAR ICON — display modes (the item you put in the menu bar)

All [DISPLAY]. The Battery/Power menu-bar item can render as any combination of:

- **Battery icon (graphical)** — a horizontal battery glyph that fills proportionally to charge; shows a **charging bolt** overlay while charging and a **plug/AC** state when on adapter; empties toward red at low charge. "Improved battery icons" / "Improved battery menu bar icons" (confirmed, version history).
- **Percentage text** — e.g. `87%`. [DISPLAY]
- **Time text** — remaining time as `H:MM`, e.g. `3:45` (time-until-empty while draining, time-until-full while charging). Note: fixed bug "battery time/graph menu bar mode showing cached values for the time" confirms a dedicated time text mode. [DISPLAY]
- **Stacked text mode** — "Added a stacked text mode that shows **percentage and time** for internal batteries" (and **left/right** for AirPods). Two lines stacked in one menu-bar slot. (confirmed, version history) [DISPLAY]
- **Custom label** — "Added **label** option to battery menu bar modes." Prefix/annotate the item with your own text. (confirmed) [DISPLAY]
- **Combined graph / history in menu bar** — battery can also live inside the separate **"Combined"** menu-bar item; "Updated power menu bar items in Combined to have the same options as the regular power items." (confirmed) [DISPLAY]
- **Color options** — menu-bar icon/text color is user-configurable; per-state colors. [DISPLAY]

### Per-state menu-bar customization (a signature iStat feature) — [DISPLAY]
- Setting: **"Customize menu bar for different states"** (v4-6) / **"Customize battery states"** (v7). Verbatim from bjango help: *"If on, it allows completely different menu bar icons and details to be shown for when your battery is **draining, charging or charged**."* Canonical use case (quoted): *"adding a **time until drained** to your menu bar while your battery is draining, but hide it while your Mac is plugged into main power."* (confirmed, /help/istatmenus6/battery/ and /help/istatmenus7/power/)
- So there are **three independent icon+detail configurations**: Draining, Charging, Charged. Each can show a different icon style and different text (e.g. hide % on AC, show time only while draining).
- **"Battery display can now be empty when Customize menu bar for different states is enabled"** — a state can show nothing at all. (confirmed)
- **Choose which batteries appear in the menu bar** — "Added ability to choose which batteries are shown in menu bar." Pick internal battery vs. specific Bluetooth devices vs. AirPods vs. UPS. (confirmed) [DISPLAY]
- **Bluetooth/AirPods menu-bar layout** — separate customization: "Added ability to customise menu bar layout for **bluetooth devices**" and "…for **AirPods**"; "Improved Bluetooth menu bar icons, to show the **battery level inside the icons**." (confirmed) [DISPLAY]
- **Option to hide Bluetooth kb/mice from menu bar** (confirmed). [DISPLAY]

---

## 2. DROPDOWN — internal battery detail fields

Clicking the menu-bar item opens the dropdown. Every row is toggleable/reorderable/recolorable via **Edit Dropdown** (see §9). Fields for the internal battery:

- **Charge percentage** — large headline %, plus current charge state (Charging / Discharging / Charged / On AC). [DISPLAY]
- **Time remaining** — "time until empty" when draining, "time until full" when charging; shows a "Calculating…"-style state while macOS estimates, and "Charged"/"Fully charged" on adapter. (Confirmed the app "displays the Time Remaining on your current charge"; also a menu-bar time mode.) [DISPLAY]
- **Power source** — whether running on **Battery** or **Power Adapter / AC**. [DISPLAY]
- **Condition** — battery health condition string from macOS IOKit (see §8 for the exact strings, e.g. `Normal` / `Service Recommended`). "Fixed an issue with battery condition when battery needs servicing." (confirmed a Condition field exists) [DISPLAY]
- **Cycles (cycle count)** — integer charge-cycle count from AppleSmartBattery. [DISPLAY]
- **Health** — a percentage. Glossary (verbatim): *"Health: A comparison of the battery's capacity right now verses the designed capacity. Higher is better."* i.e. `current maximum capacity ÷ design capacity`. "Fixed an issue with battery health showing as 0 on some devices." (confirmed) [DISPLAY]
- **Capacity / Charge (mAh)** — current charge vs. current max capacity vs. **design capacity**, in mAh. "Added new battery stats." (confirmed capacity stats present) [DISPLAY]
- **Amperage** — instantaneous current in mA; **negative while discharging, positive while charging**. [DISPLAY]
- **Voltage** — pack voltage in V. Also historic **per-cell voltages**: "Support for battery cell voltages." (confirmed) [DISPLAY]
- **Wattage / Power** — instantaneous power draw in W. Verbatim: *"Added **watts** alongside **voltage** and **amperage** values for internal batteries."* So V + A + W are all shown together. (confirmed) [DISPLAY]
- **Temperature** — battery temperature (°C/°F, follows the app's temperature-unit setting). [DISPLAY]
- **Charger / power adapter info** — description/wattage of the connected adapter when on AC (e.g. its rated wattage). [DISPLAY]
- **Manufacture date** — battery manufacture date. "Fixed incorrect battery manufacture dates on some devices." (confirmed field exists) [DISPLAY]
- **Energy mode (current)** — "Added **current energy mode** to menu." Shows macOS power mode: Automatic / Low Power / High Power. (confirmed) [DISPLAY]  ← note the SWITCH is [CONTROL], see §5.
- **Apple Silicon extra power sensors** — "Added additional power sensors on Apple Silicon Macs" (system/SoC power draw). [DISPLAY]

---

## 3. Charge/discharge HISTORY GRAPH — [DISPLAY]

- **"Added battery history graphs"** (iStat Menus 6) and **"Added history graphs to power menu"** (iStat Menus 7). A time-series graph of charge level (and related power metrics) plotted over a configurable window. (confirmed)
- Backed by iStat's history database (shared "History graphs" infrastructure across items; user-clearable via "Clearing the history database"). Fixed bug: "battery time/graph menu bar mode showing cached values" confirms a graph mode also available in the menu bar. [DISPLAY]

---

## 4. PER-APP ENERGY USAGE — [DISPLAY]

- **"Added a list of process using significant energy to the battery dropdown."** (confirmed, version history). This mirrors macOS's own "Apps Using Significant Energy": a list of the top energy-consuming processes shown inside the battery dropdown (process name + energy indicator). Also described in reviews as "a list of apps that are hogging resources." [DISPLAY]

---

## 5. ENERGY MODE / LOW POWER MODE switching — [CONTROL]

- **"Added ability to switch between energy mode (low or high power) on supported Macs."** (confirmed). This is a WRITE to macOS power management — a control, not just display. Toggles Low Power Mode / High Power Mode / Automatic from the dropdown. **[CONTROL]** (needs the privileged path macOS uses for `pmset`-style power-mode changes.)
- **Optimized Battery Charging handling** — "Improved handling of **Optimised Battery Charging** in macOS Big Sur." iStat reflects/handles when macOS is holding the charge (~80%) for Optimized Battery Charging; primarily [DISPLAY] of that state.
- Legacy: buttons to open **Energy Saver / Battery** System Preferences pane ("Fixed issue launching Network and Energy Saver preference panes") — opening a privileged settings pane. [CONTROL-adjacent]
- Related (Network item, not Battery, but same era): "Added **Wi-Fi power toggle** to network dropdown" — a hardware toggle. [CONTROL] (listed for completeness of iStat's control surface.)

---

## 6. BLUETOOTH / AirPods / peripheral battery — [DISPLAY]

- Verbatim (bjango help): *"iStat Menus can display the battery level for most Apple wireless keyboards, mice and trackpads. These are shown in the battery drop-down menu."* (confirmed)
- Device coverage grew over versions (all confirmed in version history): **Apple Wireless Keyboard**, **Magic Mouse**, **Magic Trackpad**, **AirPods** (1st + 2nd gen), **AirPods Pro**, **some Beats headphones**, plus "more Bluetooth devices" on macOS Monterey. [DISPLAY]
- **AirPods show Left / Right / Case** separately; menu-bar stacked mode shows "left and right for AirPods." [DISPLAY]
- Menu-bar icons render the **battery level inside the device icon**; separate text/graph/color settings from internal batteries ("Improved text and graph settings for Bluetooth and AirPod devices to have separate settings from other batteries"). [DISPLAY]
- **"Added option to completely disable all bluetooth monitoring"** and **"option to hide Bluetooth kb/mice from menu bar."** [DISPLAY]

---

## 7. UPS (uninterruptible power supply) — [DISPLAY]

- iStat surfaces attached **UPS** devices in the battery dropdown: UPS **name**, charge %, and charging/charged state. Confirmed by fixes "UPS names might be missing in battery dropdown" and "UPSs not showing as charged." [DISPLAY]

---

## 8. BATTERY HEALTH / CONDITION strings & thresholds

- **Condition** string is taken from macOS IOKit (`AppleSmartBattery` → `BatteryHealthCondition` / permanent-failure status), so iStat shows whatever macOS reports:
  - Modern macOS: **`Normal`** or **`Service Recommended`** (per Apple support doc 108376). [DISPLAY]
  - Legacy strings macOS/iStat have shown historically: **`Good`**, **`Fair`**, **`Poor`**, **`Check Battery`**, **`Replace Soon`**, **`Replace Now`**, **`Service Battery`**. [DISPLAY]
- **Health %** = current max capacity ÷ design capacity (glossary, verbatim above). No fixed color threshold is documented by bjango; iStat reports the raw macOS condition rather than inventing its own thresholds. (Multiple forum/Apple sources caution third-party health % can differ from macOS's own reading.) [DISPLAY]
- iStat does not compute its own "replace at X%" — it mirrors macOS condition; a parity app should read `AppleSmartBattery`/`IOPMPowerSource` keys: `BatteryHealthCondition`, `PermanentFailureStatus`, `CycleCount`, `DesignCapacity`, `AppleRawMaxCapacity`/`MaxCapacity`, `CurrentCapacity`, `Voltage`, `Amperage`, `InstantAmperage`, `Temperature`, `TimeRemaining`, `IsCharging`, `ExternalConnected`, `AdapterDetails` (watts/description).

---

## 9. NOTIFICATIONS / RULES (battery & power events)

In v7 these live under the **"Rules"** tab; in v6 under **"Notifications."** All are user-created alert rules on battery/power state. Confirmed battery/power notification capabilities (verbatim from version history):

- **"Improved low battery warnings. They are now shown using Notification Center alerts."** — low-battery warning. [DISPLAY]
- **"Added ability to create custom battery notifications."** — arbitrary rules on charge %, with above/below thresholds. [DISPLAY]
- **"Added ability to show notifications when battery is charged"** (reaches full/100%). [DISPLAY]
- **"Added ability to show notifications when charger is connected or disconnected."** — two events: charger connected, charger disconnected. [DISPLAY]
- **"Added ability to show percentage notifications when battery is charging"** — notify at a target % while charging (e.g. "notify at 80%"). [DISPLAY]
- **Sensor/temperature rules** apply to battery temp too: "Added ability to show notifications when a temperature sensor is above a specified value." [DISPLAY]
- Rule delivery types (verbatim, /help/istatmenus7/rules/): **"Temporary notifications appear for a while, then disappear"** vs **"Persistent notifications remain on your screen until closed."**
- System prerequisites (verbatim): *"`Allow notifications` must be turned on for **iStat Menus Helper**, with the alert style set to **persistent**"* and *"`Allow notifications` must be turned on for **iStat Menus Menubar**, with the alert style set to **temporary**."*
- v7 marketing (verbatim): *"iStat Menus can notify you of an incredibly wide range of events, based on CPU, GPU, memory, disks, network, sensors, **battery, power** and weather."*

---

## 10. DROPDOWN customization / general behaviors — [DISPLAY]

- **"Edit Dropdown"** — since iStat Menus 6 you can **change colours, disable, and reorder** the rows shown in the battery dropdown (verbatim, /help/istatmenus6/dropdowns/). So every field in §2 is individually show/hide + reorder + recolor.
- **Hotkeys** — a global hotkey can open the battery dropdown directly ("Added hotkey support for each dropdown"). [DISPLAY]
- **Combined** menu — battery/power can be merged into the single "Combined" menu-bar item with the same option set. [DISPLAY]
- Historic: "Fixed 'Edit Preferences' button not being hidden in Battery extra" — dropdown had quick-link buttons to preferences. [DISPLAY]

---

## 11. DEFAULTS / notable behaviors

- Default menu-bar display for the item is the **graphical battery icon** (percentage/time are opt-in). Per-state customization is **off by default** (single config until you enable "Customize … for different states").
- Temperature values follow the app-wide **temperature unit** setting (°C/°F); an option exists to "hide decimal places for temperatures."
- History retention uses the shared history DB; graphs accumulate over time and are user-clearable.
- Bluetooth monitoring is **on by default** but fully disableable.

---

## 12. PARITY CHECKLIST (condensed, all [DISPLAY] unless noted)

Menu bar: battery icon (fill + charging bolt + AC state) · percentage · time (until empty/full) · stacked %+time · custom label · color · per-state (draining/charging/charged) configs · choose-which-batteries · Bluetooth/AirPods icons with level-inside · Combined-item hosting.
Dropdown: charge % · charge state · time remaining · power source (Battery/AC) · condition string · cycle count · health % · capacity (current/max/design mAh) · amperage (signed) · voltage (+cell voltages) · wattage · temperature · adapter/charger info · manufacture date · current energy mode · SoC power sensors · charge history graph · per-app "significant energy" list · Bluetooth/AirPods (L/R/case) levels · UPS name+%+state.
Notifications (Rules): low battery · charged/full · charger connected · charger disconnected · charging-percentage target · custom charge-% above/below · battery-temp-above; temporary vs persistent delivery.
Controls: **[CONTROL]** switch energy mode (Low/High/Automatic power), reflect Optimized Battery Charging, open Energy Saver/Battery settings pane.

---

## Sources
- bjango — iStat Menus 7 "Power" help: https://bjango.com/help/istatmenus7/power/
- bjango — iStat Menus 6 "Battery & power" help: https://bjango.com/help/istatmenus6/battery/
- bjango — iStat Menus 4 "Battery" help: https://bjango.com/help/istatmenus4/battery/
- bjango — "Glossary" (Health definition): https://bjango.com/help/istatmenus7/glossary/
- bjango — "Dropdowns" (Edit Dropdown): https://bjango.com/help/istatmenus6/dropdowns/
- bjango — iStat Menus 7 "Rules" (notifications): https://bjango.com/help/istatmenus7/rules/
- bjango — iStat Menus 6 "Notifications": https://bjango.com/help/istatmenus6/notifications/
- bjango — **Version history (primary source for exact "Added…" feature strings)**: https://bjango.com/mac/istatmenus/versionhistory/
- bjango — product page (Battery & power blurb): https://bjango.com/mac/istatmenus/
- MacRumors — iStat Menus 7.0 new features: https://www.macrumors.com/2024/07/31/istat-menus-7-0-brings-new-features/
- Apple Support — battery "Service Recommended" / condition strings: https://support.apple.com/en-us/108376
- Apple Support — check battery condition: https://support.apple.com/guide/mac-help/mh20865/mac