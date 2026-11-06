// piw 核心:角色表 / 备用链 / 额度识别 / 冷却 / ask。只依赖 node 标准库。
// 规格:claude-mods docs/plan/2026-10-13-omd-to-mods.md §3.3。bin/omd-lite 的 ask / run 共用这里的分类函数与链展开。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_CONFIG = {
  pi: "auto",
  roles: {
    worker: { chain: ["minimax-cp/MiniMax-M3.1-Flash-Preview:high", "deepseek/deepseek-v4-flash"] },
    continuity: { chain: ["minimax-cp/MiniMax-M3.1-Flash-Preview:xhigh", "deepseek/deepseek-v4-flash"] },
    council: { chain: ["minimax-cp/MiniMax-M3.1-Flash-Preview:high", "deepseek/deepseek-v4-flash"] },
    // 无人值守 cron 的 claude -p 替身(piw agent):只走 MiniMax 包月,不落到按量计费的备用
    cron: { chain: ["minimax-cp/MiniMax-M3.1-Flash-Preview:high"] },
  },
  cooldown: { quotaMinutes: 300, balanceMinutes: 1440 },
  // 撞额度时换同模型的兄弟坐标续跑(D-8):默认关。开了且角色表里有同模型兄弟 → 立刻换,不等等待表
  quotaSiblingSwitch: false,
  // 备用模型每日 token 上限(备用按量计费,没有别的兜底):15.10 实测单日 fallback 峰值约 2.5 亿(含 cacheRead)
  dailyFallbackTokenCap: 300000000,
};

// 退出码:0 成功 · 2 chain 用完 / 配置错 · 3 请求错误(不换坐标)
const EXIT = { ok: 0, exhausted: 2, request: 3 };

// ── 配置 ─────────────────────────────────────────────────────────────────────
const configPath = (env = process.env) => env.PIW_CONFIG || path.join(os.homedir(), ".config", "piw", "config.json");
const cooldownPath = (env = process.env) => env.PIW_COOLDOWN_FILE || path.join(os.homedir(), ".cache", "piw", "cooldown.json");

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { throw new Error(`${file} 不是合法 JSON: ${e.message}`); }
}

/** 全局角色表(文件不存在 = 内置默认)+ 仓库级 <repo>/.claude/piw.json 只覆盖 roles,按角色整条替换。 */
function loadConfig({ repo, env = process.env } = {}) {
  const file = readJson(configPath(env));
  const cfg = {
    pi: file?.pi ?? DEFAULT_CONFIG.pi,
    roles: { ...DEFAULT_CONFIG.roles, ...(file?.roles || {}) },
    cooldown: { ...DEFAULT_CONFIG.cooldown, ...(file?.cooldown || {}) },
    quotaSiblingSwitch: file?.quotaSiblingSwitch ?? DEFAULT_CONFIG.quotaSiblingSwitch,
    dailyFallbackTokenCap: file?.dailyFallbackTokenCap ?? DEFAULT_CONFIG.dailyFallbackTokenCap,
    agentCaps: { ...(file?.agentCaps || {}) },
    callerRoles: { ...(file?.callerRoles || {}) },
    source: file ? configPath(env) : "(内置默认)",
  };
  if (repo) {
    const ov = readJson(path.join(repo, ".claude", "piw.json"));
    if (ov?.roles) { Object.assign(cfg.roles, ov.roles); cfg.source += ` + ${path.join(repo, ".claude", "piw.json")}`; }
  }
  return cfg;
}

/** 解析 pi 可执行文件。顺序:env PIW_PI_BIN → config.pi(非 auto 的显式路径)→ fnm default alias → command -v pi。 */
function resolvePi(cfg, env = process.env) {
  if (env.PIW_PI_BIN) return { bin: env.PIW_PI_BIN, via: "PIW_PI_BIN" };
  if (cfg?.pi && cfg.pi !== "auto") return { bin: cfg.pi, via: "config.pi" };
  const fnmDir = env.FNM_DIR || path.join(os.homedir(), ".local", "share", "fnm");
  const alias = path.join(fnmDir, "aliases", "default", "bin", "pi");
  if (fs.existsSync(alias)) return { bin: alias, via: "fnm default alias" };
  const r = spawnSync("sh", ["-c", "command -v pi"], { encoding: "utf8", env });
  const found = r.status === 0 ? r.stdout.trim() : "";
  return found ? { bin: found, via: "command -v pi" } : { bin: null, via: "未找到" };
}

