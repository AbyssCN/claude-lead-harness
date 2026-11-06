"use strict";
// piw cron-report —— 无人值守任务日报(HTML)。只读,不调模型。
// 读数来源(都是现成的账本,不估算):
//   ① piw 用量台账 ~/.omd-lite/usage/<日>.jsonl:agent:<调用方>(claude -p 替身)· ask:<角色> · run 的各臂
//   ② ~/.claude/projects/*/*.jsonl 里 entrypoint=sdk-cli 的会话:还在走 Claude 的无头调用(迁移完应为 0)
//   ③ piw daily 的 DeepSeek 元(lib/report.js)
//   ④ config.cronEffects[<调用方>] = { cmd, cwd }:每个任务「有没有起作用」的读数命令;没登记 = 效果读不出,标红
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const piw = require("./piw.js");

const pad = (n) => String(n).padStart(2, "0");
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const shiftDay = (day, n) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return localDay(d.getTime()); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const M = (n) => (n / 1e6).toFixed(2);

function readRows(env, day) {
  const f = path.join(piw.usageDir(env), `${day}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** 台账行 → 按调用方汇总。agent:* 按 runId 计次;ask:* 每行一次;其余(run 的臂)按 label 计。 */
function byCaller(rows) {
  const g = {};
  for (const r of rows) {
    const label = r.label || "(无 label)";
    const kind = label.startsWith("agent:") ? "agent" : label.startsWith("ask:") ? "ask" : "run";
    const key = kind === "run" ? "piw run(派出去的片)" : label;
    const x = (g[key] ??= { key, kind, runs: new Set(), ok: 0, fail: 0, capped: 0, tokens: 0, wallMs: 0, models: new Set() });
    if (r.capped) { x.capped++; continue; }
    x.runs.add(kind === "agent" ? r.runId : kind === "run" ? label : `${r.at}-${x.runs.size}`);
    if (r.model) x.models.add(r.model);
    x.tokens += Number(r.tokens?.total) || 0;
    if (kind === "agent") { if (r.ok) { x.ok++; x.wallMs += r.wallMs || 0; } else x.fail++; }
  }
  return Object.values(g).map((x) => ({ ...x, calls: x.runs.size, models: [...x.models] })).sort((a, b) => b.tokens - a.tokens);
}

/** 当天开始的 Claude 无头会话(entrypoint sdk-cli),按 (目录, 首句前 40 字) 归组。bridge-* 目录 = 远程会话,有人在,单列。 */
function claudeHeadless(day, env, exempt = []) {
  const root = path.join(env.HOME || os.homedir(), ".claude", "projects");
  const start = new Date(`${day}T00:00:00`).getTime(), end = start + 86400e3;
  const groups = {};
  if (!fs.existsSync(root)) return [];
  for (const proj of fs.readdirSync(root)) {
    const dir = path.join(root, proj);
    let files; try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs < start) continue;
      let ep = null, ts = null, cwd = null, first = null; const tok = { in: 0, cache: 0, out: 0 };
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!line) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        ep ??= d.entrypoint; ts ??= d.timestamp; cwd ??= d.cwd;
        if (ep && ep !== "sdk-cli") break;
        if (first == null && d.type === "user") { const c = d.message?.content; first = typeof c === "string" ? c : JSON.stringify(c); }
        const u = d.type === "assistant" ? d.message?.usage : null;
        if (u) { tok.in += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0); tok.cache += u.cache_read_input_tokens || 0; tok.out += u.output_tokens || 0; }
      }
      if (ep !== "sdk-cli" || !ts) continue;
      const t = Date.parse(ts);
      if (t < start || t >= end) continue;
      const base = path.basename(cwd || "");
      const full = (first || "").replace(/\s+/g, " ");
      const head = full.slice(0, 40);
      // 豁免:cwd 正则测完整 cwd,head 正则测首条 user 文本;读不到 cwd / 首句的按无人值守计(宁可多报)
      const ex = cwd && first ? exempt.find((e) => (!e.cwd || new RegExp(e.cwd).test(cwd)) && (!e.head || new RegExp(e.head).test(full)) && (e.cwd || e.head)) : null;
      const k = `${base}\u0000${head}`;
      const x = (groups[k] ??= { cwd: base, head, attended: base.startsWith("bridge-"), exempt: ex ? ex.name : null, n: 0, in: 0, cache: 0, out: 0 });
      x.n++; x.in += tok.in; x.cache += tok.cache; x.out += tok.out;
    }
  }
  return Object.values(groups).sort((a, b) => b.n - a.n);
}

/** 7 天每天的 agent 调用次数(按调用方)。 */
function trend(env, day, callers) {
  const days = [...Array(7)].map((_, i) => shiftDay(day, i - 6));
  const t = {};
  for (const d of days) for (const x of byCaller(readRows(env, d))) if (callers.includes(x.key)) (t[x.key] ??= {})[d] = x.calls;
  return { days, t };
}

function runEffect(spec, env) {
  if (!spec?.cmd) return null;
  const r = spawnSync("bash", ["-lc", spec.cmd], { cwd: spec.cwd ? spec.cwd.replace(/^~/, env.HOME || os.homedir()) : undefined, encoding: "utf8", timeout: 60000, env });
  const out = `${r.stdout || ""}${r.stderr ? `\n${r.stderr}` : ""}`.trim().split("\n").slice(0, 8).join("\n");
  return { code: r.status, timedOut: r.error?.code === "ETIMEDOUT", out };
}

function build({ day, env = process.env, cfg }) {
  const rows = readRows(env, day);
  const callers = byCaller(rows);
  const agents = callers.filter((x) => x.kind === "agent");
  const claude = claudeHeadless(day, env, cfg.cronClaudeExempt || []);
  const unattendedClaude = claude.filter((x) => !x.attended && !x.exempt);
  const exemptClaude = claude.filter((x) => !x.attended && x.exempt);
  const fallbacks = readFallbacks(env, day);
  let ds = { deepseek: {}, deepseekCny: 0 };
  try { ds = require("./report.js").report({ day, env, rolling: false }); } catch {}
  const effects = cfg.cronEffects || {};
  const eff = Object.fromEntries(agents.map((a) => [a.key, runEffect(effects[a.key.slice(6)], env)]));
  const tr = trend(env, day, agents.map((a) => a.key));
  const caps = cfg.agentCaps || {};
  const capOf = (k) => caps[k.slice(6)] ?? caps.default ?? 24;

  const totals = {
    agentCalls: agents.reduce((a, x) => a + x.calls, 0), agentTokens: agents.reduce((a, x) => a + x.tokens, 0),
    capped: agents.reduce((a, x) => a + x.capped, 0), failed: agents.reduce((a, x) => a + x.fail, 0),
    claudeN: unattendedClaude.reduce((a, x) => a + x.n, 0), claudeOut: unattendedClaude.reduce((a, x) => a + x.out, 0),
    claudeExempt: exemptClaude.reduce((a, x) => a + x.n, 0), fallbacks: fallbacks.length,
    dsCny: ds.deepseekCny || 0, noEffect: agents.filter((a) => !eff[a.key]).length,
  };
  const red = (b, s) => (b ? `<b class="red">${s}</b>` : s);
  const h = [];
  h.push(`<!doctype html><meta charset="utf-8"><title>无人值守任务日报 ${day}</title><style>
body{font:14px/1.5 -apple-system,"Noto Sans SC",sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1d1d1f}
h1{font-size:20px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #e3e3e3;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#f6f6f6}.num{text-align:right;font-variant-numeric:tabular-nums}.red{color:#c00}.muted{color:#888}
pre{margin:0;white-space:pre-wrap;font-size:12px}.kpi{display:flex;gap:12px;flex-wrap:wrap}.kpi div{border:1px solid #e3e3e3;border-radius:6px;padding:8px 12px;min-width:150px}
.kpi b{display:block;font-size:20px}</style>`);
  h.push(`<h1>无人值守任务日报 · ${day}</h1><p class="muted">只读账本生成,不调模型。MiniMax 是包月,单次美元读不到,按次数与 token 看;DeepSeek 按台账折元。</p>`);
  h.push(`<div class="kpi">
<div>MiniMax 无人值守调用<b>${totals.agentCalls}</b>${M(totals.agentTokens)}M token</div>
<div>失败 / 被上限拦下<b>${red(totals.failed > 0, totals.failed)} / ${red(totals.capped > 0, totals.capped)}</b>拦下的不调模型</div>
<div>无人值守 Claude 会话<b>${red(totals.claudeN > 0, totals.claudeN)}</b>另有豁免 ${totals.claudeExempt} · 输出 ${M(totals.claudeOut)}M token</div>
<div>DeepSeek<b>¥${totals.dsCny.toFixed(2)}</b>台账折价</div>
<div>效果读不出的任务<b>${red(totals.noEffect > 0, totals.noEffect)}</b>没登记读数命令</div></div>`);

  h.push(`<h2>按任务(piw agent,cron 角色)</h2><table><tr><th>任务</th><th class="num">次数 / 上限</th><th class="num">成 / 败</th><th class="num">token(M)</th><th class="num">平均墙钟</th><th>近 7 天每天次数</th><th>效果读数</th></tr>`);
  for (const a of agents) {
    const e = eff[a.key];
    const tline = tr.days.map((d) => tr.t[a.key]?.[d] ?? 0).join(" · ");
    const effHtml = !e ? `<b class="red">效果读不出(config.cronEffects.${esc(a.key.slice(6))} 未登记)</b>` : `<pre>${esc(e.out || "(无输出)")}</pre><span class="${e.code === 0 ? "muted" : "red"}">退出码 ${e.timedOut ? "超时" : e.code}</span>`;
    h.push(`<tr><td>${esc(a.key.slice(6))}</td><td class="num">${red(a.calls >= capOf(a.key), `${a.calls} / ${capOf(a.key)}`)}${a.capped ? `<br><b class="red">拦下 ${a.capped}</b>` : ""}</td>
<td class="num">${a.ok} / ${red(a.fail > 0, a.fail)}</td><td class="num">${M(a.tokens)}</td><td class="num">${a.ok ? Math.round(a.wallMs / a.ok / 1000) + " s" : "—"}</td><td>${tline}</td><td>${effHtml}</td></tr>`);
  }
  if (!agents.length) h.push(`<tr><td colspan="7" class="muted">当天没有 piw agent 调用</td></tr>`);
  h.push(`</table>`);

  if (fallbacks.length) {
    h.push(`<h2 class="red">回退到 Claude</h2><table><tr><th>时刻</th><th>任务</th><th>从 → 到</th><th>原因</th></tr>`);
    for (const f of fallbacks) h.push(`<tr><td>${esc(f.at)}</td><td>${esc(f.caller)}</td><td>${esc(f.from)} → ${esc(f.to)}</td><td>${esc(f.why)}</td></tr>`);
    h.push(`</table>`);
  }
  h.push(`<h2>还在走 Claude 的无头会话(claude -p)</h2>`);
  if (!claude.length) h.push(`<p>无。</p>`);
  else {
    h.push(`<table><tr><th>目录</th><th>首句</th><th class="num">次数</th><th class="num">未缓存输入 M</th><th class="num">缓存读 M</th><th class="num">输出 M</th><th>性质</th></tr>`);
    for (const c of claude) h.push(`<tr><td>${esc(c.cwd)}</td><td>${esc(c.head)}</td><td class="num">${c.n}</td><td class="num">${M(c.in)}</td><td class="num">${M(c.cache)}</td><td class="num">${M(c.out)}</td><td>${c.attended ? "远程会话(有人)" : c.exempt ? `豁免:${esc(c.exempt)}` : '<b class="red">无人值守,应迁到 piw-p</b>'}</td></tr>`);
    h.push(`</table><p class="muted">Claude 会话的记录里没有美元字段;按 token 看。</p>`);
  }

  const others = callers.filter((x) => x.kind !== "agent");
  h.push(`<h2>其他 piw 用量(ask / 派出去的片)</h2><table><tr><th>调用方</th><th class="num">次数</th><th class="num">token(M)</th><th>模型</th></tr>`);
  for (const x of others) h.push(`<tr><td>${esc(x.key)}</td><td class="num">${x.calls}</td><td class="num">${M(x.tokens)}</td><td>${esc(x.models.join(", "))}</td></tr>`);
  if (!others.length) h.push(`<tr><td colspan="4" class="muted">无</td></tr>`);
  h.push(`</table>`);

  h.push(`<h2>DeepSeek(按量计费)</h2><table><tr><th>调用方</th><th class="num">元</th></tr>`);
  const dsRows = Object.entries(ds.deepseek || {}).sort((a, b) => b[1].cny - a[1].cny);
  for (const [k, v] of dsRows) h.push(`<tr><td>${esc(k)}</td><td class="num">${v.cny.toFixed(2)}</td></tr>`);
  if (!dsRows.length) h.push(`<tr><td colspan="2" class="muted">无</td></tr>`);
  h.push(`</table>`);
  const cap = require("./capacity.js").capacity({ day, env });
  h.push(require("./capacity.js").html(cap, esc));
  h.push(`<p class="muted">生成于 ${new Date().toISOString()} · piw cron-report</p>`);
  return { html: h.join("\n"), totals, agents, claude, cap };
}

/** 当天的回退记录(~/.omd-lite/cron-fallbacks.jsonl,按 at 的本地日期取)。 */
function readFallbacks(env, day) {
  const f = env.PIW_CRON_FALLBACKS || path.join(env.HOME || os.homedir(), ".omd-lite", "cron-fallbacks.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter((e) => e.at && localDay(Date.parse(e.at)) === day);
}

function sendMail({ subject, html, env }) {
  let key = env.RESEND_API_KEY;
  const envFile = env.PIW_MAIL_ENV || path.join(env.HOME || os.homedir(), ".config", "marketing-hub.env");
  if (!key && fs.existsSync(envFile)) key = (fs.readFileSync(envFile, "utf8").match(/^RESEND_API_KEY=["']?([^"'\n]+)/m) || [])[1];
  if (!key) throw new Error(`没有 RESEND_API_KEY(env 或 ${envFile})`);
  const body = JSON.stringify({ from: env.PIW_MAIL_FROM || "piw <noreply@example.com>", to: [env.PIW_MAIL_TO || "owner@example.com"], subject, html });
  const r = spawnSync("curl", ["-sS", "--max-time", "30", "-X", "POST", "https://api.resend.com/emails", "-H", `Authorization: Bearer ${key}`,
    "-H", "Content-Type: application/json", "--data-binary", "@-"], { input: body, encoding: "utf8" });
  if (r.status !== 0 || !/"id"/.test(r.stdout)) throw new Error(`发信失败: ${r.stdout || r.stderr}`);
  return r.stdout.trim();
}

async function main(argv, env = process.env) {
  const i = argv.indexOf("--day");
  const day = i >= 0 ? argv[i + 1] : shiftDay(localDay(Date.now()), -1);
  const oi = argv.indexOf("--out");
  const out = oi >= 0 ? argv[oi + 1] : path.join(env.HOME || os.homedir(), ".omd-lite", "reports", `cron-${day}.html`);
  const cfg = piw.loadConfig({ env });
  const file = piw.configPath ? piw.configPath(env) : null;
  if (file && fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    cfg.cronEffects = raw.cronEffects || {};
    cfg.cronClaudeExempt = raw.cronClaudeExempt || [];
  }
  const r = build({ day, env, cfg });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, r.html);
  const t = r.totals;
  // 首行格式冻结(SDD 2026-10-25 读数一的判官按它 grep):`无人值守 Claude <N>(豁免 <M>)`
  const line = `cron-report ${day}: MiniMax ${t.agentCalls} 次 · 失败 ${t.failed} · 拦下 ${t.capped} · 无人值守 Claude ${t.claudeN}(豁免 ${t.claudeExempt})· 回退 ${t.fallbacks} · DeepSeek ¥${t.dsCny.toFixed(2)} · 效果读不出 ${t.noEffect} → ${out}`;
  console.log(line);
  console.log(require("./capacity.js").summaryLine(r.cap));
  if (argv.includes("--mail")) {
    const flag = t.claudeN || t.capped || t.failed || t.noEffect || t.fallbacks ? "⚠ " : "";
    console.log(sendMail({ subject: `${flag}无人值守任务日报 ${day}:MiniMax ${t.agentCalls} 次 · 无人值守 Claude ${t.claudeN} · 回退 ${t.fallbacks} · DeepSeek ¥${t.dsCny.toFixed(2)}`, html: r.html, env }));
  }
  return 0;
}

module.exports = { main, build, byCaller, claudeHeadless, readFallbacks, shiftDay };
