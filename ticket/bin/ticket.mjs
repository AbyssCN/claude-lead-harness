#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from '../lib/store.mjs';
import * as H from '../lib/herdr.mjs';

const USAGE = `用法:
  ticket open --repo <仓> --title <t> --origin <o> --scope <s> --accept <cmd>… [--parent <单号>] [--tab <组名>]
  ticket report <单号> --status <s> --summary <一句> [--artifact <kind:ref>]… [--question <q> --recommend <r> [--option <o>]…] [--split-json <文件>]
  ticket note <单号> <一句>
  ticket answer <单号> <答复原文>
  ticket close <单号>
  ticket board [--repo <仓>] [--json]`;

const REPEAT = new Set(['accept', 'artifact', 'option']);
const BOOL = new Set(['json']);

function parse(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) { opts[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new UsageError(`--${k} 缺值`);
    if (REPEAT.has(k)) (opts[k] ??= []).push(v); else opts[k] = v;
  }
  return { opts, pos };
}

class UsageError extends Error {}
class Exit extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const env = (k, d) => Number(process.env[k] ?? d);
const sleep = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const actor = () => (process.env.TICKET_ID ? 'session' : 'lead');
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function normId(raw) {
  const id = String(raw ?? '').toLowerCase();
  if (!/^t\d{4}-\d+$/.test(id) || !NAME_RE.test(id)) throw new UsageError(`单号不对: ${raw}`);
  return id;
}

function locate(raw) {
  const id = normId(raw);
  const repo = S.findRepo(id);
  if (!repo) throw new UsageError(`找不到单 ${id}`);
  return { id, repo };
}

function wakeLine(rec) {
  let s = `[ticket] ${rec.id} ${rec.status} · ${rec.summary || rec.title}`;
  if (rec.question?.recommend) s += ` | 推荐: ${rec.question.recommend}`;
  return s;
}

function wake(rec) {
  const line = wakeLine(rec);
  const r = H.agentPrompt(rec.leadPane, line);
  if (!r.ok) S.outboxAdd(rec.repo, { id: rec.id, line, error: r.code });
  return r.ok;
}

// Returns how many wake-ups could not be delivered because their record could not be read.
function flush(repo) {
  let unreadable = 0;
  for (const r of repo ? [repo] : S.repos()) {
    S.outboxFlush(r, (e) => {
      let pane;
      try { pane = S.read(r, e.id).leadPane; } catch { unreadable++; return false; }
      return H.agentPrompt(pane, e.line).ok;
    });
  }
  return unreadable;
}

function opening(rec, extra = '') {
  const store = S.repoDir(rec.repo);
  let s = `你是 ${rec.id} 的会话。先读 ${store}/${rec.id}.json:origin 是要求原文,scope 是范围,accept 是验收命令。
自己调度子 agent 和 piw。改状态、提问、交产物一律用 \`ticket report\`,进度用 \`ticket note\`;不要给 lead 发 SendMessage,不要用 AskUserQuestion。
只在 做完(ready)/ 要 lead 定 / 要 owner 定 / 卡住 / 失败 时回报;活太大就报 needs-lead 并附拆分建议。
把产物交给别的单(如发版单入队)时,直接发给那张单的会话,同时 \`ticket note\` 记一笔。`;
  if (extra) s += `\n\n${extra}`;
  return s;
}

function sessionCwd(repo) {
  const guess = path.join(os.homedir(), 'repos', repo);
  return fs.existsSync(guess) ? guess : process.cwd();
}

function rootPaneOfNewTab(rec, workspace, sessEnv, step) {
  const tab = H.tabCreate({ workspace, cwd: sessionCwd(rec.repo), label: rec.id, env: sessEnv });
  if (!tab.ok) step(11, 'tab create', tab);
  const pane = tab.result?.root_pane?.pane_id;
  if (!pane) step(11, 'tab create', { code: 'no_root_pane', message: JSON.stringify(tab.result).slice(0, 200) });
  S.appendEvent(rec.repo, rec.id, { type: 'open-step', from: actor(), text: `tab create: ok ${pane}` });
  return pane;
}