// ── 坐标 / 分类 / 冷却 ──────────────────────────────────────────────────────────
/** provider/id[:thinking] → 去掉 thinking 后缀的 provider/id(冷却与跳过都按它比) */
const coordBase = (c) => c.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
const sameCoord = (a, b) => a === b || coordBase(a) === coordBase(b);

const RE_QUOTA = /\b(2056|1008)\b|Token Plan|credit balance is too low|insufficient[_ ]balance|Insufficient account balance|\b402\b|quota exceeded|insufficient_quota|usage[_ ]limit|hit your (usage|weekly) limit/i;
const RE_BALANCE = /credit balance is too low|insufficient[_ ]balance|Insufficient account balance|\b402\b/i;
const RE_AUTH = /\b(1004|2049|401|403)\b|invalid api key|unauthorized|authentication/i;
const RE_REQUEST = /\b(2013|1039|1042)\b|\b400\b|bad request|invalid[_ ]request/i;

// 连接层断开(请求还没拿到 HTTP 响应):22.10 02:01 四片同一个 40 s 窗口里每次 10 ms 就失败,pi 自带 3 次重试约 14 s 用完。
const RE_CONN = /Connection error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|socket hang up/i;
const isConnectionError = (text) => RE_CONN.test(String(text || ""));

/** 供应商报错文本 → quota | auth | request | stream。ask 与 run 共用。quota 优先(402 / 2056 带 http 码时也算额度)。 */
function classifyError(text) {
  const t = String(text || "");
  if (RE_QUOTA.test(t)) return "quota";
  if (RE_AUTH.test(t)) return "auth";
  if (RE_REQUEST.test(t)) return "request";
  return "stream"; // 流中断 · 5xx · 其他:换坐标,不写冷却
}
const cooldownMinutes = (text, cfg) => (RE_BALANCE.test(text) ? cfg.cooldown.balanceMinutes : cfg.cooldown.quotaMinutes);

