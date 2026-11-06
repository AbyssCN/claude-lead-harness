// GWT-11: real herdr, real Claude. Manual only: TICKET_SMOKE=1 node --test ticket/bin/smoke.test.mjs (inside a herdr pane).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const on = process.env.TICKET_SMOKE === '1';

test('GWT-11 真 herdr:开单 → 会话报 ready → close → agent 没了', { skip: !on && '要 TICKET_SMOKE=1', timeout: 15 * 60000 }, () => {
  assert.equal(process.env.HERDR_ENV, '1', '要在 herdr pane 里跑');
  const which = spawnSync('sh', ['-c', 'command -v ticket'], { encoding: 'utf8' });
  assert.ok(which.stdout.trim(), 'ticket 不在 PATH 上');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-smoke-'));
  const env = { ...process.env, TICKET_ROOT: root };
  delete env.TICKET_ID;
  delete env.TICKET_STORE;
  delete env.TICKET_HERDR;
  const run = (...a) => spawnSync('ticket', a, { encoding: 'utf8', env, timeout: 6 * 60000 });
  const herdr = (...a) => spawnSync('herdr', a, { encoding: 'utf8' });

  const o = run('open', '--repo', 'claude-mods', '--title', '冒烟',
    '--origin', '冒烟测试。什么都不用读、不用改。直接在 shell 里运行一次: ticket report $TICKET_ID --status ready --summary 冒烟通过',
    '--scope', '不改任何文件', '--accept', 'true');
  const id = o.stdout.trim();
  try {
    assert.equal(o.status, 0, `open 退 ${o.status}: ${o.stderr}`);
    const file = path.join(root, 'claude-mods', `${id}.json`);
    const deadline = Date.now() + 8 * 60000;
    let rec;
    while (Date.now() < deadline) {
      rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (rec.status === 'ready') break;
      spawnSync('sleep', ['5']);
    }
    assert.equal(rec.status, 'ready', '会话没在 8 分钟内报 ready');
    const c = run('close', id);
    assert.equal(c.status, 0, c.stderr);
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(rec.status, 'closed');
    assert.ok(rec.closing, 'closing 为空');
    const g = herdr('agent', 'get', id);
    assert.notEqual(g.status, 0, `agent ${id} 还在: ${g.stdout}`);
    console.log(`smoke ${id} closing:\n${rec.closing}`);
  } finally {
    if (id) {
      const g = herdr('agent', 'get', id);
      if (g.status === 0) {
        const pane = JSON.parse(g.stdout).result.agent.pane_id;
        herdr('pane', 'close', pane);
      }
    }
  }
});