// --tab <组名>:同名 tab 已在就在里面分一个 pane,没有就以组名开 tab。分屏方向按 tab 里已有 pane 数交替,免得越分越窄。
function paneInGroupTab(rec, workspace, sessEnv, step) {
  const tabs = H.tabList(workspace);
  const hit = tabs.ok ? (tabs.result?.tabs ?? []).find((t) => t.label === rec.tab) : null;
  if (!hit) {
    const tab = H.tabCreate({ workspace, cwd: sessionCwd(rec.repo), label: rec.tab, env: sessEnv });
    if (!tab.ok) step(11, 'tab create', tab);
    const pane = tab.result?.root_pane?.pane_id;
    if (!pane) step(11, 'tab create', { code: 'no_root_pane', message: JSON.stringify(tab.result).slice(0, 200) });
    S.appendEvent(rec.repo, rec.id, { type: 'open-step', from: actor(), text: `tab create ${rec.tab}: ok ${pane}` });
    return pane;
  }
  const panes = H.paneList(workspace);
  const inTab = panes.ok ? (panes.result?.panes ?? []).filter((p) => p.tab_id === hit.tab_id) : [];
  if (!inTab.length) step(11, 'pane split', { code: 'no_pane_in_tab', message: hit.tab_id });
  const target = inTab[inTab.length - 1].pane_id;
  const sp = H.paneSplit({ pane: target, cwd: sessionCwd(rec.repo), env: sessEnv, direction: inTab.length % 2 ? 'right' : 'down' });
  if (!sp.ok) step(11, 'pane split', sp);
  const pane = sp.result?.pane?.pane_id;
  if (!pane) step(11, 'pane split', { code: 'no_pane', message: JSON.stringify(sp.result).slice(0, 200) });
  S.appendEvent(rec.repo, rec.id, { type: 'open-step', from: actor(), text: `pane split ${rec.tab}: ok ${pane}` });
  return pane;
}

// The three herdr steps of D-9; each failure leaves an open-step event and its own exit code.
function startSession(rec, prompt) {
  const step = (code, what, r) => {
    S.appendEvent(rec.repo, rec.id, { type: 'open-step', from: actor(), text: `${what}: ${r.code} ${r.message ?? ''}`.trim() });
    throw new Exit(code, `${what} 失败: ${r.code} ${r.message ?? ''}`);
  };
  const workspace = process.env.HERDR_WORKSPACE_ID || rec.leadPane.split(':')[0];
  const sessEnv = { TICKET_ID: rec.id, TICKET_STORE: S.repoDir(rec.repo) };
  const pane = rec.tab ? paneInGroupTab(rec, workspace, sessEnv, step) : rootPaneOfNewTab(rec, workspace, sessEnv, step);

  const startMs = env('TICKET_START_TIMEOUT_MS', 90000);
  let st = H.agentStart(rec.id, pane, startMs);
  if (!st.ok && st.code !== 'agent_not_ready') {
    sleep(env('TICKET_RETRY_MS', 2000));
    st = H.agentStart(rec.id, pane, startMs);
  }
  if (!st.ok) step(12, `agent start (pane ${pane})`, st);

  // 17:4x smoke: the first prompt right after a ready `agent start` was once dropped (stalled, idle); give startup hooks a beat.
  sleep(env('TICKET_SETTLE_MS', 3000));
  const pr = H.agentPrompt(rec.id, prompt, { wait: true, until: ['working', 'blocked'], timeoutMs: env('TICKET_PROMPT_TIMEOUT_MS', 60000) });
  if (!pr.ok) step(13, 'agent prompt', pr);
  const g = H.agentGet(rec.id);
  if (g.ok && g.result?.agent?.agent_status === 'blocked') step(13, 'agent prompt', { code: 'agent_blocked', message: '开场后停在确认框' });
  S.appendEvent(rec.repo, rec.id, { type: 'open-step', from: actor(), text: 'agent prompt: ok' });
}

