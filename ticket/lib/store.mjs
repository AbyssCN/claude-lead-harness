import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ACTIVE = new Set(['working', 'ready', 'needs-lead', 'needs-owner', 'blocked']);
export const WAKE = new Set(['ready', 'needs-lead', 'needs-owner', 'blocked', 'failed']);
export const SESSION_STATES = new Set(['working', ...WAKE]);

// C-3 state machine: the only legal targets of `ticket report`, per source state.
// `→ closed` is only reachable through `ticket close`; `closed → working` only through `ticket answer`.
// Same-state transitions (ready → ready) are not transitions and exit 4.
export const REPORT_NEXT = {
  queued: ['working'],
  working: ['ready', 'needs-lead', 'needs-owner', 'blocked', 'failed'],
  ready: ['working'],
  'needs-lead': ['working'],
  'needs-owner': ['working'],
  blocked: ['working'],
  failed: ['working'],
  closed: [],
};

// A lock holder may be inside a herdr call (worst case: prompt timeout 60 s + 15 s margin = 75 s),
// so a lock is leftover only when its holder is gone or it has been held longer than that.
const LOCK_STALE_MS = () => Number(process.env.TICKET_LOCK_STALE_MS ?? 90000);

// An outbox file taken for sending (.sending) older than this means no send can still be in flight.
const SENDING_STALE_MS = () => Number(process.env.TICKET_SENDING_STALE_MS ?? 180000);

// How long to wait for a lock before giving up (exit 14).
const LOCK_WAIT_MS = () => Number(process.env.TICKET_LOCK_WAIT_MS ?? 15000);

export class LockBusy extends Error {}
export class CorruptTicket extends Error {
  constructor(id, msg) { super(`单 ${id} ${msg}`); this.id = id; }
}

export function root() {
  if (process.env.TICKET_ROOT) return process.env.TICKET_ROOT;
  if (process.env.TICKET_STORE) return path.dirname(process.env.TICKET_STORE);
  return path.join(os.homedir(), '.local/share/lead-harness/tickets');
}

