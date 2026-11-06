import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as S from '../lib/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '../bin/ticket.mjs');
const FAKE = path.join(here, 'fake-herdr.mjs');
const LEAD = 'wZ:p99';

function setup(script = {}, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-test-'));
  const root = path.join(dir, 'tickets');
  fs.mkdirSync(root);
  const scriptFile = path.join(dir, 'script.json');
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const log = path.join(dir, 'herdr.log');
  const env = { ...process.env };
  delete env.TICKET_ID;
  delete env.TICKET_STORE;
  Object.assign(env, {
    TICKET_ROOT: root, TICKET_HERDR: FAKE, FAKE_HERDR_LOG: log, FAKE_HERDR_SCRIPT: scriptFile,
    HERDR_PANE_ID: LEAD, HERDR_WORKSPACE_ID: 'wZ', TICKET_RETRY_MS: '0', TICKET_SETTLE_MS: '0', ...extra,
  });
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, cwd: dir });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const leadPrompts = () => calls().filter((c) => c.key === 'agent prompt' && c.argv[2] === LEAD);
  const rec = (id) => JSON.parse(fs.readFileSync(path.join(root, 'demo', `${id}.json`), 'utf8'));
  const evs = (id) => fs.readFileSync(path.join(root, 'demo', `${id}.events.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const open = (title = 'x') => {
    const r = run('open', '--repo', 'demo', '--title', title, '--origin', 'o', '--scope', 's', '--accept', 'true');
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  return { dir, root, env, run, calls, leadPrompts, rec, evs, open };
}

test('open: 单号小写、状态 working、事件记三步', () => {
  const t = setup();
  const id = t.open();
  assert.match(id, /^t\d{4}-01$/);
  assert.equal(t.rec(id).status, 'working');
  assert.equal(t.rec(id).leadPane, LEAD);
  const start = t.calls().find((c) => c.key === 'agent start');
  assert.deepEqual(start.argv.slice(0, 7), ['agent', 'start', id, '--kind', 'claude', '--pane', 'wZ:p50']);
  assert.deepEqual(start.argv.slice(-5), ['--', '--model', 'opus', '--effort', 'low']);
  const opening = t.calls().find((c) => c.key === 'agent prompt' && c.argv[2] === id);
  assert.match(opening.argv[3], new RegExp(`^你是 ${id} 的会话`));
  assert.ok(opening.argv.includes('--wait'));
});

test('GWT-1 先记再说:叫醒 lead 时事件流末行已是 status→ready', () => {
  const t = setup();
  const id = t.open();
  const r = t.run('report', id, '--status', 'ready', '--summary', 'R1 两家复核 SHIP');
  assert.equal(r.status, 0, r.stderr);
  const last = t.evs(id).at(-1);
  assert.equal(last.type, 'status');
  assert.equal(last.to, 'ready');
  const p = t.leadPrompts();
  assert.equal(p.length, 1);
  assert.equal(p[0].lastEvent.to, 'ready');
  assert.equal(p[0].argv[3], `[ticket] ${id} ready · R1 两家复核 SHIP`);
});

test('GWT-2 note 不叫醒', () => {
  const t = setup();
  const id = t.open();
  for (let i = 0; i < 10; i++) assert.equal(t.run('note', id, `进度 ${i}`).status, 0);
  assert.equal(t.leadPrompts().length, 0);
  assert.equal(t.evs(id).filter((e) => e.type === 'note').length, 10);
});

test('GWT-3 ready、needs-owner 叫醒,working 不叫醒;格式照 C-4', () => {
  const t = setup();
  const id = t.open();
  assert.equal(t.run('report', id, '--status', 'ready', '--summary', 'a').status, 0);
  assert.equal(t.run('report', id, '--status', 'working', '--summary', 'b').status, 0);
  const r = t.run('report', id, '--status', 'needs-owner', '--summary', '0451 迁移要不要先在 staging 跑', '--question', '先跑 staging?', '--recommend', '先跑');
  assert.equal(r.status, 0, r.stderr);
  const p = t.leadPrompts();
  assert.equal(p.length, 2);
  assert.equal(p[1].argv[3], `[ticket] ${id} needs-owner · 0451 迁移要不要先在 staging 跑 | 推荐: 先跑`);
});

test('GWT-4 答复按单号投,记录里不存 pane / sessionId', () => {
  const t = setup({
    'agent get': [
      { result: { agent: { name: 'x', agent: 'claude', pane_id: 'wZ:p1F', agent_status: 'idle' } } },
      { result: { agent: { name: 'x', agent: 'claude', pane_id: 'wZ:p2A', agent_status: 'idle' } } },
    ],
  });
  const id = t.open();
  const before = t.calls().filter((c) => c.key === 'agent prompt' && c.argv[2] === id).length;
  for (const a of ['答一', '答二']) {
    assert.equal(t.run('report', id, '--status', 'needs-lead', '--summary', 'q', '--question', 'q?').status, 0);
    const r = t.run('answer', id, a);
    assert.equal(r.status, 0, r.stderr);
  }
  const toTicket = t.calls().filter((c) => c.key === 'agent prompt' && c.argv[2] === id).slice(before);
  assert.equal(toTicket.length, 2);
  assert.match(toTicket[1].argv[3], /答二/);
  const json = t.rec(id);
  for (const k of ['sessions', 'pane', 'paneId', 'sessionId']) assert.ok(!(k in json), k);
  assert.equal(json.answer, '答二');
  assert.equal(json.status, 'working');
});

test('GWT-5 叫醒被拒进 outbox,board 补发一次后清空', () => {
  const t = setup({
    'agent prompt': [{ result: {} }, { error: { code: 'agent_blocked', message: 'blocked' } }, { result: {} }],
  });
  const id = t.open();
  const r = t.run('report', id, '--status', 'ready', '--summary', 'done');
  assert.equal(r.status, 0, r.stderr);
  const outbox = path.join(t.root, 'demo', 'outbox.jsonl');
  assert.equal(fs.readFileSync(outbox, 'utf8').trim().split('\n').length, 1);
  assert.equal(t.run('board').status, 0);
  assert.equal(t.leadPrompts().length, 2);
  assert.equal(fs.readFileSync(outbox, 'utf8'), '');
  assert.equal(t.run('board').status, 0);
  assert.equal(t.leadPrompts().length, 2);
});

test('GWT-6 agent start 回 agent_not_ready:退 12,单留 queued,事件记原话', () => {
  const t = setup({ 'agent start': { error: { code: 'agent_not_ready', message: 'startup blocked' } } });
  const r = t.run('open', '--repo', 'demo', '--title', 'x', '--origin', 'o', '--scope', 's', '--accept', 'true');
  assert.equal(r.status, 12, r.stderr);
  const id = r.stdout.trim();
  assert.equal(t.rec(id).status, 'queued');
  const last = t.evs(id).at(-1);
  assert.equal(last.type, 'open-step');
  assert.match(last.text, /agent_not_ready/);
  assert.equal(t.calls().filter((c) => c.key === 'agent start').length, 1);
});

test('GWT-7(改:tab create) 开会话的调用带 --env TICKET_ID=<单号>', () => {
  const t = setup();
  const id = t.open();
  const c = t.calls().find((x) => x.key === 'tab create');
  const i = c.argv.indexOf(`TICKET_ID=${id}`);
  assert.ok(i > 0 && c.argv[i - 1] === '--env', JSON.stringify(c.argv));
  assert.ok(c.argv.includes(`TICKET_STORE=${path.join(t.root, 'demo')}`));
});

test('GWT-8 到上限退 10,没开 pane', () => {
  const t = setup({}, { TICKET_MAX: '2' });
  t.open('a');
  t.open('b');
  const r = t.run('open', '--repo', 'demo', '--title', 'c', '--origin', 'o', '--scope', 's', '--accept', 'true');
  assert.equal(r.status, 10, r.stderr);
  assert.equal(t.calls().filter((c) => c.key === 'tab create').length, 2);
});

test('GWT-9 单会话不能自己收单', () => {
  const t = setup();
  const id = t.open();
  const file = path.join(t.root, 'demo', `${id}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const r = t.run('report', id, '--status', 'closed', '--summary', 'x');
  assert.equal(r.status, 4);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('open 缺参数退 2;tab create 失败退 11', () => {
  const t = setup({ 'tab create': { error: { code: 'workspace_not_found', message: 'no' } } });
  assert.equal(t.run('open', '--repo', 'demo', '--title', 'x').status, 2);
  const r = t.run('open', '--repo', 'demo', '--title', 'x', '--origin', 'o', '--scope', 's', '--accept', 'true');
  assert.equal(r.status, 11);
  assert.equal(t.rec(r.stdout.trim()).status, 'queued');
});

test('开场 prompt 卡住退 13', () => {
  const t = setup({ 'agent prompt': { error: { code: 'agent_prompt_stalled', message: 'no activity' } } });
  const r = t.run('open', '--repo', 'demo', '--title', 'x', '--origin', 'o', '--scope', 's', '--accept', 'true');
  assert.equal(r.status, 13);
  assert.equal(t.rec(r.stdout.trim()).status, 'queued');
});

test('close:只收 ready;关 pane,写 closing', () => {
  const t = setup();
  const id = t.open();
  assert.equal(t.run('close', id).status, 4);
  t.run('report', id, '--status', 'ready', '--summary', 'ok');
  const r = t.run('close', id);
  assert.equal(r.status, 0, r.stderr);
  const pc = t.calls().find((c) => c.key === 'pane close');
  assert.deepEqual(pc.argv, ['pane', 'close', 'wZ:p50']);
  const j = t.rec(id);
  assert.equal(j.status, 'closed');
  assert.ok(j.closing);
});

test('answer 已收的单:新开会话,开场带收尾和答复', () => {
  const t = setup();
  const id = t.open();
  t.run('report', id, '--status', 'ready', '--summary', 'ok');
  t.run('close', id);
  const r = t.run('answer', id, '再查一下边界');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.calls().filter((c) => c.key === 'tab create').length, 2);
  const p = t.calls().filter((c) => c.key === 'agent prompt' && c.argv[2] === id).at(-1);
  assert.match(p.argv[3], /上次收尾/);
  assert.match(p.argv[3], /再查一下边界/);
  assert.equal(t.rec(id).status, 'working');
});

test('board:找不到会话的单标 lost 并只记一次事件;needs-owner 排最前', () => {
  const t = setup({ 'agent list': { result: { agents: [{ name: 'zz', agent: 'claude', pane_id: LEAD }] } } });
  const a = t.open('a');
  const b = t.open('b');
  t.run('report', b, '--status', 'needs-owner', '--summary', 's', '--question', 'q?', '--recommend', 'r');
  const r = t.run('board', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.rows[0].id, b);
  assert.ok(out.rows.find((x) => x.id === a).flags.includes('lost'));
  t.run('board');
  assert.equal(t.evs(a).filter((e) => e.type === 'lost').length, 1);
});

test('board 换 lead pane:原 pane 不在了才改成自己', () => {
  const t = setup({ 'agent list': { result: { agents: [{ name: 'other', agent: 'claude', pane_id: 'wZ:p77' }] } } });
  const id = t.open();
  const r = spawnSync(process.execPath, [BIN, 'board'], {
    encoding: 'utf8',
    env: { ...process.env, TICKET_ROOT: t.root, TICKET_HERDR: FAKE, FAKE_HERDR_LOG: path.join(t.dir, 'herdr.log'), FAKE_HERDR_SCRIPT: path.join(t.dir, 'script.json'), HERDR_PANE_ID: 'wZ:p88', TICKET_ID: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.rec(id).leadPane, 'wZ:p88');
});

test('report 校验:needs-* 要带问题,拆分最多 5 项', () => {
  const t = setup();
  const id = t.open();
  assert.equal(t.run('report', id, '--status', 'needs-lead', '--summary', 'x').status, 2);
  const f = path.join(t.dir, 'split.json');
  fs.writeFileSync(f, JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ title: `s${i}`, accept: ['true'] }))));
  assert.equal(t.run('report', id, '--status', 'needs-lead', '--summary', 'x', '--question', 'q', '--split-json', f).status, 2);
  fs.writeFileSync(f, JSON.stringify([{ title: 's', accept: ['true'] }]));
  assert.equal(t.run('report', id, '--status', 'needs-lead', '--summary', 'x', '--question', 'q', '--split-json', f).status, 0);
  // C-3:needs-lead → needs-lead 不是转移,退 4;回 working 再报。
  assert.equal(t.run('report', id, '--status', 'needs-lead', '--summary', 'y', '--question', 'q', '--split-json', f, '--artifact', 'branch:agent/x@abc').status, 4);
  assert.equal(t.run('report', id, '--status', 'working', '--summary', 'back').status, 0);
  assert.equal(t.run('report', id, '--status', 'needs-lead', '--summary', 'y', '--question', 'q', '--split-json', f, '--artifact', 'branch:agent/x@abc').status, 0);
  const j = t.rec(id);
  assert.equal(j.split.length, 1);
  assert.deepEqual(j.artifacts, [{ kind: 'branch', ref: 'agent/x@abc' }]);
});

