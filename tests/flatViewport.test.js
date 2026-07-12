// 2D 시간 창 컨트롤러 불변량 테스트 (Codex 리뷰의 스펙 6개) — `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { span, normalizeWindow, zoomAt, panBy, presetWindow, isFollowingEnd, followEnd, calendarTicks, FUTURE_PAD } from '../web/flatViewport.js';

// 고정 스팬: 로컬 자정 기준 30일
const midnight = (() => { const d = new Date('2026-06-10T00:00:00'); return d.getTime() / 1000; })();
const SP = { min: midnight, max: midnight + 30 * 86400 };

test('불변량 1: 항상 min ≤ t0 < t1 ≤ max + FUTURE_PAD', () => {
  for (const cand of [
    { t0: SP.min - 99999, t1: SP.min - 90000 },          // 완전히 과거 밖
    { t0: SP.max + 99999, t1: SP.max + 999999 },          // 완전히 미래 밖
    { t0: SP.min + 5, t1: SP.min + 6 },                   // 10분 미만
  ]) {
    const w = normalizeWindow(cand, SP);
    if (w == null) continue;
    assert.ok(w.t0 >= SP.min && w.t0 < w.t1 && w.t1 <= SP.max + FUTURE_PAD, JSON.stringify(w));
    assert.ok(w.t1 - w.t0 >= 600);
  }
});

test('불변량 2: zoom 전후 커서 시간의 화면 X 비율 보존', () => {
  const win = { t0: SP.min + 86400, t1: SP.min + 5 * 86400 };
  const anchor = win.t0 + (win.t1 - win.t0) * 0.3;
  const z = zoomAt(win, SP, anchor, 0.5);
  const r = (anchor - z.t0) / (z.t1 - z.t0);
  assert.ok(Math.abs(r - 0.3) < 1e-9, `ratio ${r}`);
  assert.ok(Math.abs((z.t1 - z.t0) - (win.t1 - win.t0) * 0.5) < 1e-6);
});

test('불변량 3: pan 은 창 폭을 바꾸지 않는다 (경계 클램프 포함)', () => {
  const win = { t0: SP.min + 86400, t1: SP.min + 3 * 86400 };
  const dur = win.t1 - win.t0;
  for (const d of [3600, -10 * 86400, 100 * 86400]) {   // 정상·과거 경계·미래 경계
    const p = panBy(win, SP, d);
    assert.ok(p == null || Math.abs((p.t1 - p.t0) - dur) < 1e-6, `d=${d}`);
  }
});

test('불변량 4: 전체를 덮는 창은 언제나 null 로 정규화', () => {
  assert.equal(normalizeWindow({ t0: SP.min - 10, t1: SP.max + 10 }, SP), null);
  assert.equal(presetWindow('all', { t0: SP.min, t1: SP.min + 3600 }, SP), null);
  // 전체에서 살짝만 줌인해도 창이 생긴다
  assert.notEqual(zoomAt(null, SP, SP.min + 15 * 86400, 0.5), null);
});

test('불변량 5: 날짜 눈금은 DST 경계를 지나도 로컬 자정에 놓인다', () => {
  // 2026-03-29 는 EU DST 시작(하루=23h). 그 주를 걸치는 30일 창(일 단위 눈금 경로).
  const d = new Date('2026-03-15T00:00:00');
  const w = { t0: d.getTime() / 1000, t1: d.getTime() / 1000 + 30 * 86400 };
  const sp = { min: w.t0 - 86400, max: w.t1 + 86400 };
  const ticks = calendarTicks(w, sp);
  assert.ok(ticks.length >= 8, `ticks ${ticks.length}`);
  for (const tk of ticks) {
    const dd = new Date(tk.t * 1000);
    assert.equal(dd.getHours(), 0, `자정 아님: ${dd.toString()}`);
    assert.equal(dd.getMinutes(), 0);
  }
  assert.ok(ticks.some(tk => tk.label), '라벨 눈금 존재');
});

