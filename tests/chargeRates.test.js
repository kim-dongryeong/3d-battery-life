// 충전기 프로필별 충전 통계 + 어댑터 식별 테스트 — `npm test` (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAdapter, adapterTech } from '../lib/battery.js';
import { chargerKey } from '../lib/adapters.js';
import { chargeStats, ratesWithFallback, classKey, energyBalanceETA } from '../lib/chargeRates.js';

// ── parseAdapter: 2026-07-10 이 맥에서 실측한 원문 그대로 ──────────────────────────────
const IOREG_15W = `  "AdapterDetails" = {"IsWireless"=No,"AdapterID"=10,"AdapterVoltage"=5000,"FamilyCode"=18446744073172697097,"AdapterPowerTier"=1,"Watts"=15,"UsbHvcHvcIndex"=255,"Current"=3000,"PMUConfiguration"=3000,"UsbHvcMenu"=()}`;
// PD 충전기 합성 예: UsbHvcMenu에 중첩 dict(제공 프로필)가 있어 flat regex는 여기서 깨진다
const IOREG_PD = `  "AdapterDetails" = {"AdapterID"=30183,"AdapterVoltage"=20000,"FamilyCode"=18446744073172697098,"Watts"=96,"Current"=4700,"Name"="96W USB-C Power Adapter","Manufacturer"="Apple Inc.","UsbHvcMenu"=({"Index"=1,"MaxVoltage"=9000,"MaxCurrent"=3000},{"Index"=2,"MaxVoltage"=15000,"MaxCurrent"=3000},{"Index"=3,"MaxVoltage"=20000,"MaxCurrent"=4700}),"UsbHvcHvcIndex"=3}`;
const IOREG_OFF = `  "AdapterDetails" = {"FamilyCode"=0,"Watts"=0}`;

test('parseAdapter: 15W USB-C 5V (실측 원문)', () => {
  const a = parseAdapter(IOREG_15W);
  assert.equal(a.watts, 15);
  assert.equal(a.voltage, 5);
  assert.equal(a.current, 3);
  assert.equal(a.adapterId, 10);
  assert.equal(a.familyCode, 'e0004009');   // kIOPSFamilyCodeUSBCTypeC (5V 계약, 비-PD)
  assert.equal(a.tech, 'usbc-5v');
  assert.equal(a.name, null);
  assert.deepEqual(a.hvcMenu, []);
});

test('parseAdapter: PD 충전기 — 중첩 UsbHvcMenu까지 파싱', () => {
  const a = parseAdapter(IOREG_PD);
  assert.equal(a.familyCode, 'e000400a');   // kIOPSFamilyCodeUSBCPD
  assert.equal(a.tech, 'usbc-pd');
  assert.equal(a.name, '96W USB-C Power Adapter');
  assert.equal(a.manufacturer, 'Apple Inc.');
  assert.equal(a.voltage, 20);
  assert.deepEqual(a.hvcMenu, [{ v: 9, a: 3 }, { v: 15, a: 3 }, { v: 20, a: 4.7 }]);
  assert.equal(a.hvcIndex, 3);
});

test('parseAdapter: 분리 상태 → null · adapterTech 매핑', () => {
  assert.equal(parseAdapter(IOREG_OFF), null);
  assert.equal(parseAdapter('no adapter here'), null);
  assert.equal(adapterTech('e000400a'), 'usbc-pd');
  assert.equal(adapterTech('e0004008'), 'usbc-5v');   // USBCBrick도 5V 클래스
  assert.equal(adapterTech('e0004003'), 'usb');
  assert.equal(adapterTech('e0024000'), 'dedicated');
  assert.equal(adapterTech('0'), null);
});

test('chargerKey: 지문 + 부분 키(과거 데이터)', () => {
  assert.equal(chargerKey({ adapterWnom: 15, adapterVnom: 5, familyCode: 'e0004009', adapterId: 10 }), '15W@5V/e0004009#10');
  assert.equal(chargerKey({ adapterWnom: 15, adapterVnom: 5 }), '15W@5V/?#?');   // 소급 부분 키
  assert.equal(chargerKey({}), null);
  assert.equal(chargerKey(null), null);
});

// ── chargeStats: 15W(0.3%/min) vs 96W(1.2%/min) 합성 세션이 프로필별로 분리되는가 ─────────
const RAWMAX = 4000;
function chargeRun({ t0, pct0, pct1, ratePctMin, adapter }) {
  const out = [];
  const minutes = Math.round((pct1 - pct0) / ratePctMin);
  for (let m = 0; m <= minutes; m++) {
    const pct = pct0 + ratePctMin * m;
    out.push({ t: t0 + m * 60, charging: true, ac: true, pct: Math.round(pct),
      rawCap: Math.round(RAWMAX * pct / 100), rawMax: RAWMAX, systemW: 8, ...adapter });
  }
  return out;
}
const SLOW = { adapterWnom: 15, adapterVnom: 5, familyCode: 'e0004009', adapterId: 10 };
const FAST = { adapterWnom: 96, adapterVnom: 20, familyCode: 'e000400a', adapterId: 30183 };
const SLOW_KEY = '15W@5V/e0004009#10', FAST_KEY = '96W@20V/e000400a#30183';

