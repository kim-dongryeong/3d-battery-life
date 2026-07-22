// 내 충전기·보조배터리 통계 테스트 — `npm test` (node --test). chargeRates.test.js와 같은 패턴.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateChargers } from '../lib/chargerStats.js';

const SLOW = { adapterWnom: 15, adapterVnom: 5, familyCode: 'e0004009', adapterId: 10 };
const FAST = { adapterWnom: 96, adapterVnom: 20, familyCode: 'e000400a', adapterId: 30183 };
const SLOW_KEY = '15W@5V/e0004009#10', FAST_KEY = '96W@20V/e000400a#30183';

// t0에서 시작해 60초 간격 n+1개 샘플(ac 연결) 생성. adapterW가 주어지면 매 샘플에 기록.
function acRun({ t0, n, adapter, adapterW, stepSec = 60 }) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    out.push({ t: t0 + i * stepSec, ac: true, charging: true,
      adapterW: adapterW == null ? null : adapterW, ...adapter });
  }
  return out;
}

test('1) 단일 충전기 60s 간격 연속 쌍 → minutes 정확, energyWh 사다리꼴 소수1 일치', () => {
  // 5쌍(6샘플) × 60s = 300s = 5분. adapterW 10→20W로 선형 증가 → 사다리꼴 합
  const samples = [];
  const t0 = 1_000_000;
  const ws = [10, 12, 14, 16, 18, 20];
  for (let i = 0; i < ws.length; i++) samples.push({ t: t0 + i * 60, ac: true, adapterW: ws[i], ...SLOW });
  const [row] = aggregateChargers(samples);
  assert.equal(row.key, SLOW_KEY);
  assert.equal(row.minutes, 5);
  // 손계산: 각 쌍 60s, 평균 W = (10+12)/2,(12+14)/2,...  → Σ = 11+13+15+17+19 = 75 → Wh = 75*60/3600 = 1.25
  let expWh = 0;
  for (let i = 1; i < ws.length; i++) expWh += (ws[i - 1] + ws[i]) / 2 * 60;
  expWh = +(expWh / 3600).toFixed(1);
  assert.equal(row.energyWh, expWh);
  assert.equal(row.maxW, 20);
});

test('2) adapterW 결측(앱 미실행) 쌍 → minutes는 집계, maxW/avgW/energyWh는 null', () => {
  const samples = acRun({ t0: 2_000_000, n: 4, adapter: SLOW, adapterW: null });
  const [row] = aggregateChargers(samples);
  assert.equal(row.minutes, 4);
  assert.equal(row.maxW, null);
  assert.equal(row.avgW, null);
  assert.equal(row.energyWh, null);
});

test('3) dt>3600s(sleep) 및 dt<=0(중복 타임스탬프) 쌍 제외', () => {
  const t0 = 3_000_000;
  const samples = [
    { t: t0, ac: true, adapterW: 10, ...SLOW },
    { t: t0 + 60, ac: true, adapterW: 10, ...SLOW },          // 정상 쌍(60s) → 1분
    { t: t0 + 60 + 4000, ac: true, adapterW: 10, ...SLOW },   // 4000s 공백(sleep) → 제외
    { t: t0 + 60 + 4000, ac: true, adapterW: 10, ...SLOW },   // dt=0 중복 타임스탬프 → 제외
    { t: t0 + 60 + 4000 + 60, ac: true, adapterW: 10, ...SLOW }, // 다음 정상 쌍 → 1분
  ];
  const [row] = aggregateChargers(samples);
  assert.equal(row.minutes, 2);   // 정상 쌍 2개만
  assert.equal(row.pairCount, 2);
});

test('4) 두 충전기 교대 사용 → 키별 분리 집계, 전환 경계 쌍은 어느 쪽에도 미귀속', () => {
  const t0 = 4_000_000;
  // 노이즈 드롭(<10분) 회피를 위해 각 구간 10분 이상 확보
  const slowEnd = t0 + 12 * 60;
  const samples = [
    ...acRun({ t0, n: 12, adapter: SLOW, adapterW: 13 }),                 // 12쌍 = 12분 (SLOW)
    { t: slowEnd + 60, ac: true, adapterW: 80, ...FAST },                 // 경계 쌍(SLOW→FAST, 키 불일치) → 미귀속
    ...acRun({ t0: slowEnd + 60, n: 11, adapter: FAST, adapterW: 80 }),   // 11쌍 = 11분 (FAST, 첫 샘플은 위 경계와 겹치는 시작점)
  ];
  const rows = aggregateChargers(samples);
  const slow = rows.find(r => r.key === SLOW_KEY), fast = rows.find(r => r.key === FAST_KEY);
  assert.ok(slow && fast);
  assert.equal(slow.minutes, 12);
  assert.equal(fast.minutes, 11);
});

test('5) 레거시 부분 키 + 유일한 완전 키 → 병합(minutes 합산·lastSeen=max·avgW 재계산)', () => {
  const t0 = 5_000_000;
  const legacySamples = acRun({ t0, n: 2, adapter: { adapterWnom: 15, adapterVnom: 5 }, adapterW: 10 });   // familyCode/adapterId 없음 → "15W@5V/?#?"
  const fullSamples = acRun({ t0: t0 + 10_000, n: 2, adapter: SLOW, adapterW: 20 });                        // 완전 키(유일)
  const rows = aggregateChargers([...legacySamples, ...fullSamples]);
  assert.equal(rows.length, 1, '부분 키가 완전 키로 병합되어 1행이어야 함');
  const row = rows[0];
  assert.equal(row.key, SLOW_KEY);
  assert.equal(row.minutes, 4);   // 2분(레거시) + 2분(완전)
  assert.equal(row.lastSeen, t0 + 10_000 + 2 * 60);
  assert.equal(row.firstSeen, t0);
  // 시간가중 재계산: 두 구간 모두 dt=60s 쌍이라 결과적으로 단순평균과 같지만, wSum/wSec 경로로 계산됨을 확인
  assert.ok(Math.abs(row.avgW - 15) < 0.01, `avgW ${row.avgW}`);   // (10+20)/2 근처(두 구간 동일 dt)
});

