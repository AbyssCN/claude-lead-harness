"use strict";
// 容量读数(cron-report 一节):只读盘上的账本,不信执行体自报。
//   ① mem-samples.tsv(piw mem-sample 每分钟一行):<epoch>\t<MemAvailable kB>\t<在跑 run 数>
//   ② 闸槽台账 ledger.tsv:epoch action lane slot PIW_GATE arm run目录 [wait_s repo];旧行只有前 7 列
//   ③ runs/*/gate-round-*.log 的「gate-slice: 等了 N s」:台账没有 wait 列时的等待来源
//   ④ runs/*/result.json(完成日 = mtime 本地日)· collect.json steps.merge.status · meta.json .repo
//   ⑤ piw 用量台账里 run 臂的 token
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const piw = require("./piw.js");

const pad = (n) => String(n).padStart(2, "0");
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const home = (env) => env.HOME || os.homedir();
const samplesFile = (env) => env.PIW_MEM_SAMPLES || path.join(home(env), ".omd-lite", "mem-samples.tsv");
const ledgerFile = (env) => env.PIW_GATE_LEDGER || "/tmp/delegate-gate-slots/ledger.tsv";
const runsDir = (env) => env.PIW_RUNS_DIR || path.join(home(env), ".omd-lite", "runs");
const REPOS = ["myapp", "otherapp", "other"];
const TARGET = { running: 12, waitS: 60, notRunPct: 3, memGiB: 15 };  // memGiB:owner 25.10 第二条定 ≥ 15 GiB(第一条是 10)

/** 最近秩百分位;空数组 → null。 */
function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
const repoOf = (p) => { const b = path.basename(String(p || "")); return /myapp/.test(b) ? "myapp" : /otherapp/.test(b) ? "otherapp" : "other"; };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const lines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return []; } };
const metaRepo = (dir) => readJson(path.join(dir, "meta.json"))?.repo;

function memSamples(env, day) {
  const run = [], mem = [];
  for (const l of lines(samplesFile(env))) {
    const [t, kb, n] = l.split("\t").map(Number);
    if (!Number.isFinite(t) || localDay(t * 1000) !== day) continue;
    if (Number.isFinite(kb)) mem.push(kb / 1048576);
    if (Number.isFinite(n)) run.push(n);
  }
  return { n: run.length, p50: pct(run, 50), p90: pct(run, 90), max: run.length ? Math.max(...run) : null,
    memP10: pct(mem, 10), memMin: mem.length ? Math.min(...mem) : null };
}

/** 当天完成的 run(result.json mtime 本地日)。 */
function finishedRuns(env, day) {
  const root = runsDir(env), out = [];
  let names = []; try { names = fs.readdirSync(root); } catch {}
  for (const name of names) {
    const dir = path.join(root, name), rf = path.join(dir, "result.json");
    let st; try { st = fs.statSync(rf); } catch { continue; }
    if (localDay(st.mtimeMs) !== day) continue;
    let logs = []; try { logs = fs.readdirSync(dir).filter((f) => /^gate-round-.*\.log$/.test(f)); } catch {}
    out.push({ name, dir, repo: repoOf(metaRepo(dir)), result: readJson(rf) || {}, logs });
  }
  return out;
}

function gateLedger(env, day) {
  const rows = [];
  for (const l of lines(ledgerFile(env))) {
    const c = l.split("\t");
    const t = Number(c[0]);
    if (!Number.isFinite(t) || localDay(t * 1000) !== day) continue;
    const runDir = c[6] && c[6] !== "-" ? c[6] : null;
    const hasNew = c.length >= 9;
    const repoPath = hasNew && c[8] && c[8] !== "-" ? c[8] : runDir ? metaRepo(runDir) : null;
    const w = hasNew ? Number(c[7]) : NaN;
    rows.push({ action: c[1], gate: c[4], runDir, repo: repoOf(repoPath), wait: Number.isFinite(w) ? w : null });
  }
  return rows;
}

function capacity({ day, env = process.env }) {
  const mem = memSamples(env, day);
  const runs = finishedRuns(env, day);
  const ledger = gateLedger(env, day);
  const by = Object.fromEntries(REPOS.map((r) => [r, { repo: r, finished: 0, waits: [], timeouts: 0, refuses: 0, rounds: 0, notRunTimeout: 0, sliceTokens: 0, slices: new Set(), green: new Set(), greenTokens: 0 }]));
  const covered = new Set();
  for (const r of ledger) {
    const x = by[r.repo];
    if (r.action === "timeout") x.timeouts++;
    else if (r.action === "refuse") x.refuses++;
    else if (r.action === "acquire" && r.gate === "1" && r.wait != null) { x.waits.push(r.wait); if (r.runDir) covered.add(path.resolve(r.runDir)); }
  }
  for (const run of runs) {
    const x = by[run.repo];
    x.finished++;
    x.rounds += run.logs.length;
    if (String(run.result.error || "").includes("闸槽排队超时")) x.notRunTimeout++;
    if (covered.has(path.resolve(run.dir))) continue;
    for (const f of run.logs) for (const l of lines(path.join(run.dir, f))) {
      const m = l.match(/gate-slice: 等了 (\d+(?:\.\d+)?) s,拿到内存闸槽/);
      if (m) x.waits.push(Number(m[1]));
    }
  }
  // MiniMax:run 臂的 token(复用 byCaller 的分类:非 agent:/ask:;call:* 是别的调用方,不算片)
  const f = path.join(piw.usageDir(env), `${day}.jsonl`);
  for (const l of lines(f)) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    const label = r.label || "";
    if (r.capped || !label || /^(agent|ask|call):/.test(label)) continue;
    const dir = path.join(runsDir(env), label);
    const x = by[repoOf(metaRepo(dir))];
    const tok = Number(r.tokens?.total) || 0;
    x.sliceTokens += tok; x.slices.add(label);
    if (readJson(path.join(dir, "collect.json"))?.steps?.merge?.status === "green") { x.green.add(label); x.greenTokens += tok; }
  }
  const repos = REPOS.map((r) => {
    const x = by[r];
    return { repo: r, finished: x.finished, waitN: x.waits.length, waitP50: pct(x.waits, 50), waitP90: pct(x.waits, 90),
      timeouts: x.timeouts, refuses: x.refuses, rounds: x.rounds, notRunTimeout: x.notRunTimeout,
      notRunPct: x.rounds ? (100 * x.notRunTimeout) / x.rounds : null,
      sliceTokens: x.sliceTokens, slices: x.slices.size, green: x.green.size,
      perGreen: x.green.size ? x.sliceTokens / x.green.size : null,
      pending: r === "myapp" && x.finished < 5 };
  });
  const all = REPOS.map((r) => by[r]);
  const allWaits = all.flatMap((x) => x.waits);
  const rounds = all.reduce((a, x) => a + x.rounds, 0), nrt = all.reduce((a, x) => a + x.notRunTimeout, 0);
  const tok = all.reduce((a, x) => a + x.sliceTokens, 0), green = all.reduce((a, x) => a + x.green.size, 0);
  const total = { waitP50: pct(allWaits, 50), notRunPct: rounds ? (100 * nrt) / rounds : null, perGreen: green ? tok / green : null, green, sliceTokens: tok };
  return { day, mem, repos, total };
}

