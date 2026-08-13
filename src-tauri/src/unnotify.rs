// Actionable macOS battery-alert notifications via UNUserNotificationCenter (UserNotifications
// framework), replacing `osascript "display notification"` for the three battery alerts so each
// one can carry a real button — "이 알림 끄기" ("turn this alert off") — that flips the matching
// cfg key (low_pct / high_pct) to 0 without opening the app.
//
// osascript notifications cannot have buttons at all, hence this module. The updater's
// notifications (main.rs) keep using the old osascript path unchanged — only the three battery
// alerts route through here (with an osascript fallback if UN is unavailable/denied).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AnyThread};
use objc2_foundation::{NSBundle, NSObject, NSObjectProtocol, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationAction, UNNotificationActionOptions, UNNotificationCategory,
    UNNotificationCategoryOptions, UNNotificationPresentationOptions, UNNotificationRequest,
    UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};

#[derive(Clone, Copy, PartialEq)]
pub enum Alert {
    Low,
    High,
}

impl Alert {
    fn category_id(self) -> &'static str {
        match self {
            Alert::Low => "JOULE_LOW",
            Alert::High => "JOULE_HIGH",
        }
    }
    fn cfg_key(self) -> &'static str {
        match self {
            Alert::Low => "low_pct",
            Alert::High => "high_pct",
        }
    }
}

const ACTION_DISABLE: &str = "JOULE_DISABLE";

// Set once init() confirms the bundle-id guard AND authorization resolves true (either via the
// requestAuthorization completion, or the getNotificationSettings query — whichever lands first).
static AUTHORIZED: AtomicBool = AtomicBool::new(false);
// Set once init() has confirmed we have a bundle id and it's safe to call into UN at all — this
// is what gates every other UN call, independent of whether the user has granted permission.
static UN_USABLE: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
// Authorization is answered ASYNCHRONOUSLY (both the request and the settings query call back off
// this thread), so right after launch `available()` is still false even for an already-granted app.
// That matters because the ticker can fire an alert on its very first tick — e.g. relaunching while
// the battery is already past the charge threshold — which would fall back to the button-less
// osascript path purely because we asked too early. RESOLVED flips once an answer (either callback)
// has landed, so callers can wait for a verdict instead of racing it.
static RESOLVED: AtomicBool = AtomicBool::new(false);
// The delegate must outlive the process — leaked deliberately (via mem::forget in init(), never
// dropped) since UNUserNotificationCenter only holds a WEAK reference to its delegate. Not kept
// in a static because `ProtocolObject<dyn UNUserNotificationCenterDelegate>` isn't `Sync`.

pub fn available() -> bool {
    UN_USABLE.load(Ordering::Relaxed) && AUTHORIZED.load(Ordering::Relaxed)
}
// Has the (async) authorization question been answered yet? Callers wait on this before deciding
// to fall back — see RESOLVED above. Always true once init() bailed on the bundle-id guard.
pub fn resolved() -> bool {
    RESOLVED.load(Ordering::Relaxed)
}

fn clear_alert_cfg(kind: Alert) {
    let path = crate::live::cfg_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // MUST merge, not overwrite: the node server (and this writer) both read-modify-write the
    // same tray.json, and a Cfg struct serialized back would silently drop/normalize any keys
    // it doesn't know about. So we parse as a generic Value, touch only our one key, and rewrite.
    let mut v: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !v.is_object() {
        v = serde_json::json!({});
    }
    v[kind.cfg_key()] = serde_json::json!(0);
    let tmp = path.with_extension("json.tmp");
    if let Ok(s) = serde_json::to_string(&v) {
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn ns(s: &str) -> Retained<NSString> {
    NSString::from_str(s)
}

// Build a plain (no category/button) confirmation content — posted after the user taps
// "이 알림 끄기" so they get feedback that it actually took effect.
fn post_plain(title: &str, body: &str) {
    let content = unsafe { UNMutableNotificationContent::new() };
    content.setTitle(&ns(title));
    content.setBody(&ns(body));
    content.setSound(Some(&*unsafe { UNNotificationSound::defaultSound() }));
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let req = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &ns(&format!("joule-confirm-{id}")),
        &content,
        None,
    );
    let center = unsafe { UNUserNotificationCenter::currentNotificationCenter() };
    center.addNotificationRequest_withCompletionHandler(&req, None);
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and Delegate implements no Drop logic
    // that would violate define_class!'s Drop rules.
    #[unsafe(super(NSObject))]
    #[name = "JouleUNDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            // Still show banner+sound even while Joule is the frontmost app.
            completion_handler.call((
                UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::Sound,
            ));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive_response(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let action_id = unsafe { response.actionIdentifier() }.to_string();
            if action_id == ACTION_DISABLE {
                let category_id = unsafe {
                    response.notification().request().content().categoryIdentifier()
                }
                .to_string();
                if category_id == Alert::Low.category_id() {
                    clear_alert_cfg(Alert::Low);
                    post_plain("알림을 껐어요", "배터리 부족 알림을 껐습니다 — 메뉴바 설정에서 다시 켤 수 있어요.");
                } else if category_id == Alert::High.category_id() {
                    clear_alert_cfg(Alert::High);
                    post_plain("알림을 껐어요", "충전 완료 알림을 껐습니다 — 메뉴바 설정에서 다시 켤 수 있어요.");
                }
            }
            completion_handler.call(());
        }
    }
);