test('6) 같은 프리픽스의 완전 키가 2개 존재 시 부분 키 병합 안 함(행 유지)', () => {
  const t0 = 6_000_000;
  // 노이즈 드롭(<10분)에 걸리지 않도록 각 행 10분 이상 확보(n=15 → 15쌍=15분)
  const legacySamples = acRun({ t0, n: 15, adapter: { adapterWnom: 15, adapterVnom: 5 }, adapterW: 10 });
  const full1 = acRun({ t0: t0 + 10_000, n: 15, adapter: SLOW, adapterW: 10 });
  const full2 = acRun({ t0: t0 + 30_000, n: 15, adapter: { adapterWnom: 15, adapterVnom: 5, familyCode: 'e0004009', adapterId: 99 }, adapterW: 10 });
  const rows = aggregateChargers([...legacySamples, ...full1, ...full2]);
  assert.equal(rows.length, 3, '후보가 2개면 병합하지 않고 3행 유지');
});

test('7) minutes<10 노이즈 드롭, 전부 노이즈면 최장 사용 1개 유지', () => {
  const t0 = 7_000_000;
  // 두 충전기 모두 5분 미만(노이즈) → 둘 다 드롭 대상이지만, 전부 드롭되면 최장(더 긴 쪽) 1개 유지
  const shortA = acRun({ t0, n: 2, adapter: SLOW, adapterW: 10 });                 // 2분
  const shortB = acRun({ t0: t0 + 10_000, n: 4, adapter: FAST, adapterW: 50 });     // 4분(더 김)
  const rows = aggregateChargers([...shortA, ...shortB]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, FAST_KEY);

  // 하나는 노이즈(<10분, shortB=4분·FAST), 하나는 충분(>=10분, longC=12분·SLOW·다른 충전기) → 노이즈만 드롭, 1행 남음
  const longC = acRun({ t0: t0 + 20_000, n: 12, adapter: SLOW, adapterW: 10 });     // 12분
  const rows2 = aggregateChargers([...shortB, ...longC]);
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].key, SLOW_KEY);
  assert.equal(rows2[0].minutes, 12);
});

test('8) isPowerBank 휴리스틱: 15W@5V usbc-5v → true · 이름 PowerBank → true · 96W PD → false', () => {
  const t0 = 8_000_000;
  const slowSamples = acRun({ t0, n: 20, adapter: SLOW, adapterW: 10 });
  const fastSamples = acRun({ t0: t0 + 100_000, n: 20, adapter: FAST, adapterW: 80 });
  const adapters = { [FAST_KEY]: { name: 'Anker PowerBank', tech: 'usbc-pd' } };
  const rows = aggregateChargers([...slowSamples, ...fastSamples], adapters);
  const slow = rows.find(r => r.key === SLOW_KEY), fast = rows.find(r => r.key === FAST_KEY);
  assert.equal(slow.isPowerBank, true, 'usbc-5v/≤20W → true');
  assert.equal(fast.isPowerBank, true, '이름에 PowerBank → true (96W PD여도)');

  const adapters2 = { [FAST_KEY]: { tech: 'usbc-pd' } };   // 이름 없음 → 순수 96W PD
  const rows2 = aggregateChargers([...fastSamples], adapters2);
  assert.equal(rows2[0].isPowerBank, false, '96W PD, 이름 없음 → false');
});

test('9) chargerKey null(ac인데 adapterWnom 없음) → unknown 버킷', () => {
  const t0 = 9_000_000;
  const samples = acRun({ t0, n: 20, adapter: {}, adapterW: 5 });   // adapterWnom 없음
  const rows = aggregateChargers(samples);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'unknown');
  assert.equal(rows[0].wattsNom, null);
  assert.equal(rows[0].voltsNom, null);
});

test('10) 빈 배열/전부 배터리(ac:false) → []', () => {
  assert.deepEqual(aggregateChargers([]), []);
  const t0 = 10_000_000;
  const onBatt = Array.from({ length: 5 }, (_, i) => ({ t: t0 + i * 60, ac: false }));
  assert.deepEqual(aggregateChargers(onBatt), []);
});

test('11) avgW 시간가중: dt가 다른 두 쌍 → 단순평균이 아니라 시간가중값', () => {
  const t0 = 11_000_000;
  // 쌍1: dt=60s, W 10→10(평균10) · 쌍2(4000s 뒤, sleep 아래로 재연결은 안 되고 별개 쌍으로만 집계): dt=600s, W 20→20(평균20)
  const samples = [
    { t: t0, ac: true, adapterW: 10, ...SLOW },
    { t: t0 + 60, ac: true, adapterW: 10, ...SLOW },
    { t: t0 + 60 + 4000, ac: true, adapterW: 20, ...SLOW },          // 4000s 공백(>3600) → 이 쌍은 sleep으로 제외
    { t: t0 + 60 + 4000 + 600, ac: true, adapterW: 20, ...SLOW },
  ];
  const [row] = aggregateChargers(samples);
  // 시간가중: (10*60 + 20*600) / (60+600) = (600+12000)/660 = 19.09...
  const expected = +((10 * 60 + 20 * 600) / 660).toFixed(2);
  assert.equal(row.avgW, expected);
  assert.notEqual(row.avgW, 15, '단순평균(15)이 아니어야 함');
});
