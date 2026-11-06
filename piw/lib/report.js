// piw report:一天的用量台账 + continuity 的 writer.log / 降级标记 → 一张表。只读,零模型。
// 价格:DeepSeek 官方价目(api-docs.deepseek.com/zh-cn/quick_start/pricing,20.10 抓取),元 / 百万 tokens,高峰价;
// 北京时间周一至周五 9–12、14–18 为高峰,其余半价(中国法定节假日也是半价,这里不认节假日,按高峰算会略高估)。
// Search / Fetch 按次计费(每千次成功请求 5 元):web mod 每次计费成功写一行 deepseek/search|fetch(calls)。memory-hub 的 chat-completion 也写台账。
// 对账:`piw balance` 每小时把账户余额(GET /user/balance,官方接口;DeepSeek 没有官方用量接口,21.10 查证)写进 ~/.omd-lite/balance/<本地日>.jsonl,
// 一天的真实扣费 = 相邻两次快照的余额降幅之和(余额上涨的那段 = 充值,剔除并注明),逐段与台账折价比;差额 > 5% 标红,并列出差额最大的时段里有哪些调用方。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PEAK_PRICES = {
  "deepseek-flash": { hit: 0.04, miss: 2, out: 8 },
  "deepseek-v4-flash": { hit: 0.04, miss: 2, out: 8 }, // 旧名,按 flash 计费
  "deepseek-v4-pro": { hit: 0.3, miss: 9, out: 27 },
};
const TOOL_CNY = 0.005; // Search / Fetch 每次成功请求
// DeepSeek 判据(owner 21.10):每天一律 ≤ 5 元(精简格删了,Codex 额度用完改走 deepseek 审查的日子不再有,10 元的例外取消)。按连续 3 天看。
const TARGETS = { mmSuccess: 0.97, degraded: 0.15, deepseekCny: 5, gapPct: 0.05, days: 3 };
// 余额只有两位小数:差额绝对值不到这个数不标红(否则一天只花几分钱时 1 分钱舍入就超 5%)
const GAP_FLOOR_CNY = 0.02;

function isPeak(atSec) {
  const bj = new Date((atSec + 8 * 3600) * 1000); // UTC 字段读出来就是北京时间
  const dow = bj.getUTCDay(), h = bj.getUTCHours();
  return dow >= 1 && dow <= 5 && ((h >= 9 && h < 12) || (h >= 14 && h < 18));
}

/** 一行台账的人民币(非 deepseek 返回 0;未知 deepseek 型号返回 null)。 */
function rowCny(r) {
  const m = String(r.model || "");
  if (!m.startsWith("deepseek/")) return 0;
  if (m === "deepseek/search" || m === "deepseek/fetch") return (r.calls || 1) * TOOL_CNY;
  const p = PEAK_PRICES[m.slice("deepseek/".length).split(":")[0]];
  if (!p) return null;
  const t = r.tokens || {};
  const k = isPeak(r.at) ? 1 : 0.5;
  return k * ((t.cacheRead || 0) * p.hit + (t.input || 0) * p.miss + (t.output || 0) * p.out) / 1e6;
}

const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()) : []);
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const callerOf = (r) => (/^(ask|call|web|memory-hub):/.test(r.label || "") ? r.label : `run:${r.arm || "?"}`);
const parseRows = (f) => readLines(f).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const dayStartMs = (day) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
const shiftDay = (day, n) => { const [y, m, d] = day.split("-").map(Number); return localDay(new Date(y, m - 1, d + n, 12).getTime()); };
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

function deepseekByCaller(rows) {
  const by = {};
  for (const r of rows) {
    if (!String(r.model || "").startsWith("deepseek/")) continue;
    const who = callerOf(r);
    const g = (by[who] ??= { rows: 0, hit: 0, miss: 0, out: 0, cny: 0, unpriced: 0 });
    const t = r.tokens || {};
    g.rows++; g.hit += t.cacheRead || 0; g.miss += t.input || 0; g.out += t.output || 0;
    const c = rowCny(r);
    if (c === null) g.unpriced++; else g.cny += c;
  }
  return by;
}

/** writer.log 里本地日 = day 的行:{ts, level, msg, data}。 */
function writerLines(file, day) {
  const out = [];
  for (const l of readLines(file)) {
    const m = /^(\S+) (\w+) (.*?)(?: (\{.*\}))?$/.exec(l);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (Number.isNaN(ts) || localDay(ts) !== day) continue;
    let data = null; try { data = m[4] ? JSON.parse(m[4]) : null; } catch {}
    out.push({ ts, level: m[2], msg: m[3], data });
  }
  return out;
}