test('C-3 非法转移退 4:needs-owner → ready,记录字节不变', () => {
  const t = setup();
  const id = t.open();
  assert.equal(t.run('report', id, '--status', 'needs-owner', '--summary', 'q', '--question', '先跑 staging?', '--recommend', '先跑').status, 0);
  const file = path.join(t.root, 'demo', `${id}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const r = t.run('report', id, '--status', 'ready', '--summary', 'done');
  assert.equal(r.status, 4, r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(t.rec(id).question.text, '先跑 staging?');
  assert.equal(t.leadPrompts().length, 1); // 只叫醒过 needs-owner 那一次
});

test('C-3 非法转移退 4:blocked → ready、failed → ready;回 working 合法', () => {
  const t = setup();
  const id = t.open();
  for (const s of ['blocked', 'failed']) {
    assert.equal(t.run('report', id, '--status', s, '--summary', `到 ${s}`).status, 0);
    const file = path.join(t.root, 'demo', `${id}.json`);
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(t.run('report', id, '--status', 'ready', '--summary', 'done').status, 4);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(t.run('report', id, '--status', 'working', '--summary', '接着做').status, 0);
  }
});

test('outbox 读不出记录:条目留在 outbox,board 提示投不出去', () => {
  const t = setup();
  const id = t.open();
  const outbox = path.join(t.root, 'demo', 'outbox.jsonl');
  fs.writeFileSync(outbox, JSON.stringify({ at: '2026-11-01T00:00:00.000Z', id, line: `[ticket] ${id} ready · x` }) + '\n');
  fs.writeFileSync(path.join(t.root, 'demo', `${id}.json`), `{"id":"${id}","status":"wor`);
  const r = t.run('board');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /有 1 条叫醒因记录读不出来投不出去/);
  assert.equal(fs.readFileSync(outbox, 'utf8').trim().split('\n').length, 1);
  assert.equal(t.leadPrompts().length, 0);
});

test('outbox 锁外发送:herdr 慢回时锁不跨调用,并发补发不重复投、不复活', async () => {
  const t = setup(
    { 'agent prompt': [{ result: {} }, { error: { code: 'agent_blocked', message: 'blocked' } }, { result: {}, delayMs: 2500 }] },
    { TICKET_LOCK_STALE_MS: '500' },
  );
  const id = t.open();
  assert.equal(t.run('report', id, '--status', 'ready', '--summary', 'done').status, 0);
  const outbox = path.join(t.root, 'demo', 'outbox.jsonl');
  assert.equal(fs.readFileSync(outbox, 'utf8').trim().split('\n').length, 1);

  // A:补发(outbox 里那条),herdr 慢回;A 发的时候 B 也来补发。
  const a = spawn(process.execPath, [BIN, 'board'], { env: t.env, cwd: t.dir });
  await new Promise((res) => setTimeout(res, 700));
  // 发送期间:outbox 锁没被占着(herdr 不在锁里跑),条目已经原子取走。
  assert.equal(fs.existsSync(`${outbox}.lock`), false, 'herdr 调用期间不该占着 outbox 锁');
  assert.equal(fs.existsSync(`${outbox}.sending`), true, '条目该被原子取走(改名成 .sending)');
  const b = spawnSync(process.execPath, [BIN, 'board'], { encoding: 'utf8', env: t.env, cwd: t.dir });
  assert.equal(b.status, 0, b.stderr);
  await new Promise((res) => a.on('exit', res));

  // 叫醒只投出去一次:那次被拒的 + 补发的一次。
  assert.equal(t.leadPrompts().length, 2);
  assert.equal(fs.readFileSync(outbox, 'utf8'), '');
  // 没复活:再补发一次不会再投。
  assert.equal(t.run('board').status, 0);
  assert.equal(t.leadPrompts().length, 2);
});

test('投成功后:.sending 里没有已投出的条目,回拨 mtime 再 board 不重投', () => {
  const t = setup({ 'agent prompt': [{ result: {} }, { error: { code: 'agent_blocked', message: 'blocked' } }, { result: {} }] });
  const id = t.open(); // 第 1 次 agent prompt:开场那条
  assert.equal(t.run('report', id, '--status', 'ready', '--summary', 'done').status, 0);
  const outbox = path.join(t.root, 'demo', 'outbox.jsonl');
  assert.equal(fs.readFileSync(outbox, 'utf8').trim().split('\n').length, 1); // 叫醒被拒 → 进 outbox
  assert.equal(t.run('board').status, 0); // 第 3 次 agent prompt:补发成功
  assert.equal(t.leadPrompts().length, 2); // 被拒的那次 + 补发的那次
  const sending = `${outbox}.sending`;
  // 全成功:.sending 里一条都不留(留空文件也行 —— 回收时捞不到行,顺手删掉)。
  const left = fs.existsSync(sending) ? fs.readFileSync(sending, 'utf8') : '';
  assert.equal(left.trim(), '', '已投出的条目不能留在 .sending 里(过期回收会再投一遍)');
  // 假装 3 分钟没动静(默认阈值 180 s):文件不在就补一个空的,保证回收那条路真的走到。
  if (!fs.existsSync(sending)) fs.writeFileSync(sending, '');
  const old = new Date(Date.now() - 200000);
  fs.utimesSync(sending, old, old);
  assert.equal(t.run('board').status, 0);
  assert.equal(t.leadPrompts().length, 2, '同一条叫醒不能投第二次');
  assert.equal(fs.readFileSync(outbox, 'utf8'), '');
});

test('部分失败:.sending 只留没投成功的那条,已投出的那条不再投', () => {
  const t = setup({ 'agent prompt': [{ result: {} }, { result: {} }, { error: { code: 'agent_blocked', message: 'blocked' } }] });
  const id = t.open(); // 第 1 次 agent prompt:开场那条
  const outbox = path.join(t.root, 'demo', 'outbox.jsonl');
  const sending = `${outbox}.sending`;
  const lineA = `[ticket] ${id} ready · A`;
  const lineB = `[ticket] ${id} ready · B`;
  fs.writeFileSync(outbox, [
    JSON.stringify({ at: '2026-11-01T00:00:00.000Z', id, line: lineA }),
    JSON.stringify({ at: '2026-11-01T00:00:01.000Z', id, line: lineB }),
  ].join('\n') + '\n');
  assert.equal(t.run('board').status, 0); // 第 2 次投成功(A),第 3 次被拒(B)
  const sent = (line) => t.leadPrompts().filter((p) => p.argv[3] === line).length;
  assert.equal(sent(lineA), 1);
  assert.equal(sent(lineB), 1);
  const left = fs.readFileSync(sending, 'utf8');
  assert.ok(left.includes(lineB), '没投成功的条目要留着(不丢)');
  assert.ok(!left.includes(lineA), '已投出的条目不能留在 .sending 里');
  const queued = fs.readFileSync(outbox, 'utf8').trim().split('\n');
  assert.equal(queued.length, 1);
  assert.ok(queued[0].includes(lineB), '失败的那条并回 outbox');
  // 再 board 一次(回收那条 .sending):成功的那条不再投,失败的那条还在、且只有一条。
  const old = new Date(Date.now() - 200000);
  fs.utimesSync(sending, old, old);
  assert.equal(t.run('board').status, 0);
  assert.equal(sent(lineA), 1, '已投出的条目不能再投');
  assert.equal(sent(lineB), 2, '没投成功的那条要再试一次(不丢)');
  assert.equal(fs.readFileSync(outbox, 'utf8').trim().split('\n').length, 1, '回收不能把同一条排两次');
});

test('发送循环里每条之前刷新 .sending 的 mtime(阈值量距上次进展多久)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-test-'));
  const root = path.join(dir, 'tickets');
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  const outbox = path.join(root, 'demo', 'outbox.jsonl');
  const sending = `${outbox}.sending`;
  fs.writeFileSync(outbox, ['A', 'B', 'C'].map((k) => JSON.stringify({ id: 't0000-01', line: k })).join('\n') + '\n');
  const prev = process.env.TICKET_ROOT;
  process.env.TICKET_ROOT = root;
  try {
    const ages = [];
    S.outboxFlush('demo', () => {
      ages.push(Math.round((Date.now() - fs.statSync(sending).mtimeMs) / 1000));
      const old = new Date(Date.now() - 200000); // 假装这一条发得很慢
      fs.utimesSync(sending, old, old);
      return true;
    });
    assert.equal(ages.length, 3);
    for (const a of ages) assert.ok(a < 5, `.sending 的 mtime 该在每条之前刷新,实测 ${a} 秒前`);
  } finally {
    if (prev === undefined) delete process.env.TICKET_ROOT;
    else process.env.TICKET_ROOT = prev;
  }
});

