import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { mergeEnvPass } = createRequire(import.meta.url)('../lib/piw.js');

test('调用方给的 SANDBOX_ENV_PASS 不被 provider key 覆盖:两者逗号合并(25.10 挤压实测 GATE_MEM_SLOTS 被丢)', () => {
  assert.equal(mergeEnvPass('GATE_MEM_SLOTS', 'MINIMAX_API_KEY'), 'GATE_MEM_SLOTS,MINIMAX_API_KEY');
});
test('没有 key → 原值不变;没有原值 → 只有 key;重复不重复写', () => {
  assert.equal(mergeEnvPass('A,B', undefined), 'A,B');
  assert.equal(mergeEnvPass(undefined, 'K'), 'K');
  assert.equal(mergeEnvPass('K,A', 'K'), 'K,A');
  assert.equal(mergeEnvPass(undefined, undefined), undefined);
});