const reasonKey = (r) => {
  const s = String(r || "");
  if (/超时/.test(s)) return "piw ask 超时";
  if (/验真闸两次未过/.test(s)) return "验真闸两次未过";
  if (s === "empty-section") return "§1/§2 为空";
  const m = /退出码 (\d+)/.exec(s);
  if (m) return `piw ask 退出码 ${m[1]}`;
  return s.slice(0, 40) || "(无原因)";
};

/** 盘上 checkpoint / .degraded 里 mtime 落在 day 的降级标记(会被后一次写覆盖,只用于重建旧日子)。 */
function degradedMarkers(projectsDir, day) {
  const out = [];
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && (e.name === "checkpoint.md" || e.name === "checkpoint.md.degraded")) {
        const st = fs.statSync(p);
        if (localDay(st.mtimeMs) !== day) continue;
        const head = fs.readFileSync(p, "utf8").slice(0, 400);
        const m = /^<!-- DEGRADED:?\s*([\s\S]*?)\s*-->/.exec(head);
        if (m) out.push({ ts: st.mtimeMs, reason: m[1] });
      }
    }
  };
  walk(projectsDir, 0);
  return out;
}

const bump = (o, k, n = 1) => { if (n) o[k] = (o[k] || 0) + n; };

/**
 * 实数口径从新记录上线那一刻起:call 行(每次模型调用)与「writer 结束」行(每次蒸馏)。它们上线前的部分按旧记录重建(近似):
 * ask:continuity 每行 = 一次 pi 尝试,一行 deepseek 意味着它前面那行 minimax 失败;超时 / 崩溃不进 piw 台账,从盘上降级标记补(会漏被覆盖的)。
 */
function continuityStats(rows, wl, markers) {
  const starts = rows.filter((r) => r.arm === "call-start" && r.label === "call:continuity");
  const ends = new Map(rows.filter((r) => r.arm === "call" && r.label === "call:continuity").map((e) => [e.id, e]));
  const writerEnds = wl.filter((l) => l.msg === "writer 结束" && l.data);
  const T0 = starts.length ? Math.min(...starts.map((r) => r.at * 1000)) : Infinity;
  const T1 = writerEnds.length ? Math.min(...writerEnds.map((l) => l.ts)) : Infinity;
  const s = { source: {}, calls: 0, mmOk: 0, dsOk: 0, killed: 0, failures: {}, runs: 0, degraded: 0, reasons: {} };

  // 调用层 · 重建段(T0 之前)
  const att = rows.filter((r) => r.label === "ask:continuity" && r.at * 1000 < T0);
  const mm = att.filter((r) => String(r.model).startsWith("minimax")).length;
  const ds = att.filter((r) => String(r.model).startsWith("deepseek")).length;
  const since = att.length ? Math.min(...att.map((r) => r.at * 1000)) : Infinity;
  const lost = markers.filter((m) => m.ts >= since && m.ts < T0 && /超时|退出码/.test(m.reason));
  for (const m of lost) bump(s.failures, `${reasonKey(m.reason)}(重建)`);
  bump(s.failures, "minimax 失败 → deepseek(重建)", ds);
  s.calls += mm + lost.length; s.mmOk += mm - ds; s.dsOk += ds;
  // 调用层 · 实数段
  // 有起调没收尾 = writer 自己被父进程掐了(21.10 实测:flush 外层 390 s 掐在第二稿中途),这次调用成没成不知道 ——
  // 单独计数,不进 MiniMax 一臂的分子也不进分母(既不算成也不算败)。
  for (const st of starts) {
    const e = ends.get(st.id);
    if (!e) { s.killed++; continue; }
    s.calls++;
    if (e.status === "ok" && String(e.coord || "").startsWith("minimax")) s.mmOk++;
    else if (e.status === "ok" && String(e.coord || "").startsWith("deepseek")) s.dsOk++;
    else bump(s.failures, e.status === "ok" ? `ok 但坐标 ${e.coord}` : e.status === "exit" ? `退出码 ${e.exit}` : e.status);
  }
  s.source.calls = [att.length || lost.length ? "重建(近似)" : "", starts.length ? "call 行(实数)" : ""].filter(Boolean).join(" + ") || "无";

  // writer 层 · 重建段(T1 之前):一次 writer = 一次或两次模型调用(验真闸第 1 次不过会重写一次);降级 = 第 2 次也不过 + 模型失败
  const early = wl.filter((l) => l.ts < T1);
  const f1 = early.filter((l) => /验真闸 fail \(attempt 1\)/.test(l.msg)).length;
  const f2 = early.filter((l) => /验真闸 fail \(attempt 2\)/.test(l.msg)).length;
  const askRows = rows.filter((r) => /^ask:continuity/.test(r.label || "") && r.at * 1000 < T1).length;
  const modelFail = markers.filter((m) => m.ts < T1 && !/验真闸/.test(m.reason));
  if (askRows || modelFail.length) {
    s.runs += askRows - f1 + modelFail.length;
    s.degraded += f2 + modelFail.length;
    bump(s.reasons, "验真闸两次未过(重建)", f2);
    for (const m of modelFail) bump(s.reasons, `${reasonKey(m.reason)}(重建)`);
  }
  // writer 层 · 实数段
  for (const l of writerEnds) { s.runs++; if (l.data.degraded) { s.degraded++; bump(s.reasons, reasonKey(l.data.reason)); } }
  s.source.runs = [askRows || modelFail.length ? "重建(近似)" : "", writerEnds.length ? "writer 结束 行(实数)" : ""].filter(Boolean).join(" + ") || "无";
  return s;
}

