// 내 충전기·보조배터리 통계 테스트 — `npm test` (node --test). chargeRates.test.js와 같은 패턴.
// 스키마 v2: 행 단위가 chargerKey(협상 계약)가 아니라 modelKey(물리 충전기)다. 계약별 상세는
// row.profiles[]로 내려간다 — 아래 테스트에서 "그 계약을 가진 모델 행"을 찾을 때는 modelKey
// 문자열을 하드코딩하지 않고 profiles[].wnom으로 찾는다(반올림/서픽스 규칙은 (b)(d)에서 직접 검증).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateChargers } from '../lib/chargerStats.js';

const SLOW = { adapterWnom: 15, adapterVnom: 5, familyCode: 'e0004009', adapterId: 10 };
const FAST = { adapterWnom: 96, adapterVnom: 20, familyCode: 'e000400a', adapterId: 30183 };
const SLOW_KEY = '15W@5V/e0004009#10', FAST_KEY = '96W@20V/e000400a#30183';
const findByWnom = (rows, wnom) => rows.find(r => r.profiles.some(p => p.wnom === wnom));

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
  assert.equal(row.profiles.length, 1);
  assert.equal(row.profiles[0].wnom, 15);   // 계약(15W@5V) 단위 정보는 profiles에 남는다
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

test('4) 두 충전기 교대 사용 → 모델별 분리 집계, 전환 경계 쌍은 어느 쪽에도 미귀속', () => {
  const t0 = 4_000_000;
  // 노이즈 드롭(<10분) 회피를 위해 각 구간 10분 이상 확보
  const slowEnd = t0 + 12 * 60;
  const samples = [
    ...acRun({ t0, n: 12, adapter: SLOW, adapterW: 13 }),                 // 12쌍 = 12분 (SLOW)
    { t: slowEnd + 60, ac: true, adapterW: 80, ...FAST },                 // 경계 쌍(SLOW→FAST, 키 불일치) → 미귀속
    ...acRun({ t0: slowEnd + 60, n: 11, adapter: FAST, adapterW: 80 }),   // 11쌍 = 11분 (FAST, 첫 샘플은 위 경계와 겹치는 시작점)
  ];
  const rows = aggregateChargers(samples);
  const slow = findByWnom(rows, 15), fast = findByWnom(rows, 96);
  assert.ok(slow && fast);
  assert.equal(slow.minutes, 12);
  assert.equal(fast.minutes, 11);
});

test('5) 레거시 부분 키 + 유일한 완전 키 → 병합(minutes 합산·lastSeen=max·avgW 재계산)', () => {
  const t0 = 5_000_000;
  const legacySamples = acRun({ t0, n: 2, adapter: { adapterWnom: 15, adapterVnom: 5 }, adapterW: 10 });   // familyCode/adapterId 없음 → "15W@5V/?#?"
  const fullSamples = acRun({ t0: t0 + 10_000, n: 2, adapter: SLOW, adapterW: 20 });                        // 완전 키(유일)
  const rows = aggregateChargers([...legacySamples, ...fullSamples]);
  assert.equal(rows.length, 1, '부분 키가 완전 키로 병합되어 모델 1행이어야 함');
  const row = rows[0];
  assert.equal(row.profiles.length, 1, '병합 후엔 계약도 하나(같은 15W@5V 키)');
  assert.equal(row.profiles[0].wnom, 15);
  assert.equal(row.minutes, 4);   // 2분(레거시) + 2분(완전)
  assert.equal(row.lastSeen, t0 + 10_000 + 2 * 60);
  assert.equal(row.firstSeen, t0);
  // 시간가중 재계산: 두 구간 모두 dt=60s 쌍이라 결과적으로 단순평균과 같지만, wSum/wSec 경로로 계산됨을 확인
  assert.ok(Math.abs(row.avgW - 15) < 0.01, `avgW ${row.avgW}`);   // (10+20)/2 근처(두 구간 동일 dt)
});

test('6) 같은 프리픽스의 완전 키가 2개 존재 시 부분 키 병합 안 함(모델도 3행 유지)', () => {
  const t0 = 6_000_000;
  // 노이즈 드롭(<10분)에 걸리지 않도록 각 행 10분 이상 확보(n=15 → 15쌍=15분)
  const legacySamples = acRun({ t0, n: 15, adapter: { adapterWnom: 15, adapterVnom: 5 }, adapterW: 10 });
  const full1 = acRun({ t0: t0 + 10_000, n: 15, adapter: SLOW, adapterW: 10 });
  const full2 = acRun({ t0: t0 + 30_000, n: 15, adapter: { adapterWnom: 15, adapterVnom: 5, familyCode: 'e0004009', adapterId: 99 }, adapterW: 10 });
  const rows = aggregateChargers([...legacySamples, ...full1, ...full2]);
  assert.equal(rows.length, 3, '후보가 2개면 병합하지 않고 3행 유지(family#adapterId가 셋 다 달라 모델도 안 합쳐짐)');
});