const ok = (b) => (b == null ? "?" : b ? "✓" : "✗");
const f1 = (v, u = "") => (v == null ? "—" : `${Number.isInteger(v) ? v : v.toFixed(1)}${u}`);
const PENDING = "待证伪(myapp 暂停中流量少)";

function summaryLine(c) {
  const m = c.mem, t = c.total;
  return `容量 ${c.day}: 在跑 p50 ${f1(m.p50)} ${ok(m.p50 == null ? null : m.p50 >= TARGET.running)}(目标 ${TARGET.running})/ p90 ${f1(m.p90)} / max ${f1(m.max)}`
    + ` · MemAvailable p10 ${f1(m.memP10, " GiB")} ${ok(m.memP10 == null ? null : m.memP10 >= TARGET.memGiB)} · min ${f1(m.memMin, " GiB")}`
    + ` · 闸槽等待 p50 ${f1(t.waitP50, " s")} ${ok(t.waitP50 == null ? null : t.waitP50 < TARGET.waitS)}`
    + ` · 排队超时没跑 ${f1(t.notRunPct, "%")} ${ok(t.notRunPct == null ? null : t.notRunPct < TARGET.notRunPct)}`
    + ` · 每片 token ${t.perGreen == null ? "—" : (t.perGreen / 1e6).toFixed(2) + "M"}(真片 ${t.green})`;
}

function html(c, esc) {
  const m = c.mem, h = [];
  h.push(`<h2>容量读数(同一台机器 + 同一份 MiniMax 额度)</h2>`);
  h.push(`<p>整机(mem-samples ${m.n} 个采样):在跑 run p50 <b>${f1(m.p50)}</b> ${ok(m.p50 == null ? null : m.p50 >= TARGET.running)}(目标 → ${TARGET.running})· p90 ${f1(m.p90)} · max ${f1(m.max)}
 · MemAvailable p10 <b>${f1(m.memP10, " GiB")}</b> ${ok(m.memP10 == null ? null : m.memP10 >= TARGET.memGiB)}(目标 ≥ ${TARGET.memGiB} GiB)· min ${f1(m.memMin, " GiB")}</p>`);
  h.push(`<table><tr><th>仓</th><th class="num">完成 run</th><th class="num">闸槽等待 p50 / p90(样本)</th><th class="num">timeout / refuse</th><th class="num">排队超时没跑 / 闸轮</th><th class="num">run 片 token(M)</th><th class="num">每片 token(M,真片数)</th></tr>`);
  for (const r of c.repos) {
    h.push(`<tr><td>${esc(r.repo)}${r.pending ? ` <span class="muted">${PENDING}</span>` : ""}</td><td class="num">${r.finished}</td>
<td class="num">${f1(r.waitP50, " s")} ${ok(r.waitP50 == null ? null : r.waitP50 < TARGET.waitS)} / ${f1(r.waitP90, " s")}(${r.waitN})</td>
<td class="num">${r.timeouts} / ${r.refuses}</td>
<td class="num">${r.notRunTimeout} / ${r.rounds} = ${f1(r.notRunPct, "%")} ${ok(r.notRunPct == null ? null : r.notRunPct < TARGET.notRunPct)}</td>
<td class="num">${(r.sliceTokens / 1e6).toFixed(2)}(${r.slices} 片)</td><td class="num">${r.perGreen == null ? "—" : (r.perGreen / 1e6).toFixed(2)}(${r.green})</td></tr>`);
  }
  h.push(`</table><p class="muted">目标:在跑 p50 → ${TARGET.running} · 等待 p50 &lt; ${TARGET.waitS} s · 排队超时没跑 &lt; ${TARGET.notRunPct}% · MemAvailable p10 ≥ ${TARGET.memGiB} GiB。每片 token = 当天 run 片 token ÷ merge 绿的片数。在跑数只有整机读数(槽锁不记仓)。</p>`);
  return h.join("\n");
}

module.exports = { capacity, summaryLine, html, pct, repoOf, PENDING };