function readCooldown(env = process.env) {
  try { return readJson(cooldownPath(env)) || {}; } catch { return {}; }
}
function isCooling(coord, env = process.env, now = Date.now()) {
  const e = readCooldown(env)[coordBase(coord)];
  return !!e && e.until > now;
}
function setCooldown(coord, text, cfg, env = process.env, now = Date.now()) {
  const file = cooldownPath(env);
  const all = readCooldown(env);
  for (const k of Object.keys(all)) if (!(all[k]?.until > now)) delete all[k]; // 顺手清过期项
  all[coordBase(coord)] = { until: now + cooldownMinutes(text, cfg) * 60000, at: now, reason: String(text).slice(0, 200) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
}

/** 角色 → 展开后的 chain:剔除 skip 里的坐标与冷却中的坐标。返回 { chain, cooling, skipped }。 */
function expandChain(role, cfg, { skip = [], env = process.env } = {}) {
  const r = cfg.roles[role];
  if (!r?.chain?.length) throw new Error(`角色表里没有 ${role}(已有: ${Object.keys(cfg.roles).join(", ")})`);
  const chain = [], cooling = [], skipped = [];
  const budget = [];
  for (const c of r.chain) {
    if (skip.some((s) => sameCoord(s, c))) skipped.push(c);
    else if (isCooling(c, env)) cooling.push(c);
    else if (c.startsWith("anthropic/") && !r.budgetExempt && anthropicOverBudget(env)) budget.push(c);
    else chain.push(c);
  }
  return { chain, cooling, skipped, budget, full: r.chain };
}

// ── 兄弟坐标(D-8:撞额度时换同模型的另一个套餐坐标续跑)────────────────────────
// 开关:环境变量 PIW_QUOTA_SIBLING("1" 开 · "0" 关)优先于配置文件 quotaSiblingSwitch;都没给 = 关(默认关)。
const SWITCH_ON = new Set(["1", "true", "yes", "on"]);
const SWITCH_OFF = new Set(["0", "false", "no", "off"]);
function siblingSwitchOn(cfg, env = process.env) {
  const v = String(env?.PIW_QUOTA_SIBLING ?? "").trim().toLowerCase();
  if (SWITCH_ON.has(v)) return true;
  if (SWITCH_OFF.has(v)) return false;
  return !!cfg?.quotaSiblingSwitch;
}

/**
 * 兄弟坐标:与 coord 供应商不同、第一个 / 之后的部分逐字相同(model id 与 :thinking 后缀都算)、且不是 coord 自己。
 * candidates 由调用方给(通常是 expandChain(...).chain:已剔除冷却中与 skip 掉的坐标)。纯函数:不读文件、不碰环境。
 */
function siblingCoord(coord, candidates) {
  const split = (c) => {
    const i = String(c ?? "").indexOf("/");
    return i < 0 ? null : { provider: c.slice(0, i), model: c.slice(i + 1) };
  };
  const me = split(coord);
  if (!me) return null;
  for (const c of candidates || []) {
    if (!c || c === coord) continue;
    const o = split(c);
    if (!o || o.provider === me.provider || o.model !== me.model) continue;
    return c;
  }
  return null;
}

// ── Anthropic 日限额:Max 附带的 API 额度按日匀速花(控速器每天按 Console 实数写限额文件)──
// 文件 {day, limitUsd, calib, prices:{coord:[in,out,cacheWrite,cacheRead] $/MTok}};缺失或读不了 = 超额(宁可落到下一家,不提前花光)
const anthropicBudgetPath = (env = process.env) => env.PIW_ANTHROPIC_BUDGET_FILE || path.join(os.homedir(), ".cache", "piw", "anthropic-budget.json");
function anthropicSpentToday(b, env = process.env) {
  let usd = 0;
  const file = path.join(usageDir(env), `${localDay()}.jsonl`);
  if (!fs.existsSync(file)) return 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const p = b.prices?.[coordBase(e.model || "")]; const t = e.tokens;
    if (!p || !t) continue;
    usd += ((t.input || 0) * p[0] + (t.output || 0) * p[1] + (t.cacheWrite || 0) * p[2] + (t.cacheRead || 0) * p[3]) / 1e6;
  }
  return usd * (b.calib || 1);
}
/** 不豁免的角色(continuity 等)只能把当天总花费推到 limitUsd − reserveUsd,余量留给关键角色;
 *  关键角色在 config.roles.<role>.budgetExempt=true,不受日限额约束,额度真用完才由 quota 冷却切走。 */
function anthropicOverBudget(env = process.env) {
  let b; try { b = readJson(anthropicBudgetPath(env)); } catch { return true; }
  if (!b || !(b.limitUsd > 0)) return true;
  return anthropicSpentToday(b, env) >= b.limitUsd - (b.reserveUsd || 0);
}
/** 角色:PIW_ROLE > config.callerRoles[caller](按任务难度分 Sonnet / Haiku)> cron */
const roleOf = (cfg, caller, env = process.env) => env.PIW_ROLE || cfg?.callerRoles?.[caller] || "cron";

// ── 用量台账 / 备用模型每日上限(M8a)──────────────────────────────────────────
/** 台账目录:$PIW_USAGE_DIR,缺省 ~/.omd-lite/usage(与 runs 同根)。 */
const usageDir = (env = process.env) => env.PIW_USAGE_DIR || path.join(os.homedir(), ".omd-lite", "usage");