test('7) minutes<10 노이즈 드롭(모델 행 레벨), 전부 노이즈면 최장 사용 1개 유지', () => {
  const t0 = 7_000_000;
  // 두 충전기 모두 5분 미만(노이즈) → 둘 다 드롭 대상이지만, 전부 드롭되면 최장(더 긴 쪽) 1개 유지
  const shortA = acRun({ t0, n: 2, adapter: SLOW, adapterW: 10 });                 // 2분
  const shortB = acRun({ t0: t0 + 10_000, n: 4, adapter: FAST, adapterW: 50 });     // 4분(더 김)
  const rows = aggregateChargers([...shortA, ...shortB]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].profiles[0].wnom, 96);

  // 하나는 노이즈(<10분, shortB=4분·FAST), 하나는 충분(>=10분, longC=12분·SLOW·다른 충전기) → 노이즈만 드롭, 1행 남음
  const longC = acRun({ t0: t0 + 20_000, n: 12, adapter: SLOW, adapterW: 10 });     // 12분
  const rows2 = aggregateChargers([...shortB, ...longC]);
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].profiles[0].wnom, 15);
  assert.equal(rows2[0].minutes, 12);
});

test('8) isPowerBank 휴리스틱: 15W@5V usbc-5v → true · 이름 PowerBank → true · 96W PD → false', () => {
  const t0 = 8_000_000;
  const slowSamples = acRun({ t0, n: 20, adapter: SLOW, adapterW: 10 });
  const fastSamples = acRun({ t0: t0 + 100_000, n: 20, adapter: FAST, adapterW: 80 });
  const adapters = { [FAST_KEY]: { name: 'Anker PowerBank', tech: 'usbc-pd' } };
  const rows = aggregateChargers([...slowSamples, ...fastSamples], adapters);
  const slow = findByWnom(rows, 15), fast = findByWnom(rows, 96);
  assert.equal(slow.isPowerBank, true, 'usbc-5v/≤20W → true');
  assert.equal(fast.isPowerBank, true, '이름에 PowerBank → true (96W PD여도)');
  assert.equal(fast.name, 'Anker PowerBank', '구체적 이름이 있으면 모델명으로 채택');

  const adapters2 = { [FAST_KEY]: { tech: 'usbc-pd' } };   // 이름 없음 → 순수 96W PD
  const rows2 = aggregateChargers([...fastSamples], adapters2);
  assert.equal(findByWnom(rows2, 96).isPowerBank, false, '96W PD, 이름 없음 → false');
});