/**
 * 余额对账。snaps:{at(秒), cny, available},覆盖 day 前后各一天;rows:同样三天的台账行。
 * 起点 = day 0 点前后 30 分钟内最早的快照,终点 = 次日 0 点前后 30 分钟内最早的快照;起点晚于 0:30 记「开头缺」,没有终点记「未完」。
 */
function reconcile(day, snaps, rows) {
  const t0 = dayStartMs(day) / 1000, t1 = dayStartMs(shiftDay(day, 1)) / 1000, W = 30 * 60;
  const pts = snaps.filter((p) => Number.isFinite(p.cny)).sort((a, b) => a.at - b.at);
  const start = pts.find((p) => p.at >= t0 - W && p.at < t1);
  const end = pts.find((p) => p.at >= t1 - W && p.at <= t1 + W && (!start || p.at > start.at));
  const out = { snaps: 0, start, end, headMissing: !start || start.at > t0 + W, unfinished: !end, topups: [], intervals: [],
    actual: 0, ledger: 0, gap: 0, red: false, unavailable: false };
  if (!start) return out;
  const seg = pts.filter((p) => p.at >= start.at && p.at <= (end ? end.at : t1));
  out.snaps = seg.length;
  out.unavailable = seg.some((p) => p.available === false || p.cny <= 0);
  for (let i = 1; i < seg.length; i++) {
    const a = seg[i - 1], b = seg[i];
    const inside = rows.filter((r) => r.at > a.at && r.at <= b.at);
    const by = {};
    for (const r of inside) { const c = rowCny(r); if (c) by[callerOf(r)] = (by[callerOf(r)] || 0) + c; }
    const ledger = Object.values(by).reduce((x, y) => x + y, 0);
    const drop = a.cny - b.cny;
    if (drop < -0.005) { out.topups.push({ from: a.at, to: b.at, delta: -drop, ledger }); continue; }
    out.intervals.push({ from: a.at, to: b.at, drop, ledger, gap: drop - ledger, by });
    out.actual += drop; out.ledger += ledger;
  }
  out.gap = out.actual - out.ledger;
  const base = Math.max(out.actual, out.ledger);
  out.red = Math.abs(out.gap) > GAP_FLOOR_CNY && (base === 0 || Math.abs(out.gap) / base > TARGETS.gapPct);
  return out;
}