// 台账按**本机本地日期**切分(上限管的是「一天」,不是某个 UTC 日)
const localDay = (ms = Date.now()) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 追加一行用量(一次 pi 尝试一行:主跑与 fallback 各一行)。目录不存在就建。写不进去抛给调用方,本函数不吞。 */
function appendUsage(env, row) {
  const file = path.join(usageDir(env), `${localDay(row.at ? row.at * 1000 : Date.now())}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
  return file;
}

/** agent_end 末条 assistant 的 usage → 台账行里的 tokens(input / output / cacheRead / cacheWrite / total;totalTokens 缺就用四项之和)。没有 usage → null。 */
function tokensOf(usage) {
  if (!usage) return null;
  const t = { input: usage.input || 0, output: usage.output || 0, cacheRead: usage.cacheRead || 0, cacheWrite: usage.cacheWrite || 0 };
  return { ...t, total: usage.totalTokens || t.input + t.output + t.cacheRead + t.cacheWrite };
}

/** 当天台账的用量:按 model 汇总 total,外加 fallback 臂合计(每日上限只按这个判)。 */
function usageToday(env = process.env, now = Date.now()) {
  const file = path.join(usageDir(env), `${localDay(now)}.jsonl`);
  const byModel = {};
  let fallbackTotal = 0;
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; } // 截断的行不计(appendUsage 写的是单行,正常不会截)
    if (!e?.model) continue;
    const t = Number(e.tokens?.total) || 0;
    byModel[e.model] = (byModel[e.model] ?? 0) + t;
    if (e.arm === "fallback") fallbackTotal += t;
  }
  return { byModel, fallbackTotal };
}

/** 备用模型每日 token 上限:env PIW_DAILY_FALLBACK_TOKEN_CAP → config.dailyFallbackTokenCap → 3 亿。 */
function fallbackCap(cfg, env = process.env) {
  const n = Number(env.PIW_DAILY_FALLBACK_TOKEN_CAP ?? cfg?.dailyFallbackTokenCap);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CONFIG.dailyFallbackTokenCap;
}

// ── worker 环境(Q2)──────────────────────────────────────────────────────────────
// 执行体的 bash 继承 pi 的环境:主机 shell 里的密钥(RESEND_API_KEY 等)与指向生产的变量不许跟进去。
// 名字像密钥的、值里有生产域名的一律去掉;PIW_ / OMD_LITE_ 是驱动自己的,照留;PIW_ENV_KEEP=<名,名> 点名放行。
// 模型供应商那一个 key 不走这里,由 runPi 从 ENV_FILE 单独注入。
const SECRET_NAME = /(^|_)(API_?KEY|KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PAT|CREDENTIALS?|DSN)$|(DATABASE|POSTGRES|PG)_?URL$|^(SUPABASE|STRIPE|RESEND|PUBLER|SENTRY|NETLIFY|UPCLOUD|CLOUDFLARE|CF)_/i;
const PROD_VALUE = /prodref0000000000000|example-app\.fi/;
function workerEnv(env = process.env) {
  const keep = new Set(String(env.PIW_ENV_KEEP ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const own = /^(PIW|OMD_LITE)_/.test(k);
    if (!keep.has(k) && !own && (SECRET_NAME.test(k) || PROD_VALUE.test(v))) continue;
    // 带着 HERDR_PANE_ID,codex / agy 的 SessionStart hook 会把批跑会话报给 herdr,重启后在这个 pane 起交互式 resume
    if (/^HERDR_/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// ── pi 事件流 ────────────────────────────────────────────────────────────────
/** 解析 pi --mode json 的 stdout:取最后一个 agent_end。返回 { ok, text, usage } 或 { ok:false, error, usage } 或 null(没有 agent_end)。 */
function parseAgentEnd(stdout) {
  let last = null;
  for (const line of String(stdout).split("\n")) {
    if (!line.startsWith('{"type":"agent_end"')) continue;
    try { last = JSON.parse(line); } catch {}
  }
  if (!last) return null;
  const m = last.messages?.at(-1);
  if (m?.role !== "assistant") return { ok: false, error: "agent_end 末条不是 assistant" };
  const usage = m.usage ?? null;
  if (m.stopReason === "error" || m.stopReason === "aborted") return { ok: false, error: m.errorMessage || m.stopReason, usage };
  const text = (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { ok: true, text, usage };
}

/** ask 用的 pi argv。cwd 是临时空目录(readTools 时是仓根);system / user 文本由调用方给。--approve:项目级 .pi/settings.json 才会被加载(见 README)。 */
const READ_TOOLS = "read,grep,find,ls";
function askArgv({ coord, system, user, readTools = false }) {
  return [
    "-p", "--mode", "json", ...(readTools ? ["--tools", READ_TOOLS] : ["--no-tools"]), "--no-session", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve",
    "--model", coord,
    ...(system ? ["--system-prompt", system] : []),
    user,
  ];
}

// agy 坐标 = agy/<model>(gemini 家族判官;pi 没有这个 provider)。单轮,提示词以 stream-json 从 stdin 进,不受 argv 长度限制;
// 不给 --dangerously-skip-permissions,工具调用一律不批。agy 没有 system 参数,system 拼在 user 前面。
const isAgyCoord = (coord) => coord.startsWith("agy/");
const agyAskArgv = (coord) => ["--model", coord.slice(4), "--disable-slash-commands", "--input-format", "stream-json", "--output-format", "stream-json", "-p", ""];
// agy 是带工具的 agent:headless 下工具被拒后它常常不出正文就收工(20.10 实测 7 份审查材料 5 份空回答),所以开头写死「不用工具」
const AGY_NO_TOOLS = "你在这一轮没有任何可用工具:不读文件、不执行命令、不上网。只依据下面给出的全部文本作答,直接输出最终答案正文。";
const agyAskInput = ({ system, user }) => JSON.stringify({ event: "user", message: { role: "user", content: [AGY_NO_TOOLS, system, user].filter(Boolean).join("\n\n") } }) + "\n";

/** agy stream-json 的 result 事件 → 与 parseAgentEnd 同形的 { ok, text?, error?, usage }。 */
function parseAgyResult(stdout) {
  let last = null;
  for (const line of String(stdout).split("\n")) {
    if (!line.startsWith("{") || !line.includes('"result"')) continue;
    try { const e = JSON.parse(line); if (e.event === "result") last = e.result; } catch {}
  }
  if (!last) return null;
  const u = last.usage || {};
  const usage = { input: u.input_tokens || 0, output: (u.output_tokens || 0) + (u.thinking_tokens || 0), cacheRead: u.cache_read_tokens || 0, totalTokens: u.total_tokens || 0 };
  if (last.status !== "SUCCESS") return { ok: false, error: last.error || last.status, usage };
  return { ok: true, text: last.response || "", usage };
}

function runPiOnce({ bin, argv, cwd, env, timeoutMs, input }) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { cwd, env, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input != null) child.stdin.end(input);
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { err += b; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, out, err: err + e.message, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut }); });
  });
}

/**
 * ask:按 chain 顺序调 pi,单轮无工具。
 * 返回 { exit, text?, failClass?, failCoord?, tried:[{coord,class,detail}] }。stdout / stderr 由 CLI 层负责打印。
 */
async function ask({ role, system, user, cfg, env = process.env, repo, readTools = false, timeoutMs = 600000, log = () => {} }) {
  // 材料里混进 NUL(比如 transcript 里一段 /proc 读数)时 spawn 直接抛 ERR_INVALID_ARG_VALUE,整次 ask 崩成退出码 2(20.10 continuity 实测)
  system = system && system.replace(/\0/g, "");
  user = user.replace(/\0/g, "");
  const { chain, budget } = expandChain(role, cfg, { env });
  if (budget.length) try { appendUsage(env, { at: Math.floor(Date.now() / 1000), label: `ask:${role}`, arm: "budget-skip", role, caller: `ask:${role}`, model: budget[0] }); } catch {}
  const pi = resolvePi(cfg, env);
  const tried = [];
  if (!pi.bin) return { exit: EXIT.exhausted, failClass: "pi-missing", failCoord: "-", tried };
  if (!chain.length) {
    const last = cfg.roles[role].chain.at(-1);
    return { exit: EXIT.exhausted, failClass: "cooldown", failCoord: last, tried };
  }
  for (const coord of chain) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piw-ask-"));
    try {
      // 项目级设置:关掉 pi 对同一模型的 3 次退避重试(换坐标由 piw 自己做)
      fs.mkdirSync(path.join(dir, ".pi"));
      fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({ retry: { enabled: false } }) + "\n");
      let r, end;
      if (isAgyCoord(coord)) {
        r = await runPiOnce({ bin: env.PIW_AGY_BIN || "agy", argv: agyAskArgv(coord), cwd: dir, env, timeoutMs, input: agyAskInput({ system, user }) });
        end = parseAgyResult(r.out);
      } else {
        // 单个 argv 超过约 128 KB 会 E2BIG:大文本落临时目录,以 @file 交给 pi
        let userArg = user;
        if (Buffer.byteLength(user) > 100000) { fs.writeFileSync(path.join(dir, "user.md"), user); userArg = "@user.md"; }
        // 只读工具要在仓里核对文件(分诊卡逐字引用),cwd 换成仓根;此时 .pi/settings.json 不在 cwd,pi 照它默认的重试走
        if (readTools && userArg !== user) userArg = `@${path.join(dir, "user.md")}`;
        r = await runPiOnce({ bin: pi.bin, argv: askArgv({ coord, system, user: userArg, readTools }), cwd: readTools ? repo : dir, env, timeoutMs });
        end = parseAgentEnd(r.out);
      }
      // 台账:每试一个坐标(成功 / 失败 / 空回答)一行 —— ask 的开销也得进 quota-status 的账本。写不进去只报一行,不让一次 ask 因为目录只读而挂掉
      try { appendUsage(env, { at: Math.floor(Date.now() / 1000), label: `ask:${role}`, model: coord, arm: "ask", tokens: tokensOf(end?.usage) }); }
      catch (e) { log(`[piw] 用量台账写不进 ${usageDir(env)}:${e.message}`); }
      if (end?.ok && end.text.trim() !== "") return { exit: EXIT.ok, text: end.text, coord, tried };
      // 空回答(18.10 判官静默吐 1 字节退 0)按失败算:换下一个坐标,不写冷却
      if (end?.ok) {
        tried.push({ coord, class: "empty", detail: "空回答" });
        log(`[piw] ${coord} 失败(empty): 空回答`);
        continue;
      }
      const detail = end ? end.error : r.timedOut ? "timeout" : `pi exit ${r.code}: ${r.err.slice(-300)}`;
      const cls = end ? classifyError(detail) : "stream";
      tried.push({ coord, class: cls, detail: String(detail).slice(0, 300) });
      log(`[piw] ${coord} 失败(${cls}): ${String(detail).slice(0, 160)}`);
      if (cls === "request") return { exit: EXIT.request, failClass: cls, failCoord: coord, tried };
      if (cls === "quota") setCooldown(coord, detail, cfg, env);
      if (cls === "auth") log(`PIW_AUTH ${coord}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const last = tried.at(-1);
  return { exit: EXIT.exhausted, failClass: last.class, failCoord: last.coord, tried };
}

// 调用方要传进沙箱的变量(SANDBOX_ENV_PASS,逗号分隔)与 provider key 合并，不覆盖
function mergeEnvPass(existing, keyVar) {
  const names = (existing ?? "").split(",").filter(Boolean);
  if (keyVar && !names.includes(keyVar)) names.push(keyVar);
  return names.length ? names.join(",") : undefined;
}

module.exports = {
  DEFAULT_CONFIG, EXIT, loadConfig, resolvePi, coordBase, sameCoord, classifyError,
  readCooldown, isCooling, setCooldown, expandChain, siblingSwitchOn, siblingCoord, parseAgentEnd, parseAgyResult, askArgv, agyAskArgv, ask, cooldownPath, configPath,
  usageDir, appendUsage, usageToday, localDay, roleOf, anthropicBudgetPath, anthropicSpentToday, anthropicOverBudget, fallbackCap, workerEnv, isConnectionError, mergeEnvPass,
};