test('9) chargerKey null(ac인데 adapterWnom 없음) → unknown 모델(1행), 계약 정보도 null', () => {
  const t0 = 9_000_000;
  const samples = acRun({ t0, n: 20, adapter: {}, adapterW: 5 });   // adapterWnom 없음
  const rows = aggregateChargers(samples);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, null);
  assert.equal(rows[0].ratedW, null);
  assert.equal(rows[0].profiles.length, 1);
  assert.equal(rows[0].profiles[0].wnom, null);
  assert.equal(rows[0].profiles[0].vnom, null);
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

// ---- 스키마 v2: 모델 그룹핑 전용 테스트 ------------------------------------------------------

test('a) 같은 name+adapterId, 다른 계약 3개(듀얼포트 재협상) → 모델 1행 + profiles 3개, 합산 검증', () => {
  const FAM = 'e000400a', AID = 28699, NAME = '35W USB-C Power Adapter';
  const K35 = '35W@20V/e000400a#28699', K27 = '27W@20V/e000400a#28699', K17 = '17W@20V/e000400a#28699';
  const adapters = {
    [K35]: { name: NAME, manufacturer: 'Apple Inc.', hvcMenu: [{ v: 5, a: 3 }, { v: 9, a: 3 }, { v: 15, a: 2.33 }, { v: 20, a: 1.75 }] },   // 최대 35W(단독 사용 시 풀 메뉴)
    [K27]: { name: NAME, manufacturer: 'Apple Inc.', hvcMenu: [{ v: 5, a: 3 }, { v: 9, a: 3 }, { v: 15, a: 1.83 }, { v: 20, a: 1.37 }] },   // 최대 ~27.4W(다른 포트와 분배 중)
    [K17]: { name: NAME, manufacturer: 'Apple Inc.', hvcMenu: [{ v: 5, a: 3 }, { v: 9, a: 1.94 }, { v: 15, a: 1.16 }, { v: 20, a: 0.87 }] },  // 최대 ~17.5W(더 많이 분배)
  };
  // 35W 계약은 일부러 사용 시간을 짧게(합산 시엔 살아남지만 최다 사용은 아님) — offeredMenu가 "사용량"이 아니라
  // "메뉴 자체의 최댓값"으로 뽑힌다는 걸 (a)에서도 교차 확인.
  const samples = [
    ...acRun({ t0: 1, n: 5, adapter: { adapterWnom: 35, adapterVnom: 20, familyCode: FAM, adapterId: AID }, adapterW: 34 }),   // 5분
    ...acRun({ t0: 100_000, n: 20, adapter: { adapterWnom: 27, adapterVnom: 20, familyCode: FAM, adapterId: AID }, adapterW: 26 }), // 20분
    ...acRun({ t0: 200_000, n: 20, adapter: { adapterWnom: 17, adapterVnom: 20, familyCode: FAM, adapterId: AID }, adapterW: 16 }), // 20분
  ];
  const rows = aggregateChargers(samples, adapters);
  assert.equal(rows.length, 1, '같은 name+adapterId → 계약이 갈려도 모델 1행');
  const row = rows[0];
  assert.equal(row.name, NAME);
  assert.equal(row.manufacturer, 'Apple Inc.');
  assert.equal(row.profiles.length, 3);
  assert.equal(row.minutes, 5 + 20 + 20);   // 합산 minutes
  const expWh = +((34 * 5 + 26 * 20 + 16 * 20) / 60).toFixed(1);   // 상수 W × 분 / 60 = Wh (시간가중이지만 상수라 단순)
  assert.equal(row.energyWh, expWh);
  assert.equal(row.maxW, 34);
  // profiles 각 계약의 minutes·energyWh가 개별적으로도 맞는지
  const p35 = row.profiles.find(p => p.wnom === 35), p27 = row.profiles.find(p => p.wnom === 27), p17 = row.profiles.find(p => p.wnom === 17);
  assert.equal(p35.minutes, 5); assert.equal(p27.minutes, 20); assert.equal(p17.minutes, 20);
  // offeredMenu: 최대 메뉴(35W 계약의 것, 사용 시간이 가장 짧아도)를 채택
  assert.ok(row.offeredMenu);
  assert.deepEqual(row.offeredMenu.map(p => p.v), [5, 9, 15, 20]);
  assert.equal(Math.max(...row.offeredMenu.map(p => p.w)), 35);
  // menuVariants: offeredMenu(35W)를 뺀 나머지 관측 메뉴들의 최대 W, 내림차순 — 듀얼포트 분배 관측치
  assert.deepEqual(row.menuVariants, [27, 17]);
});

test('g) 메뉴가 1종뿐이면 menuVariants는 빈 배열', () => {
  const FAM = 'e000400a', AID = 12345, NAME = '20W USB-C Power Adapter';
  const K20 = '20W@9V/e000400a#12345';
  const adapters = { [K20]: { name: NAME, hvcMenu: [{ v: 5, a: 3 }, { v: 9, a: 2.22 }] } };   // 최대 20W
  const samples = acRun({ t0: 1, n: 20, adapter: { adapterWnom: 20, adapterVnom: 9, familyCode: FAM, adapterId: AID }, adapterW: 18 });
  const rows = aggregateChargers(samples, adapters);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].menuVariants, []);
});

