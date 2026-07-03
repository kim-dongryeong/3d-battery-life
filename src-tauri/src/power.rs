// Event-driven power-source notifications (the same mechanism Stats uses): IOKit calls us the
// instant AC is plugged/unplugged or the charge state flips, instead of us waiting up to a full
// poll interval. We still poll on a timer for the continuously-changing values (watts, temp) — this
// just lets the tray react to plug/unplug within a few hundred ms. The callback only flips an
// atomic flag; the tray thread checks it between short sleeps and refreshes early when it's set.
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};

static DIRTY: AtomicBool = AtomicBool::new(false);
type Ref = *const c_void; // opaque CF/IOPS handles

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPSNotificationCreateRunLoopSource(cb: extern "C" fn(*mut c_void), ctx: *mut c_void) -> Ref;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRunLoopGetCurrent() -> Ref;
    fn CFRunLoopAddSource(rl: Ref, src: Ref, mode: Ref);
    fn CFRunLoopRun();
    static kCFRunLoopDefaultMode: Ref;
}

extern "C" fn on_change(_ctx: *mut c_void) {
    DIRTY.store(true, Ordering::Relaxed);
}

/// Spawn a dedicated thread that runs a CFRunLoop servicing IOPS power-source notifications.
/// Best-effort: if the source can't be created, the tray simply falls back to timer-only polling.
pub fn start_notifier() {
    std::thread::spawn(|| unsafe {
        let src = IOPSNotificationCreateRunLoopSource(on_change, std::ptr::null_mut());
        if src.is_null() {
            return;
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), src, kCFRunLoopDefaultMode);
        CFRunLoopRun(); // blocks this thread forever, delivering on_change() callbacks
    });
}

/// True at most once per power-source change since the last call (clears the flag).
pub fn take_dirty() -> bool {
    DIRTY.swap(false, Ordering::Relaxed)
}
