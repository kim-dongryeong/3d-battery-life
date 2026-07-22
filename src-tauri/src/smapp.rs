// SMAppService (ServiceManagement, macOS 13+) wrapper — registers Joule's bundle-embedded
// LaunchAgents (Contents/Library/LaunchAgents/, shipped via tauri.conf.json bundle.macOS.files)
// through the official API, so macOS attributes the Settings > 백그라운드 앱 활동 row to
// "Joule" (app name + icon) instead of the code-signing developer name.
//
// Why this exists (see the "macOS 백그라운드 앱 활동(BTM)…" 지식노트, confirmed via
// `sfltool dumpbtm` on this exact app): a hand-installed `~/Library/LaunchAgents` plist is a BTM
// "legacy agent" whose Parent Identifier (= the Settings-app row name) is ALWAYS the developer
// name, no matter what `AssociatedBundleIdentifiers` you add — that key only fixes the icon/
// association, never the grouping. Only a plist embedded in the app bundle and registered via
// SMAppService gets grouped under the app itself.
//
// Every call here is best-effort: failures are logged to stderr only, never panic — a broken
// registration must not stop Joule from starting.
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::msg_send;
use objc2_foundation::{NSError, NSString};

// SMAppServiceStatus raw values (ServiceManagement/SMAppService.h) — confirmed against Apple's
// SMAppService.Status enum cases (notRegistered/enabled/requiresApproval/notFound) and a shipped
// third-party Tauri+objc2 SMAppService integration using these same values.
#[allow(dead_code)]   // kept for API completeness (full SMAppServiceStatus enum) — no caller needs the "off" value explicitly, only the enabled/requiresApproval/notFound ones
pub const STATUS_NOT_REGISTERED: i64 = 0;
pub const STATUS_ENABLED: i64 = 1;
pub const STATUS_REQUIRES_APPROVAL: i64 = 2;
pub const STATUS_NOT_FOUND: i64 = 3;

fn sm_class() -> Option<&'static AnyClass> {
    AnyClass::get(c"SMAppService")
}

// +[SMAppService agentServiceWithPlistName:] — `plist_name` must be the exact filename (with
// .plist extension) of a LaunchAgent embedded at Contents/Library/LaunchAgents/ in THIS app's
// bundle. Apple: "The property list name must correspond to a property list in the calling app's
// Contents/Library/LaunchAgents directory."
fn agent(plist_name: &str) -> Option<Retained<AnyObject>> {
    let cls = sm_class()?;
    let name = NSString::from_str(plist_name);
    // SAFETY: `agentServiceWithPlistName:` is a class factory method returning an autoreleased
    // `SMAppService*`; objc2 takes ownership per ARC conventions via the `Option<Retained<_>>`
    // return type. `name` is a valid NSString alive across the call.
    unsafe { msg_send![cls, agentServiceWithPlistName: &*name] }
}

fn ns_err_desc(err: &NSError) -> String {
    // SAFETY: `localizedDescription` is a standard NSError getter returning an autoreleased
    // NSString, only read here.
    let desc: Retained<NSString> = unsafe { msg_send![err, localizedDescription] };
    desc.to_string()
}

/// Register (enable) the bundle-embedded agent `plist_name`. Idempotent — registering an
/// already-registered service succeeds. On success the agent starts per its `RunAtLoad`/
/// `StartInterval`/`KeepAlive` keys; `requiresApproval` also counts as a successful registration
/// (the user just needs to flip it on in Settings > Login Items — see [`status`]).
/// Errors are logged only (never panics).
pub fn sm_register(plist_name: &str) {
    let Some(obj) = agent(plist_name) else {
        eprintln!("[smapp] SMAppService 클래스를 찾을 수 없음 (register {plist_name}) — macOS 13+ 필요");
        return;
    };
    // SAFETY: `-registerAndReturnError:` returns BOOL with a trailing NSError**; the `_` marker
    // activates objc2's BOOL→Result<(), Retained<NSError>> bridging.
    let res: Result<(), Retained<NSError>> = unsafe { msg_send![&*obj, registerAndReturnError: _] };
    if let Err(e) = res {
        eprintln!("[smapp] register({plist_name}) 실패: {}", ns_err_desc(&e));
    }
}

/// Unregister (disable) the agent — removes it from Login Items and unloads the launchd job.
/// A redundant unregister (already not registered) is reported by macOS as success, so this is
/// idempotent too. Errors are logged only (never panics).
pub fn sm_unregister(plist_name: &str) {
    let Some(obj) = agent(plist_name) else {
        eprintln!("[smapp] SMAppService 클래스를 찾을 수 없음 (unregister {plist_name}) — macOS 13+ 필요");
        return;
    };
    // SAFETY: as `sm_register`, for `-unregisterAndReturnError:`.
    let res: Result<(), Retained<NSError>> = unsafe { msg_send![&*obj, unregisterAndReturnError: _] };
    if let Err(e) = res {
        eprintln!("[smapp] unregister({plist_name}) 실패: {}", ns_err_desc(&e));
    }
}

/// The agent's current `SMAppServiceStatus` as one of the `STATUS_*` constants above. Read-only —
/// safe to call at startup / on every tray tick without mutating anything. Returns
/// `STATUS_NOT_FOUND` if the SMAppService class itself can't be resolved (should never happen on
/// macOS 13+, but this must never panic).
pub fn sm_status(plist_name: &str) -> i64 {
    let Some(obj) = agent(plist_name) else { return STATUS_NOT_FOUND };
    // SAFETY: `-status` is a property getter returning NSInteger.
    let s: isize = unsafe { msg_send![&*obj, status] };
    s as i64
}