test('b) adapterId 0 + 일반명, 메뉴 최대 65W vs 67W → 반올림 같은 클래스로 병합, 90W는 별도 유지', () => {
  const FAM = 'e000400a';
  const K65 = '65W@20V/e000400a#0', K67 = '67W@20V/e000400a#0', K90 = '90W@20V/e000400a#0';
  const adapters = {
    [K65]: { name: 'pd charger', hvcMenu: [{ v: 20, a: 3.25 }] },                              // 65W
    [K67]: { name: 'pd charger', hvcMenu: [{ v: 20, a: 3.25 }, { v: 20.3, a: 3.3 }] },          // 66.99W → round5(65)와 같은 클래스
    [K90]: { name: 'pd charger', hvcMenu: [{ v: 20, a: 4.5 }] },                                // 90W → 별도 클래스
  };
  const samples = [
    ...acRun({ t0: 1, n: 15, adapter: { adapterWnom: 65, adapterVnom: 20, familyCode: FAM, adapterId: 0 }, adapterW: 60 }),
    ...acRun({ t0: 100_000, n: 20, adapter: { adapterWnom: 67, adapterVnom: 20, familyCode: FAM, adapterId: 0 }, adapterW: 62 }),
    ...acRun({ t0: 200_000, n: 15, adapter: { adapterWnom: 90, adapterVnom: 20, familyCode: FAM, adapterId: 0 }, adapterW: 85 }),
  ];
  const rows = aggregateChargers(samples, adapters);
  const merged = findByWnom(rows, 65);
  assert.ok(merged, '65W 계약을 담은 모델이 있어야 함');
  assert.ok(merged.modelKey.endsWith('|c65'), `클래스 65로 묶여야 함(${merged.modelKey})`);
  assert.equal(merged.profiles.length, 2, '65W·67W 두 계약이 한 모델에 묶임');
  assert.equal(merged.minutes, 15 + 20);
  assert.ok(merged.profiles.some(p => p.wnom === 67));
  // offeredMenu는 두 계약 중 메뉴 최댓값이 더 큰 67W 쪽(66.99W)을 채택 — 20.3V 항목의 존재로 확인
  assert.ok(merged.offeredMenu.some(p => p.v === 20.3), '67W 계약의 메뉴(20.3V 포함)가 선택돼야 함');

  const solo90 = findByWnom(rows, 90);
  assert.ok(solo90, '90W는 별도 모델로 남아야 함');
  assert.notEqual(solo90.modelKey, merged.modelKey);
  assert.ok(solo90.modelKey.endsWith('|c90'));
  assert.equal(solo90.profiles.length, 1);
});

test('c) avgV/avgA 시간가중 수계산 검증 (dcInV/dcInA, dt 다른 두 쌍)', () => {
  const t0 = 12_000_000;
  const samples = [
    { t: t0, ac: true, adapterW: 10, dcInV: 5, dcInA: 2, ...SLOW },
    { t: t0 + 60, ac: true, adapterW: 10, dcInV: 5, dcInA: 2, ...SLOW },          // 쌍1: dt=60, V=5(평균)·A=2(평균)
    { t: t0 + 60 + 600, ac: true, adapterW: 10, dcInV: 7, dcInA: -4, ...SLOW },   // 쌍2: dt=600, V=(5+7)/2=6·A=(|2|+|4|)/2=3, maxA=4(부호 무시)
  ];
  const rows = aggregateChargers(samples);
  const [row] = rows;
  const expV = +((5 * 60 + 6 * 600) / 660).toFixed(1);
  const expA = +((2 * 60 + 3 * 600) / 660).toFixed(2);
  assert.equal(row.avgV, expV);
  assert.equal(row.avgA, expA);
  assert.equal(row.maxA, 4);   // 부호와 무관하게 절댓값 최대
});

test('d) offeredMenu = 계약 사용시간이 아니라 "메뉴 자체의 최댓값"이 큰 쪽을 채택', () => {
  const FAM = 'e00099ff', AID = 777, NAME = 'Test Dual Charger';   // 구체적 이름 → adapterId만으로 병합, 클래스 서픽스 없음
  const KA = '40W@20V/e00099ff#777', KB = '20W@9V/e00099ff#777';
  const adapters = {
    [KA]: { name: NAME, hvcMenu: [{ v: 20, a: 2 }] },        // 최대 40W, 사용시간 많음
    [KB]: { name: NAME, hvcMenu: [{ v: 9, a: 5 }] },          // 최대 45W(더 큼), 사용시간 적음
  };
  const samples = [
    ...acRun({ t0: 1, n: 20, adapter: { adapterWnom: 40, adapterVnom: 20, familyCode: FAM, adapterId: AID }, adapterW: 38 }),   // 20분
    ...acRun({ t0: 100_000, n: 5, adapter: { adapterWnom: 20, adapterVnom: 9, familyCode: FAM, adapterId: AID }, adapterW: 18 }),  // 5분
  ];
  const rows = aggregateChargers(samples, adapters);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.profiles.length, 2);
  const wnoms = row.profiles.map(p => p.wnom).sort((a, b) => a - b);
  assert.deepEqual(wnoms, [20, 40]);
  assert.equal(Math.max(...row.offeredMenu.map(p => p.w)), 45, '사용시간이 적어도 메뉴 최댓값(45W)이 큰 쪽을 채택');
  assert.equal(row.offeredMenu[0].v, 9);
});

// ---- V2.1: 계약(profiles)별 실측 V/A ---------------------------------------------------------