/** 单日判定:不完整 / 账户不可用 / 无数据的日子不判(ok = null),其余逐条比。 */
function dayVerdict(r) {
  const rc = r.reconcile, c = r.continuity;
  const limit = TARGETS.deepseekCny;
  const why = [];
  if (!rc.start) return { ok: null, limit, why: ["没有余额快照"] };
  if (rc.headMissing || rc.unfinished) return { ok: null, limit, why: [rc.unfinished ? "当天未完或缺次日 0 点快照" : "缺当天 0 点快照"] };
  if (rc.unavailable) return { ok: false, limit, why: ["DeepSeek 账户余额不足(调用在失败,低花费不算数)"] };
  if (!c.calls || !c.runs) return { ok: null, limit, why: ["continuity 当天没有调用"] };
  if (rc.red) why.push(`对账差额 ${(100 * rc.gap / Math.max(rc.actual, rc.ledger)).toFixed(1)}% 超 5%`);
  if (rc.actual > limit) why.push(`DeepSeek ${rc.actual.toFixed(2)} 元 > ${limit} 元`);
  if (c.mmOk / c.calls < TARGETS.mmSuccess) why.push(`MiniMax 一臂 ${pct(c.mmOk, c.calls)} < 97%`);
  if (c.degraded / c.runs > TARGETS.degraded) why.push(`降级 ${pct(c.degraded, c.runs)} > 15%`);
  return { ok: why.length === 0, limit, why };
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const M = (n) => (n / 1e6).toFixed(2);
const mark = (ok) => (ok ? "达标" : "未达标");

function report({ day, env = process.env, rolling = true } = {}) {
  day = day || localDay(Date.now());
  const usageDir = env.PIW_USAGE_DIR || path.join(os.homedir(), ".omd-lite", "usage");
  const balanceDir = env.PIW_BALANCE_DIR || path.join(os.homedir(), ".omd-lite", "balance");
  const contDir = env.CONTINUITY_DATA_DIR || path.join(os.homedir(), ".local", "share", "lead-harness", "continuity");
  const rows = parseRows(path.join(usageDir, `${day}.jsonl`));
  const around = [-1, 0, 1].map((n) => shiftDay(day, n));
  const rows3 = around.flatMap((d) => (d === day ? rows : parseRows(path.join(usageDir, `${d}.jsonl`))));
  const rc = reconcile(day, around.flatMap((d) => parseRows(path.join(balanceDir, `${d}.jsonl`))), rows3);
  const wl = writerLines(path.join(contDir, "writer.log"), day);
  const ds = deepseekByCaller(rows);
  const cont = continuityStats(rows, wl, degradedMarkers(path.join(contDir, "projects"), day));

  const total = Object.values(ds).reduce((a, g) => a + g.cny, 0);
  const L = [`# piw report ${day}`, "", "## DeepSeek 按调用方(台账内;元按官方价目、北京高峰 / 空闲分别折算)", "",
    "| 调用方 | 行数 | 缓存命中 M | 未缓存输入 M | 输出 M | 元 |", "|---|---|---|---|---|---|"];
  for (const [who, g] of Object.entries(ds).sort((a, b) => b[1].cny - a[1].cny))
    L.push(`| ${who} | ${g.rows} | ${M(g.hit)} | ${M(g.miss)} | ${M(g.out)} | ${g.cny.toFixed(2)}${g.unpriced ? `(另 ${g.unpriced} 行型号无价)` : ""} |`);
  L.push(`| **合计** | | | | | **${total.toFixed(2)}** |`, "",
    "web:search / web:fetch 按次计(每次成功请求 0.005 元);memory-hub:* 是 memory-hub 自己那把 key 的 chat-completion(同一账户)。", "",
    ...reconcileLines(rc), "",
    "## continuity", "",
    `调用口径:${cont.source.calls};writer 口径:${cont.source.runs}`, "",
    "| 读数 | 值 | 判据 |", "|---|---|---|",
    `| 模型调用 | ${cont.calls} | |`,
    `| MiniMax 一臂成功 | ${cont.mmOk}(${pct(cont.mmOk, cont.calls)}) | ≥ ${TARGETS.mmSuccess * 100}% ${cont.calls ? mark(cont.mmOk / cont.calls >= TARGETS.mmSuccess) : ""} |`,
    `| 落到 deepseek | ${cont.dsOk}(${pct(cont.dsOk, cont.calls)}) | |`,
    `| 调用方被杀(结果未知,不计成败) | ${cont.killed} | |`,
    `| writer 次数 | ${cont.runs} | |`,
    `| 降级 | ${cont.degraded}(${pct(cont.degraded, cont.runs)}) | ≤ ${TARGETS.degraded * 100}% ${cont.runs ? mark(cont.degraded / cont.runs <= TARGETS.degraded) : ""} |`,
    "", "失败(调用层):", ...(Object.keys(cont.failures).length ? Object.entries(cont.failures).map(([k, v]) => `- ${k}: ${v}`) : ["- 无"]),
    "", "降级原因:", ...(Object.keys(cont.reasons).length ? Object.entries(cont.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`) : ["- 无"]),
  );
  const self = { day, deepseek: ds, deepseekCny: total, reconcile: rc, continuity: cont };
  self.verdict = dayVerdict(self);
  const dsCny = rc.headMissing || rc.unfinished ? `台账 ${total.toFixed(2)} 元(余额快照不全,不判)` : `${rc.actual.toFixed(2)} 元(余额实扣)`;
  L.push("", `## 当天判据(DeepSeek ≤ ${TARGETS.deepseekCny} 元 · MiniMax 一臂 ≥ 97% · 降级 ≤ 15% · 对账不红)`, "",
    `DeepSeek ${dsCny} · ${verdictText(self.verdict)}`);
  if (rolling) {
    const days = [];
    for (let n = TARGETS.days - 1; n > 0; n--) days.push(report({ day: shiftDay(day, -n), env, rolling: false }));
    days.push(self);
    const all = days.every((d) => d.verdict.ok === true);
    L.push("", `## 连续 ${TARGETS.days} 天判据 —— ${all ? "达标" : days.some((d) => d.verdict.ok === false) ? "未达标" : "不判(有日子数据不全)"}`, "",
      "| 日 | DeepSeek 元(实扣) | 对账差额 | MiniMax 一臂 | 降级 | 判定 |", "|---|---|---|---|---|---|");
    for (const d of days) {
      const r = d.reconcile, c = d.continuity;
      const full = !(r.headMissing || r.unfinished);
      L.push(`| ${d.day} | ${full ? r.actual.toFixed(2) : "-"} | ${full ? `${r.red ? "🔴 " : ""}${r.gap.toFixed(2)}` : "-"} | ${pct(c.mmOk, c.calls)} | ${pct(c.degraded, c.runs)} | ${verdictText(d.verdict)} |`);
    }
    self.rolling = { ok: all, days: days.map((d) => ({ day: d.day, verdict: d.verdict })) };
  }
  self.text = L.join("\n") + "\n";
  return self;
}

function verdictText(v) {
  if (v.ok === true) return "达标";
  return `${v.ok === false ? "🔴 未达标" : "不判"}:${v.why.join(";")}`;
}

function reconcileLines(rc) {
  const L = ["## 对账:账户余额实扣 vs 台账", ""];
  if (!rc.start) return [...L, "没有当天的余额快照(piw-balance.timer 每小时一次);不对账。"];
  L.push(`快照 ${rc.snaps} 个(${hhmm(rc.start.at * 1000)} → ${rc.end ? hhmm(rc.end.at * 1000) + "(次日)" : "未完"})${rc.headMissing ? ";🔴 缺当天 0 点快照,开头一段没对上" : ""}`);
  if (rc.unavailable) L.push("🔴 账户余额不足(is_available=false 或余额 ≤ 0):DeepSeek 调用在失败,兜底与判官都不可用,当天的低花费不算数。");
  for (const t of rc.topups) L.push(`- ${hhmm(t.from * 1000)}–${hhmm(t.to * 1000)} 余额上涨 ${t.delta.toFixed(2)} 元(充值),这段不对账(台账这段 ${t.ledger.toFixed(2)} 元)`);
  const base = Math.max(rc.actual, rc.ledger);
  L.push("", "| 读数 | 元 |", "|---|---|",
    `| 余额实扣 | ${rc.actual.toFixed(2)} |`, `| 台账折价 | ${rc.ledger.toFixed(2)} |`,
    `| 差额(实扣 − 台账) | ${rc.red ? "🔴 " : ""}${rc.gap.toFixed(2)}(${base ? ((100 * rc.gap) / base).toFixed(1) : "0.0"}%)${rc.red ? " 超 5%" : ""} |`);
  if (rc.red) {
    L.push("", "差额最大的时段(台账在这段记了哪些调用方;一行都没有 = 台账外的调用方):");
    for (const iv of [...rc.intervals].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 5).filter((iv) => Math.abs(iv.gap) > 0.005)) {
      const who = Object.entries(iv.by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" · ") || "台账里没有 DeepSeek 行 → 台账外调用方";
      L.push(`- ${hhmm(iv.from * 1000)}–${hhmm(iv.to * 1000)}:实扣 ${iv.drop.toFixed(2)} · 台账 ${iv.ledger.toFixed(2)} · 差 ${iv.gap.toFixed(2)} —— ${who}`);
    }
  }
  return L;
}

module.exports = { report, reconcile, rowCny, isPeak, PEAK_PRICES, TARGETS };