function cmdOpen(opts) {
  for (const k of ['repo', 'title', 'origin', 'scope']) if (!opts[k]) throw new UsageError(`缺 --${k}`);
  if (!opts.accept?.length) throw new UsageError('缺 --accept');
  if (!/^[A-Za-z0-9._-]+$/.test(opts.repo)) throw new UsageError(`仓名不对: ${opts.repo}`);
  const leadPane = process.env.HERDR_PANE_ID;
  if (!leadPane) throw new UsageError('不在 herdr pane 里(没有 HERDR_PANE_ID),叫醒没处投');
  const parent = opts.parent ? normId(opts.parent) : null;
  flush(opts.repo);
  const max = env('TICKET_MAX', 6);
  if (opts.tab !== undefined && !opts.tab.trim()) throw new UsageError('--tab 不能为空');
  const c = S.create({ repo: opts.repo, leadPane, title: opts.title, origin: opts.origin, scope: opts.scope, accept: opts.accept, parent, tab: opts.tab ?? null }, max);
  if (c.full) throw new Exit(10, `已有 ${c.active} 张在开的单,到上限 ${max}`);
  const rec = c.rec;
  console.log(rec.id);
  startSession(rec, opening(rec));
  S.update(rec.repo, rec.id, (r) => {
    const from = r.status;
    r.status = 'working';
    return { rec: r, events: [{ type: 'status', from, to: 'working', text: '会话起来' }] };
  });
}

// C-3: only the transitions in the table are legal; anything else exits 4.
function canReport(from, to) {
  return (S.REPORT_NEXT[from] ?? []).includes(to);
}

function cmdReport(pos, opts) {
  const { id, repo } = locate(pos[0]);
  const to = opts.status;
  if (!to) throw new UsageError('缺 --status');
  if (!opts.summary) throw new UsageError('缺 --summary');
  if (!['queued', 'closed', ...S.SESSION_STATES].includes(to)) throw new UsageError(`未知状态 ${to}`);
  if (opts.question && !to.startsWith('needs-')) throw new UsageError('--question 只配 needs-lead / needs-owner');
  if (to.startsWith('needs-') && !opts.question) throw new UsageError(`${to} 要带 --question`);
  let split = null;
  if (opts['split-json']) {
    if (to !== 'needs-lead') throw new UsageError('--split-json 只配 needs-lead');
    split = JSON.parse(fs.readFileSync(opts['split-json'], 'utf8'));
    if (!Array.isArray(split) || split.length === 0 || split.length > 5) throw new UsageError('拆分建议 1–5 项');
  }
  const artifacts = (opts.artifact ?? []).map((a) => {
    const m = a.match(/^(branch|file|url|run):(.+)$/);
    if (!m) throw new UsageError(`产物格式 kind:ref,kind 是 branch|file|url|run: ${a}`);
    return { kind: m[1], ref: m[2] };
  });
  flush(repo);
  let denied = null;
  const rec = S.update(repo, id, (r) => {
    if (!canReport(r.status, to)) { denied = r.status; return null; }
    const from = r.status;
    r.status = to;
    r.summary = opts.summary;
    r.question = opts.question ? { text: opts.question, recommend: opts.recommend ?? '', options: opts.option ?? [] } : null;
    r.split = split;
    for (const a of artifacts) if (!r.artifacts.some((x) => x.kind === a.kind && x.ref === a.ref)) r.artifacts.push(a);
    return { rec: r, events: [{ type: 'status', from, to, text: opts.summary }] };
  });
  if (!rec) throw new Exit(4, `${id}: ${denied} → ${to} 不允许`);
  if (S.WAKE.has(to)) wake(rec);
}

function cmdNote(pos) {
  const { id, repo } = locate(pos[0]);
  const text = pos.slice(1).join(' ');
  if (!text) throw new UsageError('缺一句话');
  flush(repo);
  S.appendEvent(repo, id, { type: 'note', from: actor(), text });
}