test('e) profiles[]는 계약별 시간가중 avgV/avgA·maxA를 독립적으로 담는다(모델 전체 값과 다를 수 있음)', () => {
  const FAM = 'e000400a', AID = 555, NAME = 'Dual V Charger';   // 구체적 이름 → adapterId만으로 병합
  const t0 = 13_000_000;
  const rate1 = { adapterWnom: 35, adapterVnom: 20, familyCode: FAM, adapterId: AID };
  const rate2 = { adapterWnom: 17, adapterVnom: 20, familyCode: FAM, adapterId: AID };
  const samples1 = [
    { t: t0, ac: true, adapterW: 30, dcInV: 20, dcInA: 1.5, ...rate1 },
    { t: t0 + 60, ac: true, adapterW: 30, dcInV: 20, dcInA: 1.5, ...rate1 },          // 쌍1: dt=60, V=20·A=1.5
    { t: t0 + 60 + 600, ac: true, adapterW: 30, dcInV: 22, dcInA: -2.5, ...rate1 },   // 쌍2: dt=600, V=21·A=2.0(부호무시), maxA=2.5
  ];
  const t1 = t0 + 100_000;
  const samples2 = [
    { t: t1, ac: true, adapterW: 15, dcInV: 9, dcInA: 1.0, ...rate2 },
    { t: t1 + 60, ac: true, adapterW: 15, dcInV: 9, dcInA: 1.0, ...rate2 },           // 쌍1: dt=60, V=9·A=1.0
    { t: t1 + 60 + 600, ac: true, adapterW: 15, dcInV: 10, dcInA: 1.2, ...rate2 },    // 쌍2: dt=600, V=9.5·A=1.1, maxA=1.2
  ];
  const rows = aggregateChargers([...samples1, ...samples2], { [`35W@20V/${FAM}#${AID}`]: { name: NAME }, [`17W@20V/${FAM}#${AID}`]: { name: NAME } });
  assert.equal(rows.length, 1, '같은 name+adapterId → 모델 1행');
  const row = rows[0];
  const p35 = row.profiles.find(p => p.wnom === 35), p17 = row.profiles.find(p => p.wnom === 17);
  assert.ok(p35 && p17);
  const expV35 = +((20 * 60 + 21 * 600) / 660).toFixed(1);
  const expA35 = +((1.5 * 60 + 2.0 * 600) / 660).toFixed(2);
  assert.equal(p35.avgV, expV35);
  assert.equal(p35.avgA, expA35);
  assert.equal(p35.maxA, 2.5);
  const expV17 = +((9 * 60 + 9.5 * 600) / 660).toFixed(1);
  const expA17 = +((1.0 * 60 + 1.1 * 600) / 660).toFixed(2);
  assert.equal(p17.avgV, expV17);
  assert.equal(p17.avgA, expA17);
  assert.equal(p17.maxA, 1.2);
  assert.notEqual(p35.avgV, p17.avgV, '계약별로 독립 계산 — 모델 전체로 뭉개지지 않음');
});

test('f) profiles[]는 계약별 maxW/avgW/energyWh도 담는다(모델 합산 값과 별개)', () => {
  const FAM = 'e000400a', AID = 28699, NAME = '35W USB-C Power Adapter';
  const K35 = '35W@20V/e000400a#28699', K17 = '17W@20V/e000400a#28699';
  const adapters = { [K35]: { name: NAME }, [K17]: { name: NAME } };
  const samples = [
    ...acRun({ t0: 1, n: 5, adapter: { adapterWnom: 35, adapterVnom: 20, familyCode: FAM, adapterId: AID }, adapterW: 34 }),   // 5분, 상수 34W
    ...acRun({ t0: 100_000, n: 20, adapter: { adapterWnom: 17, adapterVnom: 20, familyCode: FAM, adapterId: AID }, adapterW: 16 }), // 20분, 상수 16W
  ];
  const rows = aggregateChargers(samples, adapters);
  assert.equal(rows.length, 1);
  const row = rows[0];
  const p35 = row.profiles.find(p => p.wnom === 35), p17 = row.profiles.find(p => p.wnom === 17);
  assert.equal(p35.maxW, 34); assert.equal(p35.avgW, 34); assert.equal(p35.energyWh, +(34 * 5 / 60).toFixed(1));
  assert.equal(p17.maxW, 16); assert.equal(p17.avgW, 16); assert.equal(p17.energyWh, +(16 * 20 / 60).toFixed(1));
  // 모델 전체 값은 두 계약의 시간가중 풀링이라 계약별 값과 다름
  assert.notEqual(row.avgW, p35.avgW);
  assert.equal(row.maxW, 34);   // 최댓값은 두 계약 중 더 큰 쪽과 일치
});
