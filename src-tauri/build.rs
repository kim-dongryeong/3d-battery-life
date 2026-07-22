fn main() {
    tauri_build::build();

    // macOS: link ServiceManagement so smapp.rs can reach the SMAppService Obj-C class
    // (registers the bundle-embedded LaunchAgents so Settings > 백그라운드 앱 활동 groups them
    // under "Joule" instead of the signing developer name — see the BTM 지식노트). Gated on
    // CARGO_CFG_TARGET_OS (the actual build target, not the host) so a cross-build only links
    // it when targeting macOS.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-lib=framework=ServiceManagement");
    }
}
