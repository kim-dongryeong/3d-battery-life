// Minimal read-only AppleSMC client. Unlike the AppleSmartBattery ioreg node (which macOS refreshes
// only ~every 60s), SMC keys update in real time — so this gives a LIVE battery temperature and
// system power draw. Best-effort: any failure returns None and callers fall back to ioreg.
// Verified keys on Apple Silicon: PSTR (system total W), PDTR (adapter/DC-in W),
// TB0T/TB1T/TB2T (battery temp °C). PPBR is the battery DISCHARGE power ("PBus (BMON) Batt Dischg
// Power", per acidanthera/VirtualSMC) — it reads the real drain on battery but collapses to ~0 while
// charging, so it is NOT the charge power. We derive signed battery power from the energy balance
// PDTR−PSTR (see lib/battery.js applyLiveSMC), not PPBR. Struct layout matches the classic smc.c protocol.
#![allow(non_snake_case, non_upper_case_globals)]
use std::ffi::c_void;

#[repr(C)] #[derive(Clone, Copy)] struct Vers { major: u8, minor: u8, build: u8, reserved: u8, release: u16 }
#[repr(C)] #[derive(Clone, Copy)] struct PLimit { version: u16, length: u16, cpuPLimit: u32, gpuPLimit: u32, memPLimit: u32 }
#[repr(C)] #[derive(Clone, Copy)] struct KeyInfo { dataSize: u32, dataType: u32, dataAttributes: u8 }
#[repr(C)] #[derive(Clone, Copy)]
struct KeyData {
    key: u32, vers: Vers, pLimitData: PLimit, keyInfo: KeyInfo,
    result: u8, status: u8, data8: u8, data32: u32, bytes: [u8; 32],
}
impl Default for KeyData { fn default() -> Self { unsafe { std::mem::zeroed() } } }

const KERNEL_INDEX_SMC: u32 = 2;
const READ_BYTES: u8 = 5;
const READ_KEYINFO: u8 = 9;

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOServiceMatching(name: *const i8) -> *mut c_void;
    fn IOServiceGetMatchingService(mainPort: u32, matching: *mut c_void) -> u32;
    fn IOServiceOpen(service: u32, owningTask: u32, r#type: u32, connect: *mut u32) -> i32;
    fn IOServiceClose(connect: u32) -> i32;
    fn IOObjectRelease(object: u32) -> i32;
    fn IOConnectCallStructMethod(c: u32, sel: u32, inp: *const c_void, inpc: usize, out: *mut c_void, outc: *mut usize) -> i32;
}
extern "C" { static mach_task_self_: u32; }

fn fourcc(s: &str) -> u32 { let b = s.as_bytes(); (b[0] as u32) << 24 | (b[1] as u32) << 16 | (b[2] as u32) << 8 | b[3] as u32 }
fn typ(t: u32) -> [u8; 4] { t.to_be_bytes() }

pub struct Smc { conn: u32 }

impl Smc {
    pub fn open() -> Option<Smc> {
        unsafe {
            let m = IOServiceMatching(b"AppleSMC\0".as_ptr() as *const i8);
            if m.is_null() { return None; }
            let dev = IOServiceGetMatchingService(0, m);
            if dev == 0 { return None; }
            let mut conn = 0u32;
            let r = IOServiceOpen(dev, mach_task_self_, 0, &mut conn);
            IOObjectRelease(dev);
            if r != 0 { None } else { Some(Smc { conn }) }
        }
    }

    fn call(&self, inp: &KeyData) -> Option<KeyData> {
        unsafe {
            let mut out = KeyData::default();
            let mut sz = std::mem::size_of::<KeyData>();
            let r = IOConnectCallStructMethod(self.conn, KERNEL_INDEX_SMC,
                inp as *const _ as *const c_void, std::mem::size_of::<KeyData>(),
                &mut out as *mut _ as *mut c_void, &mut sz);
            // Reject a short/truncated reply: the driver must return the full SMCKeyData_t or we
            // could act on a structurally-incomplete response across the unsafe FFI boundary.
            if r != 0 || sz != std::mem::size_of::<KeyData>() || out.result != 0 { None } else { Some(out) }
        }
    }

    pub fn read_f64(&self, key: &str) -> Option<f64> {
        if key.len() != 4 { return None; }   // fourcc indexes b[0..4]; guard so a bad key can't panic the ticker
        let mut i = KeyData::default(); i.key = fourcc(key); i.data8 = READ_KEYINFO;
        let info = self.call(&i)?;
        let (size, dtype) = (info.keyInfo.dataSize, info.keyInfo.dataType);
        if size == 0 || size > 32 { return None; }   // SMC payload is SMCBytes_t[32] — reject a bogus width
        let mut i2 = KeyData::default(); i2.key = fourcc(key); i2.data8 = READ_BYTES; i2.keyInfo.dataSize = size;
        let out = self.call(&i2)?;
        let b = &out.bytes;
        // Require the declared type's byte width so a misreported key can't decode zero-padding as a real value.
        let v = match &typ(dtype) {
            b"flt " if size >= 4 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64,
            b"sp78" if size >= 2 => (i16::from_be_bytes([b[0], b[1]]) as f64) / 256.0,
            b"sp87" if size >= 2 => (i16::from_be_bytes([b[0], b[1]]) as f64) / 128.0,
            b"fp88" if size >= 2 => (u16::from_be_bytes([b[0], b[1]]) as f64) / 256.0,
            _ if size == 4 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64,
            _ if size == 2 => u16::from_be_bytes([b[0], b[1]]) as f64,
            _ => return None,
        };
        if v.is_finite() { Some(v) } else { None }
    }

    // Mean of the battery temperature sensors (TB0T/TB1T/TB2T), whichever exist.
    pub fn battery_temp_c(&self) -> Option<f64> {
        let mut sum = 0.0; let mut n = 0;
        for k in ["TB0T", "TB1T", "TB2T"] {
            if let Some(v) = self.read_f64(k) { if v > 0.0 && v < 120.0 { sum += v; n += 1; } }
        }
        if n > 0 { Some((sum / n as f64 * 10.0).round() / 10.0) } else { None }
    }
    // Live system power draw in Watts (PSTR) — moves second to second, unlike ioreg.
    pub fn system_watts(&self) -> Option<f64> {
        self.read_f64("PSTR").filter(|v| *v >= 0.0 && *v < 500.0).map(|v| (v * 100.0).round() / 100.0)
    }
    pub fn adapter_watts(&self) -> Option<f64> {
        self.read_f64("PDTR").filter(|v| *v >= 0.0 && *v < 500.0).map(|v| (v * 100.0).round() / 100.0)
    }
    // Battery DISCHARGE power in Watts (PPBR = "PBus (BMON) Batt Dischg Power"). Accurate on battery,
    // but ~0 while charging (charge flows the other way), so it is NOT the charge power. Still written
    // to the bridge for reference; the signed battery power is derived from PDTR−PSTR in battery.js.
    pub fn battery_watts(&self) -> Option<f64> {
        self.read_f64("PPBR").filter(|v| *v >= 0.0 && *v < 500.0).map(|v| (v * 100.0).round() / 100.0)
    }
}

impl Drop for Smc { fn drop(&mut self) { unsafe { IOServiceClose(self.conn); } } }