function cmdAnswer(pos) {
  const { id, repo } = locate(pos[0]);
  const text = pos.slice(1).join(' ');
  if (!text) throw new UsageError('缺答复原文');
  flush(repo);
  let prev = null;
  const rec = S.update(repo, id, (r) => {
    if (!(S.WAKE.has(r.status) || r.status === 'closed')) { prev = r.status; return null; }
    prev = r.status;
    r.answer = text;
    r.status = 'working';
    r.question = null;
    return { rec: r, events: [{ type: 'answer', from: 'lead', text }, { type: 'status', from: prev, to: 'working', text: '答复' }] };
  });
  if (!rec) throw new Exit(4, `${id}: ${prev} 不能答复`);
  const msg = `[ticket] ${id} lead 答复: ${text}`;
  const live = prev !== 'closed' && H.agentGet(id);
  if (live && live.ok) {
    const r = H.agentPrompt(id, msg);
    if (!r.ok) {
      S.appendEvent(repo, id, { type: 'open-step', from: 'lead', text: `agent prompt: ${r.code} ${r.message ?? ''}`.trim() });
      throw new Exit(13, `投答复失败: ${r.code}`);
    }
    return;
  }
  const tail = S.events(repo, id).slice(-20).map((e) => JSON.stringify(e)).join('\n');
  const extra = `这张单之前开过会话,现在是新会话接着做。\n上次收尾:\n${rec.closing ?? '(没有)'}\n事件流最后 20 条:\n${tail}\n\n${msg}`;
  try {
    startSession(rec, opening(rec, extra));
  } catch (e) {
    if (e instanceof Exit) throw new Exit(13, e.message);
    throw e;
  }
}

function cmdClose(pos) {
  const { id, repo } = locate(pos[0]);
  flush(repo);
  const rec = S.read(repo, id);
  if (rec.status !== 'ready') throw new Exit(4, `${id}: ${rec.status} → closed 不允许(只收 ready 的单)`);
  const g = H.agentGet(id);
  let closing = null;
  if (g.ok) {
    // A prompt to a working agent returns when the current turn ends, before the closing note is written.
    H.agentWait(id, { timeoutMs: env('TICKET_CLOSE_TIMEOUT_MS', 180000) });
    const askedAt = new Date().toISOString();
    const ask = `[ticket] ${id} 收单。用一条 \`ticket note ${id} "<收尾>"\` 写 ≤ 15 行收尾:做了什么 · 产物 · 留下的坑。写完就停,不再做别的。`;
    const r = H.agentPrompt(id, ask, { wait: true, timeoutMs: env('TICKET_CLOSE_TIMEOUT_MS', 180000) });
    const note = S.events(repo, id).filter((e) => e.type === 'note' && e.at >= askedAt).pop();
    closing = note ? note.text : `(会话没写收尾:${r.ok ? '停下时没有 note' : r.code})`;
    const pane = g.result?.agent?.pane_id;
    const c = pane ? H.paneClose(pane) : { ok: false, code: 'no_pane' };
    S.appendEvent(repo, id, { type: 'open-step', from: 'lead', text: `pane close ${pane}: ${c.ok ? 'ok' : c.code}` });
  } else {
    closing = `(会话已不在:${g.code},没写收尾)`;
  }
  const out = S.update(repo, id, (r) => {
    if (r.status !== 'ready') return null;
    r.status = 'closed';
    r.closing = closing;
    return { rec: r, events: [{ type: 'status', from: 'ready', to: 'closed', text: closing.split('\n')[0] }] };
  });
  if (!out) throw new Exit(4, `${id}: 收单途中状态变了`);
}

const RANK = { 'needs-owner': 0, 'needs-lead': 1, blocked: 2, failed: 2, ready: 3, working: 4, queued: 5, closed: 6 };

function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