test('chargeStats: 프로필별 밴드 속도 분리 + 어댑터 교체는 쌍 단위 귀속', () => {
  const samples = [
    ...chargeRun({ t0: 1000000, pct0: 30, pct1: 60, ratePctMin: 0.3, adapter: SLOW }),
    { t: 1200000, charging: false, ac: false, pct: 55, rawCap: 2200, rawMax: RAWMAX },   // 사이 간극(제외 쌍)
    ...chargeRun({ t0: 1300000, pct0: 30, pct1: 60, ratePctMin: 1.2, adapter: FAST }),
  ];
  const st = chargeStats(samples);
  assert.ok(st.profiles[SLOW_KEY] && st.profiles[FAST_KEY]);
  const b40s = st.profiles[SLOW_KEY].byBand[40], b40f = st.profiles[FAST_KEY].byBand[40];
  assert.ok(Math.abs(b40s - 0.3) < 0.02, `slow 40밴드 ${b40s}`);
  assert.ok(Math.abs(b40f - 1.2) < 0.08, `fast 40밴드 ${b40f}`);
  const g = st.global.byBand[40];
  assert.ok(g > b40s && g < b40f, 'global은 둘 사이 pooled');
  assert.ok(Math.abs(st.avgSysChargeW - 8) < 0.01, `충전 중 시스템 평균 ${st.avgSysChargeW}`);   // 물리 추정의 기준값
  // 클래스 분리: usbc-5v:≤20W vs usbc-pd:71W+
  assert.ok(st.classes[classKey(SLOW)] && st.classes[classKey(FAST)]);
});

test('ratesWithFallback: 프로필 → 클래스 → 전체 계층', () => {
  const samples = chargeRun({ t0: 1000000, pct0: 30, pct1: 60, ratePctMin: 0.3, adapter: SLOW });
  const st = chargeStats(samples);
  // 이력 있는 충전기 → profile 계층
  const r1 = ratesWithFallback(st, SLOW_KEY, classKey(SLOW));
  assert.equal(r1.tierByBand[40], 'profile');
  // 이력 없는 다른 충전기 → 그 클래스도 없음 → global 폴백
  const r2 = ratesWithFallback(st, FAST_KEY, classKey(FAST));
  assert.equal(r2.tierByBand[40], 'global');
  assert.equal(r2.totalMin, 0);
  // 같은 클래스의 다른 개체(AdapterID만 다름) → class 계층
  const sibling = { ...SLOW, adapterId: 99 };
  const r3 = ratesWithFallback(st, chargerKey(sibling), classKey(sibling));
  assert.equal(r3.tierByBand[40], 'class');
});

// ── energyBalanceETA: 고정점 스캔 · 레짐 · 완충 불가 ───────────────────────────────────
function sysHistory(nowT, hours, w) {   // 지난 `hours`시간 동안 분당 systemW=w
  const out = [];
  for (let m = hours * 60; m >= 1; m--) out.push({ t: nowT - m * 60, systemW: w });
  return out;
}

test('energyBalanceETA: 어댑터 포화 → 자기일관 창, E/P와 일치', () => {
  const nowT = 2000000;
  const live = { charging: true, t: nowT, rawCap: 2000, rawMax: 4000, voltage: 12,
    adapterW: 14.5, systemW: 9, adapterWnom: 15 };
  const eb = energyBalanceETA({ samples: sysHistory(nowT, 8, 9), live });   // 80%까지
  assert.equal(eb.regime, 'adapter-limited');
  assert.ok(eb.feasible);
  // E = 1200mAh×12V/0.92 = 15.65Wh · P = 14.5−9 = 5.5W → 170.8분
  assert.ok(Math.abs(eb.minutes - 171) <= 3, `minutes ${eb.minutes}`);
  assert.equal(eb.window, 3);   // |180−171|이 최소인 창
});

test('energyBalanceETA: 배터리 제한(큰 충전기) → 현재 수지 그대로', () => {
  const nowT = 2000000;
  const live = { charging: true, t: nowT, rawCap: 2000, rawMax: 4000, voltage: 12,
    adapterW: 40, systemW: 9, adapterWnom: 96 };
  const eb = energyBalanceETA({ samples: sysHistory(nowT, 8, 9), live });
  assert.equal(eb.regime, 'battery-limited');
  assert.equal(eb.window, null);
  // P = 40−9 = 31W → 15.65Wh/31W = 30.3분
  assert.ok(Math.abs(eb.minutes - 30) <= 2, `minutes ${eb.minutes}`);
});

test('energyBalanceETA: 공급 ≤ 소비 → 완충 불가(feasible=false)', () => {
  const nowT = 2000000;
  const live = { charging: true, t: nowT, rawCap: 2000, rawMax: 4000, voltage: 12,
    adapterW: 14.5, systemW: 15, adapterWnom: 15 };
  const eb = energyBalanceETA({ samples: sysHistory(nowT, 8, 15), live });
  assert.equal(eb.feasible, false);
  assert.equal(eb.minutes, null);
});

test('energyBalanceETA: 미충전/입력 결측 → null', () => {
  assert.equal(energyBalanceETA({ samples: [], live: { charging: false } }), null);
  assert.equal(energyBalanceETA({ samples: [], live: { charging: true, rawCap: 1, rawMax: 4000, voltage: 12, adapterW: null, systemW: 9 } }), null);
});
