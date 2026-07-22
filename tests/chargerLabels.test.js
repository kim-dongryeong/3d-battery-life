// 충전기 별명(라벨) 병합 순수함수 테스트 — `npm test` (node --test). 파일 I/O는 서버 라우트 수동
// curl 검증으로 갈음(mergeLabel만 순수함수라 여기서 유닛테스트).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLabel } from '../lib/chargerLabels.js';

test('빈 사전에 라벨 추가', () => {
  const out = mergeLabel({}, 'A', '서재 65W');
  assert.deepEqual(out, { A: '서재 65W' });
});

test('기존 라벨 갱신 + 다른 키는 보존', () => {
  const out = mergeLabel({ A: '옛날 이름', B: '보조배터리' }, 'A', '서재 65W');
  assert.deepEqual(out, { A: '서재 65W', B: '보조배터리' });
});

test('빈 문자열/공백뿐인 라벨 → 해당 키 삭제', () => {
  const base = { A: '서재 65W', B: '보조배터리' };
  assert.deepEqual(mergeLabel(base, 'A', ''), { B: '보조배터리' });
  assert.deepEqual(mergeLabel(base, 'A', '   '), { B: '보조배터리' });
});

test('앞뒤 공백은 트림되어 저장', () => {
  const out = mergeLabel({}, 'A', '  서재 65W  ');
  assert.equal(out.A, '서재 65W');
});

test('원본 객체는 변경하지 않는다(순수함수)', () => {
  const base = { A: '서재 65W' };
  mergeLabel(base, 'A', '거실 65W');
  assert.deepEqual(base, { A: '서재 65W' });
});

test('존재하지 않는 키를 빈 라벨로 지워도 에러 없음', () => {
  const out = mergeLabel({ B: '보조배터리' }, 'A', '');
  assert.deepEqual(out, { B: '보조배터리' });
});
