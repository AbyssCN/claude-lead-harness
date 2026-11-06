// piw yield:MiniMax token 换成了多少闸绿的片。只读 runs/*/meta.json 与 pi.jsonl(含 fallback/ · resume-<i>/ · quota-resume-<i>/),零模型,执行体的报告不算。
// 判据(owner 26.10):没有闸结论的 token 占比 < 10% · 每片闸绿的 token < 8M。
// 口径:token = 输入 + 缓存读 + 缓存写 + 输出,全价计(MiniMax Token Plan 对缓存读怎么计费未核实前按全价,owner 26.10);
// 只认 provider 含 minimax 的 assistant 用量;一片的全部用量归它的起片日(赫尔辛基);
// 闸结论 = meta.result.gates 为 pass / fail,或 run 目录有 gate-round 日志(闸判过);其余(not-run、没有 result)都是「没有闸结论」;没有 end_epoch 的片在跑,不进比例。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TARGETS = { noVerdictShare: 0.1, perPass: 8e6 };
const RUNS = path.join(os.homedir(), ".omd-lite", "runs");

const helsinkiDay = (sec) => new Date(sec * 1000).toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });

function scanRun(dir) {
  let tokens = 0, turns = 0, compactions = 0, firstTs = null;
  const add = (u) => { tokens += (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0); };
  // 续跑(连接断开 resume-<i> · 额度恢复 quota-resume-<i>)各写自己的 pi.jsonl,只含续跑那次进程的新调用
  const subs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => /^(fallback|resume-\d+|quota-resume-\d+)$/.test(d)) : [];
  for (const f of [path.join(dir, "pi.jsonl"), ...subs.map((d) => path.join(dir, d, "pi.jsonl"))]) {
    if (!fs.existsSync(f)) continue;
    // 压缩那次调用也花 token;事件里不带供应商,归给它前面最近一条 assistant 的供应商
    let lastMinimax = false;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const comp = line.includes('"compaction_end"');
      if (!comp && (!line.includes('"message_end"') || !line.includes('"assistant"'))) continue;
      let x; try { x = JSON.parse(line); } catch { continue; }
      if (comp) {
        if (x.type === "compaction_end" && x.result?.usage && lastMinimax) { add(x.result.usage); compactions++; }
        continue;
      }
      const m = x.message;
      if (m?.role !== "assistant") continue;
      firstTs ??= m.timestamp ?? null;
      lastMinimax = /minimax/i.test(m.provider ?? "");
      if (!lastMinimax || !m.usage) continue;
      add(m.usage);
      turns++;
    }
  }
  return { tokens, turns, compactions, firstTs };
}

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

// 结局键:前缀 pass / fail 算有闸结论。「fail:闸红后被停」= 闸判过红、执行体修到一半被停(26.10 前驱动把它写成 not-run,这里按 gate-round 日志认回来)
function outcomeKey(meta, dir) {
  const key = gateKey(meta, dir);
  // 照稿片(owner 27.10):gate-slice 绿 ≠ 照稿做完。run 目录有 style-verdict.json(仓里的照稿判官写;ruler: judge = 判官口径,没有 ruler = 旧 style-diff 口径)且不是 pass → 不算闸绿
  const sv = key.startsWith("pass") ? readJson(path.join(dir, "style-verdict.json")) : null;
  if (sv && sv.gates !== "pass") return sv.gates === "fail" ? (sv.ruler === "judge" ? "fail:照稿判官不绿" : "fail:照稿可改未清") : "not-run:照稿未判";
  return key;
}

function gateKey(meta, dir) {
  const r = { ...(readJson(path.join(dir, "result.json")) || {}), ...(meta.result || {}) };
  if (r.gates === "pass" || r.gates === "fail") return r.interrupted ? `${r.gates}:闸红后被停` : r.budget ? `${r.gates}:预算` : r.gates;
  if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /^gate-round-\d+\.log$/.test(f))) return "fail:闸红后被停";
  if (r.gates === "not-run") return `not-run:${r.incomplete || (r.error ? "闸槽" : r.pi_exit ?? meta.pi_exit ?? "?")}`;
  return "none";
}
const hasVerdict = (key) => /^(pass|fail)\b/.test(key);

const blank = (day) => ({ day, runs: 0, running: 0, pass: 0, tokens: 0, noVerdictTokens: 0, turns: 0, outcomes: {} });

function finish(d) {
  d.noVerdictShare = d.tokens ? d.noVerdictTokens / d.tokens : null;
  d.perPass = d.pass ? d.tokens / d.pass : null;
  d.ok = {
    noVerdict: d.noVerdictShare != null && d.noVerdictShare < TARGETS.noVerdictShare,
    perPass: d.perPass != null && d.perPass < TARGETS.perPass,
  };
  d.byOutcome = Object.entries(d.outcomes).map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
  return d;
}

