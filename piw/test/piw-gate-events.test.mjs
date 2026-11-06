import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importGateEvents } from '../lib/gate-events.mjs';

test('gate-events.jsonl 的行按记下的时刻转进事件流，坏行与非 gate 行跳过，目录不在不报错', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-'));
  fs.writeFileSync(path.join(d, 'gate-events.jsonl'), [
    JSON.stringify({ ts: '2026-10-24T01:00:00.000Z', phase: 'gate', status: 'fail', round: 1, started: '2026-10-24T00:58:00.000Z' }),
    '{坏行',
    JSON.stringify({ ts: '2026-10-24T01:20:00.000Z', phase: 'round', status: 'x' }),
    JSON.stringify({ ts: '2026-10-24T01:30:00.000Z', phase: 'gate', status: 'pass', round: 2, started: '2026-10-24T01:29:00.000Z' }),
  ].join('\n') + '\n');
  const got = [];
  const n = importGateEvents([d, path.join(d, 'fallback')], { repo: '/r', run: 'x', actor: 'pi' }, (e) => got.push(e));
  assert.equal(n, 2);
  assert.deepEqual(got.map((e) => [e.ts, e.status, e.round, e.run, e.actor]), [
    ['2026-10-24T01:00:00.000Z', 'fail', 1, 'x', 'pi'],
    ['2026-10-24T01:30:00.000Z', 'pass', 2, 'x', 'pi'],
  ]);
});

test('appendEvent 收到的 ts 盖过它自己的当前时刻', async () => {
  const { appendEvent } = await import('../lib/events.mjs');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'e.jsonl');
  appendEvent({ repo: '/r', run: 'x', phase: 'gate', status: 'pass', actor: 'pi', ts: '2026-10-24T01:30:00.000Z' }, { FACTORY_EVENTS: f });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).ts, '2026-10-24T01:30:00.000Z');
});