test('记录坏了:report / close 退 15,board 出一行「记录坏了」', () => {
  const t = setup();
  const id = t.open();
  fs.writeFileSync(path.join(t.root, 'demo', `${id}.json`), `{"id":"${id}","status":"wor`);
  const r = t.run('report', id, '--status', 'ready', '--summary', 'x');
  assert.equal(r.status, 15, r.stderr);
  assert.match(r.stderr, /记录坏了/);
  assert.doesNotMatch(r.stderr, /at Object|at Module/);
  const c = t.run('close', id);
  assert.equal(c.status, 15, c.stderr);
  const b = t.run('board');
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, new RegExp(`单 ${id} 的记录坏了`));
});

test('抢不到锁退 14(锁忙在退出码表里)', () => {
  const t = setup({}, { TICKET_LOCK_WAIT_MS: '100' });
  const id = t.open();
  // 一个活人(本进程)刚拿着的锁:不是残留,别人抢不到。
  fs.writeFileSync(path.join(t.root, 'demo', `${id}.lock`), JSON.stringify({ pid: process.pid, at: Date.now() }));
  const r = t.run('report', id, '--status', 'ready', '--summary', 'x');
  assert.equal(r.status, 14, r.stderr);
  assert.match(r.stderr, /锁忙/);
});