/** since / until:YYYY-MM-DD(赫尔辛基日,含两端);repo:只看这个仓(meta.repo 的目录名)。 */
function yieldReport({ runs = RUNS, since, until, repo } = {}) {
  const today = helsinkiDay(Date.now() / 1000);
  until ??= today;
  since ??= helsinkiDay(Date.now() / 1000 - 6 * 86400);
  const days = {}, repos = {}, total = blank("合计");
  // 照稿(判官口径,otherapp docs/plan/2026-10-27-zhaogao-ruler-yield-sdd.md D-5):只数 style-verdict.json 带 ruler: judge 的片;不归页的片只进合计
  const zhaogao = { runs: 0, tokens: 0, pages: {} };
  for (const label of fs.readdirSync(runs)) {
    const dir = path.join(runs, label);
    const meta = readJson(path.join(dir, "meta.json"));
    if (!meta) continue;
    // 驱动在跑时 meta 还没有 start_epoch,用 pi.jsonl 首条 assistant 的时间归天(先按 mtime 粗筛,免得每次读全部历史)
    if (!meta.start_epoch && (meta.end_epoch || helsinkiDay(fs.statSync(path.join(dir, "meta.json")).mtimeMs / 1000) < since)) continue;
    const repoName = path.basename(meta.repo || "?");
    if (repo && repoName !== repo) continue;
    if (meta.start_epoch && (helsinkiDay(meta.start_epoch) < since || helsinkiDay(meta.start_epoch) > until)) continue;
    const { tokens, turns, firstTs } = scanRun(dir);
    if (!tokens) continue;
    const day = helsinkiDay(meta.start_epoch || firstTs / 1000);
    if (day < since || day > until) continue;
    const d = (days[day] ??= blank(day));
    if (!meta.end_epoch) { d.running++; total.running++; continue; }
    const key = outcomeKey(meta, dir);
    const sv = readJson(path.join(dir, "style-verdict.json"));
    if (sv?.ruler === "judge") {
      zhaogao.runs++; zhaogao.tokens += tokens;
      if (sv.page) {
        const p = (zhaogao.pages[sv.page] ??= { tokens: 0, pass: false, fail: false });
        p.tokens += tokens; p[sv.gates === "pass" ? "pass" : sv.gates === "fail" ? "fail" : "none"] = true;
      }
    }
    for (const t of [d, (repos[repoName] ??= blank(repoName)), total]) {
      t.runs++; t.tokens += tokens; t.turns += turns;
      if (key.startsWith("pass")) t.pass++;
      if (!hasVerdict(key)) t.noVerdictTokens += tokens;
      const o = (t.outcomes[key] ??= { runs: 0, tokens: 0 });
      o.runs++; o.tokens += tokens;
    }
  }
  const list = Object.values(days).sort((a, b) => a.day.localeCompare(b.day)).map(finish);
  const byRepo = Object.values(repos).map(finish).sort((a, b) => b.tokens - a.tokens);
  finish(total);
  for (const p of Object.values(zhaogao.pages)) p.status = p.pass ? "绿" : p.fail ? "不绿" : "未判";
  zhaogao.green = Object.values(zhaogao.pages).filter((p) => p.status === "绿").length;
  zhaogao.perScreen = zhaogao.green ? zhaogao.tokens / zhaogao.green : null;
  return { since, until, repo: repo ?? null, days: list, byRepo, total, zhaogao, targets: TARGETS, text: render(list, total, byRepo, zhaogao) };
}

const M = (n) => (n == null ? "—" : `${(n / 1e6).toFixed(1)}M`);
const pct = (x) => (x == null ? "—" : `${(100 * x).toFixed(0)}%`);
const mark = (ok) => (ok ? "✓" : "✗");

function table(head, list) {
  const rows = [head];
  for (const d of list) {
    rows.push([d.day, d.runs, d.running, d.pass, M(d.tokens), `${pct(d.noVerdictShare)} ${mark(d.ok.noVerdict)}`,
      `${M(d.perPass)} ${mark(d.ok.perPass)}`, d.runs ? Math.round(d.turns / d.runs) : "—"]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd());
}

function render(days, total, byRepo, zhaogao) {
  const lines = table(["日期", "片", "在跑", "闸绿", "token", "无闸结论占比", "每片闸绿", "平均轮数"], [...days, total]);
  lines.push("", "按仓:", ...table(["仓", "片", "在跑", "闸绿", "token", "无闸结论占比", "每片闸绿", "平均轮数"], byRepo));
  lines.push("", `判据:无闸结论占比 < ${pct(TARGETS.noVerdictShare)} · 每片闸绿 < ${M(TARGETS.perPass)}(token = 输入 + 缓存读 + 缓存写 + 输出,全价计;只算 MiniMax)`);
  lines.push("", "合计按结局:");
  for (const o of total.byOutcome) lines.push(`  ${o.key.padEnd(14)} ${String(o.runs).padStart(4)} 片  ${M(o.tokens).padStart(8)}  ${pct(total.tokens ? o.tokens / total.tokens : null)}`);
  if (zhaogao?.runs) {
    lines.push("", `照稿(判官口径):片 ${zhaogao.runs} · token ${M(zhaogao.tokens)} · 判过绿的页 ${zhaogao.green} · 每屏 ${M(zhaogao.perScreen)}`);
    for (const [page, p] of Object.entries(zhaogao.pages).sort((a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]))) lines.push(`  ${page} ${M(p.tokens)} ${p.status}`);
  }
  return lines.join("\n") + "\n";
}

module.exports = { yieldReport, scanRun, helsinkiDay, outcomeKey, TARGETS };