test('세부선(minor): 라벨보다 촘촘한 무라벨 눈금이 줌에 따라 나타난다', () => {
  // 10일 창: 라벨은 일 단위(≤12개), 세부선은 하루 미만(12h/6h) — 시각 정보가 라벨 전에 먼저 보임
  const d = new Date('2026-06-11T00:00:00');
  const w = { t0: d.getTime() / 1000, t1: d.getTime() / 1000 + 10 * 86400 };
  const ticks = calendarTicks(w, SP);
  const labeled = ticks.filter(t => t.label), minors = ticks.filter(t => !t.label);
  assert.ok(labeled.length > 0 && labeled.length <= 13, `라벨 ${labeled.length}`);
  assert.ok(minors.length > 0, '세부선 존재');
  assert.ok(ticks.length <= 66, `전체 ${ticks.length} ≤ 64+α`);
  for (const tk of minors) assert.equal(new Date(tk.t * 1000).getMinutes(), 0);   // 하루 미만 세부선도 정시
  // 5일 창이면 라벨이 12시간 단위로 — "시각 라벨"이 종전(≤48h)보다 훨씬 이른 줌에서 등장
  const w5 = { t0: w.t0, t1: w.t0 + 5 * 86400 };
  const lab5 = calendarTicks(w5, SP).filter(t => t.label);
  assert.ok(lab5.some(t => new Date(t.t * 1000).getHours() === 12), '12시 라벨 존재');
});

test('불변량 6: 최신 추적 — 폭 유지, t1 만 새 끝으로', () => {
  const win = { t0: SP.max - 7200, t1: SP.max - 60 };     // 끝에 붙어 있던 2시간 창
  assert.ok(isFollowingEnd(win, SP));
  const newSp = { min: SP.min, max: SP.max + 600 };        // 10분치 새 샘플
  const f = followEnd(win, newSp);
  assert.ok(Math.abs((f.t1 - f.t0) - (win.t1 - win.t0)) < 1e-6, '폭 보존');
  assert.equal(f.t1, newSp.max);
  // 과거를 보고 있던 창은 추적하지 않는다
  assert.ok(!isFollowingEnd({ t0: SP.min, t1: SP.min + 3600 }, SP));
  // 전체 보기(null)는 항상 추적 상태이고 전체 그대로
  assert.ok(isFollowingEnd(null, SP));
  assert.equal(followEnd(null, newSp), null);
});

test('시간 눈금(30h 창): 라벨=3시간 간격 정시, major=자정, 세부선은 그보다 촘촘', () => {
  const d = new Date('2026-06-11T05:30:00');
  const w = { t0: d.getTime() / 1000, t1: d.getTime() / 1000 + 30 * 3600 };
  const ticks = calendarTicks(w, SP, 'en');
  assert.ok(ticks.length >= 8);
  const labeled = ticks.filter(t => t.label);
  assert.ok(labeled.length > 0 && labeled.length <= 13);
  for (const tk of labeled) {
    const dd = new Date(tk.t * 1000);
    assert.equal(dd.getMinutes(), 0);
    assert.equal(dd.getHours() % 3, 0);                    // 30h 창 → 라벨 3시간 간격
    assert.equal(tk.major, dd.getHours() === 0);
  }
  assert.ok(ticks.some(t => !t.label), '세부선 존재');
});

test('프리셋: 7d/24h 는 끝 기준, end 는 폭 유지', () => {
  const w7 = presetWindow('7d', null, SP);
  assert.equal(w7.t1, SP.max); assert.ok(Math.abs((w7.t1 - w7.t0) - 7 * 86400) < 1);
  const cur = { t0: SP.min + 86400, t1: SP.min + 2 * 86400 };
  const we = presetWindow('end', cur, SP);
  assert.equal(we.t1, SP.max); assert.ok(Math.abs((we.t1 - we.t0) - 86400) < 1);
});
