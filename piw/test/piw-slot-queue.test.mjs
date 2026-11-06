import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQueued, SLOT_BUSY } from '../lib/slot-queue.mjs';

const seq = (codes) => { let i = 0; return async () => ({ cmd: 'g', code: codes[Math.min(i++, codes.length - 1)], timedOut: false, output: '' }); };

test('闸退 75(闸槽排队超时)→ 同一道闸重排，不算一轮;拿到槽后的退出码才是读数', async () => {
  const { r, tries } = await runQueued(seq([SLOT_BUSY, SLOT_BUSY, 1]), 5);
  assert.equal(r.code, 1);
  assert.equal(tries, 3);
});

test('重排到上限仍是 75 → 原样交回 75,由调用方记成「闸没跑」', async () => {
  const { r, tries } = await runQueued(seq([SLOT_BUSY]), 4);
  assert.equal(r.code, SLOT_BUSY);
  assert.equal(tries, 4);
});

test('非 75 一次就交回(0 / 1 / 超时被杀都不重排)', async () => {
  for (const code of [0, 1, null]) assert.equal((await runQueued(seq([code]), 5)).tries, 1);
});

test('每次起闸前都打一次心跳(等槽重排期间执行体 stdout 不动,看门狗靠它不误杀;-sq 25.10 排 5 次后在 1829 s 被判 hang)', async () => {
  let beats = 0;
  const { tries } = await runQueued(seq([SLOT_BUSY, SLOT_BUSY, 0]), 5, () => { beats++; });
  assert.equal(tries, 3);
  assert.equal(beats, 3);
});

test('lastActivity:心跳文件比 stdout 新就以心跳为准;没有心跳文件照旧', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { lastActivity, HEARTBEAT } = await import('../lib/slot-queue.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
  assert.equal(lastActivity(1000, dir), 1000);
  fs.writeFileSync(path.join(dir, HEARTBEAT), '');
  assert.ok(lastActivity(1000, dir) > 1000);
});