impl Delegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

fn build_action() -> Retained<UNNotificationAction> {
    unsafe {
        UNNotificationAction::actionWithIdentifier_title_options(
            &ns(ACTION_DISABLE),
            &ns("이 알림 끄기"),
            UNNotificationActionOptions::empty(), // background action — does not foreground the app
        )
    }
}

fn build_category(cat_id: &str) -> Retained<UNNotificationCategory> {
    let actions = objc2_foundation::NSArray::from_retained_slice(&[build_action()]);
    let intents = objc2_foundation::NSArray::<NSString>::new();
    unsafe {
        UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
            &ns(cat_id),
            &actions,
            &intents,
            UNNotificationCategoryOptions::empty(),
        )
    }
}

// Bundle-id guard: UNUserNotificationCenter::currentNotificationCenter() raises an Objective-C
// exception (aborts the process) when the running executable has no bundle identifier, i.e. the
// bare debug binary rather than Joule.app. Every other UN call in this module is gated behind
// UN_USABLE, which this sets.
fn has_bundle_id() -> bool {
    unsafe { NSBundle::mainBundle().bundleIdentifier() }.is_some()
}

pub fn init() {
    if !has_bundle_id() {
        eprintln!("[notify] 번들 id 없음 — UN 사용 불가, osascript로 폴백");
        RESOLVED.store(true, Ordering::Relaxed);   // verdict is final: no UN here, don't make callers wait
        return; // leaves UN_USABLE/AUTHORIZED false — post() will report unavailable and callers fall back
    }
    UN_USABLE.store(true, Ordering::Relaxed);

    let center = unsafe { UNUserNotificationCenter::currentNotificationCenter() };

    let delegate = Delegate::new();
    let proto: Retained<ProtocolObject<dyn UNUserNotificationCenterDelegate>> =
        ProtocolObject::from_retained(delegate);
    center.setDelegate(Some(&proto));
    std::mem::forget(proto); // keep alive for process lifetime (leaked deliberately; center holds only a weak ref)

    let categories = NSSet::from_retained_slice(&[
        build_category(Alert::Low.category_id()),
        build_category(Alert::High.category_id()),
    ]);
    center.setNotificationCategories(&categories);

    // Ask for permission. The completion runs async off-thread — record the result.
    let handler = block2::RcBlock::new(move |granted: objc2::runtime::Bool, _err: *mut objc2_foundation::NSError| {
        if granted.as_bool() {
            AUTHORIZED.store(true, Ordering::Relaxed);
        }
        eprintln!("[notify] 권한 요청 결과: {}", if granted.as_bool() { "허용" } else { "거부" });
        RESOLVED.store(true, Ordering::Relaxed);
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
        &handler,
    );

    // Also query existing settings in case authorization was already granted in a previous run —
    // requestAuthorization's completion won't re-fire "granted" for an already-decided prompt
    // fast enough for the first alert otherwise.
    let settings_handler = block2::RcBlock::new(move |settings: std::ptr::NonNull<objc2_user_notifications::UNNotificationSettings>| {
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        eprintln!("[notify] 기존 권한 상태: {status:?}");
        if status == objc2_user_notifications::UNAuthorizationStatus::Authorized
            || status == objc2_user_notifications::UNAuthorizationStatus::Provisional
        {
            AUTHORIZED.store(true, Ordering::Relaxed);
            RESOLVED.store(true, Ordering::Relaxed);
        } else if status != objc2_user_notifications::UNAuthorizationStatus::NotDetermined {
            // Denied — final answer. (NotDetermined means the prompt above is still pending, so we
            // leave RESOLVED alone and let the requestAuthorization completion settle it.)
            RESOLVED.store(true, Ordering::Relaxed);
        }
    });
    center.getNotificationSettingsWithCompletionHandler(&settings_handler);
}

pub fn post(kind: Alert, title: &str, body: &str) -> bool {
    if !available() {
        eprintln!("[notify] UN 불가(usable={} authorized={}) — osascript로 폴백: {title}",
            UN_USABLE.load(Ordering::Relaxed), AUTHORIZED.load(Ordering::Relaxed));
        return false;
    }
    eprintln!("[notify] UN으로 발송(버튼 포함): {title}");
    let content = unsafe { UNMutableNotificationContent::new() };
    content.setTitle(&ns(title));
    content.setBody(&ns(body));
    content.setSound(Some(&*unsafe { UNNotificationSound::defaultSound() }));
    content.setCategoryIdentifier(&ns(kind.category_id()));
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let req = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &ns(&format!("joule-alert-{id}")),
        &content,
        None, // nil trigger = deliver immediately
    );
    let center = unsafe { UNUserNotificationCenter::currentNotificationCenter() };
    center.addNotificationRequest_withCompletionHandler(&req, None);
    true
}
