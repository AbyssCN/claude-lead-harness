import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endKind, onTruncated } from '../lib/end-kind.ts';

test('撞输出上限不算做完', () => {
  assert.equal(endKind({ role: 'assistant', stopReason: 'length' }), 'truncated');
  assert.equal(endKind({ role: 'assistant', stopReason: 'stop' }), 'done');
  assert.equal(endKind({ role: 'assistant', stopReason: 'toolUse' }), 'done');
  assert.equal(endKind({ role: 'assistant', stopReason: 'error' }), 'retry');
  assert.equal(endKind(undefined), 'done');
});

test('截断两次内叫它接着做，第三次放弃且不跑闸', () => {
  assert.equal(onTruncated(1), 'continue');
  assert.equal(onTruncated(2), 'continue');
  assert.equal(onTruncated(3), 'give-up');
});