function cmdBoard(opts) {
  const repo = opts.repo ?? null;
  const tickets = S.list(repo);
  const al = H.agentList();
  const agents = new Map();
  if (al.ok) for (const a of al.result?.agents ?? []) if (a.name) agents.set(a.name, a);
  const panes = new Set(al.ok ? (al.result?.agents ?? []).map((a) => a.pane_id) : []);

  const me = process.env.HERDR_PANE_ID;
  if (al.ok && me && !process.env.TICKET_ID) {
    for (const t of tickets) {
      if (t.status === 'closed' || t.leadPane === me || panes.has(t.leadPane)) continue;
      S.update(t.repo, t.id, (r) => {
        const old = r.leadPane;
        r.leadPane = me;
        return { rec: r, events: [{ type: 'note', from: 'lead', text: `lead pane ${old} 不在了,改成 ${me}` }] };
      });
      t.leadPane = me;
    }
  }
  const unreadable = flush(repo);

  const broken = S.listBroken(repo);
  const rows = [];
  let newest = 0;
  for (const t of tickets) {
    let evs = [];
    let badEvents = false;
    try { evs = S.events(t.repo, t.id); } catch { badEvents = true; }
    const last = evs.at(-1);
    const a = agents.get(t.id);
    const herdrState = al.ok ? (a ? (a.agent === 'claude' ? a.agent_status : `not-claude:${a.agent}`) : 'gone') : 'herdr?';
    const flags = [];
    const live = t.status !== 'closed' && t.status !== 'queued';
    if (al.ok && live && (!a || a.agent !== 'claude')) {
      flags.push('lost');
      if (last?.type !== 'lost') S.appendEvent(t.repo, t.id, { type: 'lost', from: 'board', text: `herdr: ${herdrState}` });
    }
    if (t.status === 'working' && last && Date.now() - Date.parse(last.at) > 90 * 60000) flags.push('stale');
    if (herdrState === 'blocked') flags.push('herdr-blocked');
    if (badEvents) flags.push('事件流坏了');
    if (S.ACTIVE.has(t.status) && last) newest = Math.max(newest, Date.parse(last.at));
    let rank = RANK[t.status] ?? 5;
    if (flags.includes('lost') || flags.includes('herdr-blocked')) rank = Math.min(rank, 2);
    rows.push({
      id: t.id, repo: t.repo, status: t.status, herdr: herdrState, flags, rank,
      lastAt: last?.at ?? t.updatedAt, title: t.title, summary: t.summary, question: t.question,
      artifacts: t.artifacts,
    });
  }
  rows.sort((x, y) => x.rank - y.rank || (x.lastAt < y.lastAt ? 1 : -1));
  const activeCount = tickets.filter((t) => S.ACTIVE.has(t.status)).length;
  const quiet = activeCount > 0 && Date.now() - newest > 30 * 60000;

  if (opts.json) {
    console.log(JSON.stringify({ quiet, outbox: (repo ? [repo] : S.repos()).reduce((n, r) => n + S.outboxRead(r).length, 0), broken: broken.map((b) => b.id), rows }, null, 2));
    return;
  }
  if (!al.ok) console.log(`! herdr agent list 失败: ${al.code}`);
  if (quiet) console.log('! 最近 30 分钟全部单都没有新事件(Claude 额度可能用完)');
  const pending = (repo ? [repo] : S.repos()).reduce((n, r) => n + S.outboxRead(r).length, 0);
  if (pending) console.log(`! outbox 里还有 ${pending} 条叫醒没投出去`);
  if (unreadable) console.log(`! 有 ${unreadable} 条叫醒因记录读不出来投不出去`);
  for (const b of broken) console.log(`! 单 ${b.id} 的记录坏了,读不出来(${b.repo})`);
  const dayAgo = Date.now() - 86400000;
  let hidden = 0;
  for (const r of rows) {
    if (r.status === 'closed' && Date.parse(r.lastAt) < dayAgo) { hidden++; continue; }
    const flag = r.flags.length ? ` [${r.flags.join(',')}]` : '';
    let tail = r.summary || '';
    if (r.question) tail = `${r.question.text}${r.question.recommend ? ` | 推荐: ${r.question.recommend}` : ''}`;
    console.log(`${r.id}  ${r.status.padEnd(10)} herdr:${r.herdr.padEnd(8)} ${ago(r.lastAt).padStart(4)}${flag}  ${r.title}${tail ? ` — ${tail}` : ''}`);
  }
  if (hidden) console.log(`(另有 ${hidden} 张一天前已收的单没列)`);
  if (!rows.length) console.log('(没有单)');
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    const { opts, pos } = parse(rest);
    switch (cmd) {
      case 'open': return cmdOpen(opts);
      case 'report': return cmdReport(pos, opts);
      case 'note': return cmdNote(pos);
      case 'answer': return cmdAnswer(pos);
      case 'close': return cmdClose(pos);
      case 'board': return cmdBoard(opts);
      default: throw new UsageError(cmd ? `未知子命令 ${cmd}` : '缺子命令');
    }
  } catch (e) {
    if (e instanceof UsageError) { console.error(`ticket: ${e.message}\n${USAGE}`); process.exit(2); }
    if (e instanceof Exit) { console.error(`ticket: ${e.message}`); process.exit(e.code); }
    if (e instanceof S.LockBusy) { console.error(`ticket: ${e.message}`); process.exit(14); }
    if (e instanceof S.CorruptTicket) { console.error(`ticket: ${e.message}`); process.exit(15); }
    throw e;
  }
}

main();