test('--tab 组名:组 tab 不在就以组名开 tab,单号记进记录', () => {
  const t = setup({ 'tab list': { result: { tabs: [{ label: '别的', tab_id: 'wZ:t1' }] } } });
  const r = t.run('open', '--repo', 'demo', '--title', 'x', '--origin', 'o', '--scope', 's', '--accept', 'true', '--tab', '前端');
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  const c = t.calls().find((x) => x.key === 'tab create');
  assert.equal(c.argv[c.argv.indexOf('--label') + 1], '前端');
  assert.ok(c.argv.includes(`TICKET_ID=${id}`));
  assert.equal(t.calls().filter((x) => x.key === 'pane split').length, 0);
  assert.equal(t.rec(id).tab, '前端');
});

test('--tab 组名:同名 tab 已在就在它最后一个 pane 上分屏,不开新 tab;方向按 pane 数交替', () => {
  const t = setup({
    'tab list': { result: { tabs: [{ label: '前端', tab_id: 'wZ:t7' }] } },
    'pane list': { result: { panes: [{ pane_id: 'wZ:p70', tab_id: 'wZ:t7' }, { pane_id: 'wZ:p71', tab_id: 'wZ:t7' }, { pane_id: 'wZ:p99', tab_id: 'wZ:t1' }] } },
    'pane split': { result: { pane: { pane_id: 'wZ:p72', tab_id: 'wZ:t7' } } },
  });
  const r = t.run('open', '--repo', 'demo', '--title', 'x', '--origin', 'o', '--scope', 's', '--accept', 'true', '--tab', '前端');
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  assert.equal(t.calls().filter((x) => x.key === 'tab create').length, 0);
  const sp = t.calls().find((x) => x.key === 'pane split');
  assert.equal(sp.argv[2], 'wZ:p71');
  assert.equal(sp.argv[sp.argv.indexOf('--direction') + 1], 'down');
  assert.ok(sp.argv.includes(`TICKET_ID=${id}`));
  const start = t.calls().find((x) => x.key === 'agent start');
  assert.equal(start.argv[start.argv.indexOf('--pane') + 1], 'wZ:p72');
});

test('不带 --tab 照旧一单一个 tab', () => {
  const t = setup();
  t.open();
  assert.equal(t.calls().filter((x) => x.key === 'tab create').length, 1);
  assert.equal(t.calls().filter((x) => x.key === 'tab list').length, 0);
});