export const repoDir = (repo) => path.join(root(), repo);
const now = () => new Date().toISOString();

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Node has no flock(2): O_EXCL lock file; a holder that died or held it past LOCK_STALE_MS counts as leftover.
export function withLock(lockPath, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const h = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        stale = !pidAlive(h.pid) || Date.now() - h.at > LOCK_STALE_MS();
      } catch { stale = true; }
      if (stale) { try { fs.unlinkSync(lockPath); } catch {} continue; }
      if (Date.now() > deadline) throw new LockBusy(`锁忙: ${lockPath}`);
      sleepMs(50);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lockPath); } catch {} }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function repos() {
  try {
    return fs.readdirSync(root(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

export function findRepo(id) {
  const st = process.env.TICKET_STORE;
  if (st && fs.existsSync(path.join(st, `${id}.json`))) return path.basename(st);
  return repos().find((r) => fs.existsSync(path.join(repoDir(r), `${id}.json`))) ?? null;
}

export const ticketFile = (repo, id) => path.join(repoDir(repo), `${id}.json`);
export const eventsFile = (repo, id) => path.join(repoDir(repo), `${id}.events.jsonl`);
const lockFile = (repo, id) => path.join(repoDir(repo), `${id}.lock`);

// A half-written or corrupted snapshot must not read as "no ticket": say which ticket is broken.
export function read(repo, id) {
  let text;
  try {
    text = fs.readFileSync(ticketFile(repo, id), 'utf8');
  } catch (e) {
    throw new CorruptTicket(id, `记录读不出来: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CorruptTicket(id, `记录坏了(JSON 解析不了): ${e.message}`);
  }
}

export function events(repo, id) {
  let text;
  try {
    text = fs.readFileSync(eventsFile(repo, id), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new CorruptTicket(id, `事件流读不出来: ${e.message}`);
  }
  const out = [];
  for (const l of text.split('\n').filter(Boolean)) {
    try { out.push(JSON.parse(l)); }
    catch { throw new CorruptTicket(id, `事件流第 ${out.length + 1} 行坏了`); }
  }
  return out;
}

export function appendEvent(repo, id, ev) {
  fs.appendFileSync(eventsFile(repo, id), JSON.stringify({ at: now(), ...ev }) + '\n');
}

// mutate(rec) returns { rec, events } or null to abort; the snapshot and its events are written under the ticket lock.
export function update(repo, id, mutate) {
  return withLock(lockFile(repo, id), () => {
    const rec = read(repo, id);
    const out = mutate(rec);
    if (!out) return null;
    for (const ev of out.events ?? []) appendEvent(repo, id, ev);
    out.rec.updatedAt = now();
    writeAtomic(ticketFile(repo, id), JSON.stringify(out.rec, null, 2) + '\n');
    return out.rec;
  });
}

export function list(repo) {
  const rs = repo ? [repo] : repos();
  const out = [];
  for (const r of rs) {
    let names = [];
    try { names = fs.readdirSync(repoDir(r)); } catch {}
    for (const n of names) {
      if (!/^t\d{4}-\d+\.json$/.test(n)) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(repoDir(r), n), 'utf8'))); } catch {}
    }
  }
  return out;
}

// Snapshot files that do not parse: board names them instead of skipping them in silence.
export function listBroken(repo) {
  const rs = repo ? [repo] : repos();
  const out = [];
  for (const r of rs) {
    let names = [];
    try { names = fs.readdirSync(repoDir(r)); } catch {}
    for (const n of names) {
      if (!/^t\d{4}-\d+\.json$/.test(n)) continue;
      try { JSON.parse(fs.readFileSync(path.join(repoDir(r), n), 'utf8')); }
      catch (e) { out.push({ id: n.replace(/\.json$/, ''), repo: r, error: e.message }); }
    }
  }
  return out;
}

function helsinkiMMDD() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return p.find((x) => x.type === 'month').value + p.find((x) => x.type === 'day').value;
}

// Numbering is global across repos because herdr agent names are unique per server.
export function create(fields, max) {
  return withLock(path.join(root(), '.open.lock'), () => {
    const all = list();
    const active = all.filter((t) => ACTIVE.has(t.status)).length;
    if (active >= max) return { full: true, active };
    const day = helsinkiMMDD();
    const seq = all.map((t) => t.id.match(new RegExp(`^t${day}-(\\d+)$`))).filter(Boolean).map((m) => Number(m[1]));
    const id = `t${day}-${String(Math.max(0, ...seq) + 1).padStart(2, '0')}`;
    fs.mkdirSync(repoDir(fields.repo), { recursive: true });
    const at = now();
    const rec = {
      id, repo: fields.repo, leadPane: fields.leadPane, title: fields.title, origin: fields.origin,
      scope: fields.scope, accept: fields.accept, status: 'queued', summary: '', question: null, split: null,
      answer: null, artifacts: [], parent: fields.parent ?? null, tab: fields.tab ?? null, closing: null, createdAt: at, updatedAt: at,
    };
    writeAtomic(ticketFile(fields.repo, id), JSON.stringify(rec, null, 2) + '\n');
    appendEvent(fields.repo, id, { type: 'status', from: null, to: 'queued', text: fields.title });
    return { rec };
  });
}

const outboxFile = (repo) => path.join(repoDir(repo), 'outbox.jsonl');
const sendingFile = (repo) => `${outboxFile(repo)}.sending`;

export function outboxAdd(repo, entry) {
  withLock(`${outboxFile(repo)}.lock`, () => fs.appendFileSync(outboxFile(repo), JSON.stringify({ at: now(), ...entry }) + '\n'));
}

// Refresh the mtime of the in-flight file: the stale threshold measures "time since the last
// step", not "how long the batch has been running", so a long batch with a slow send is not
// mistaken for a dead process halfway through.
function touchSending(sending) {
  try {
    const t = new Date();
    fs.utimesSync(sending, t, t);
  } catch {}
}

// A .sending left behind by a crashed run holds entries that were never confirmed delivered:
// put them back into the outbox. Lines already queued in the outbox are skipped (an entry that
// failed to send is written back to the outbox right after the send loop, so it is already there).
function reclaimSending(f, sending) {
  let lines = [];
  try { lines = fs.readFileSync(sending, 'utf8').split('\n').filter(Boolean); } catch { lines = []; }
  let cur = [];
  try { cur = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch {}
  const queued = new Set(cur);
  const back = lines.filter((l) => !queued.has(l));
  try {
    if (back.length) fs.appendFileSync(f, back.map((l) => l + '\n').join(''));
    fs.unlinkSync(sending);
  } catch {}
}

// INV-4: an undelivered wake-up is never lost and never delivered twice.
// Take the entries under the lock (rename to .sending), send outside the lock, write the failures back.
// herdr runs inside `send`, so it must never run while the lock is held.
export function outboxFlush(repo, send) {
  const f = outboxFile(repo);
  const sending = sendingFile(repo);
  if (!fs.existsSync(f) && !fs.existsSync(sending)) return 0;
  const taken = withLock(`${f}.lock`, () => {
    // A .sending left over by a crashed run: those entries were never confirmed delivered, put them back.
    if (fs.existsSync(sending) && Date.now() - fs.statSync(sending).mtimeMs > SENDING_STALE_MS()) {
      reclaimSending(f, sending);
    }
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return null; }
    if (!lines.length) return null;
    try {
      fs.renameSync(f, sending);
      touchSending(sending); // the send is in flight now, not "old"
    } catch { return null; }
    return lines;
  });
  if (!taken) return 0;
  const failed = [];
  let sent = 0;
  for (const l of taken) {
    touchSending(sending); // progress: the threshold measures the time since the last step
    let e = null;
    try { e = JSON.parse(l); } catch { continue; } // 坏行:投不出去也读不出 id,丢掉(与改动前一致)
    let ok = false;
    try { ok = send(e) === true; } catch { ok = false; }
    if (ok) sent++; else failed.push(l);
  }
  withLock(`${f}.lock`, () => {
    let cur = [];
    try { cur = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch {}
    // .sending keeps only what was NOT delivered: a delivered entry left there would be taken
    // back as a dead process's leftover when the threshold expires, and sent a second time
    // (and the rename refreshes the mtime, so that would repeat every 180 s forever).
    // All delivered → truncate to an empty file: reclaiming an empty .sending appends nothing and
    // drops the file, so it behaves like unlink, one branch less.
    try { writeAtomic(sending, failed.map((l) => l + '\n').join('')); } catch {}
    // The failed ones go back into the outbox (never lost). The reclaim above skips the lines
    // that are already queued, so an entry is not sent twice.
    writeAtomic(f, [...failed, ...cur].map((l) => l + '\n').join(''));
  });
  return sent;
}

export function outboxRead(repo) {
  try { return fs.readFileSync(outboxFile(repo), 'utf8').split('\n').filter(Boolean); } catch { return []; }
}
