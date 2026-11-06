"use strict";
// piw agent —— `claude -p` 的替身:同一套常用参数,执行体换成 pi + 角色表(默认 cron 角色 = MiniMax)。
// 无人值守的 cron / timer 把 `claude` 换成 `piw-p` 即可;结果照 claude 的 stream-json / json / text 形状输出,
// 现有「取 type:"result" 那条」的解析不用改。每次调用进 piw 用量台账(label = agent:<caller>),
// 并按调用方做每日次数上限(模型之外的闸:一天跑几百次这种事由这里拦,不靠调用方自觉)。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const piw = require("./piw.js");

const DEFAULT_CAP = 24; // 每个调用方每天最多几次;config.agentCaps.default / agentCaps[<caller>] 覆盖
const DEFAULT_TIMEOUT_S = 1800;
const BUILTIN = ["read", "grep", "find", "ls", "edit", "write", "bash"];

// claude 工具名 → pi 工具名。没列的(WebFetch / Task / NotebookRead …)pi 没有,记进 unsupported。
const TOOL_MAP = {
  Read: ["read"], Grep: ["grep"], Glob: ["find", "ls"], LS: ["ls"],
  Edit: ["edit"], MultiEdit: ["edit"], NotebookEdit: ["edit"], Write: ["write"], Bash: ["bash"],
};

// 取值型参数(后面跟一个值)与可变长参数(一直吃到下一个 -- 开头的)
const VALUE_FLAGS = new Set(["--output-format", "--input-format", "--model", "--permission-mode", "--agent", "--append-system-prompt",
  "--system-prompt", "--system-prompt-file", "--append-system-prompt-file", "-n", "--name", "--max-turns", "--setting-sources",
  "--mcp-config", "--session-id", "--fallback-model", "--resume", "-r"]);
const LIST_FLAGS = new Set(["--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--add-dir"]);

/** claude -p 的 argv → 选项。未知的 -- 参数记进 ignored(不报错:调用方写的 claude 专有开关在这里没有意义)。 */
function parseClaudeArgs(argv) {
  const o = { allowed: null, disallowed: [], ignored: [], prompt: null, outputFormat: "text" };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--print") continue;
    const eq = a.startsWith("--") && a.includes("=") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (LIST_FLAGS.has(flag)) {
      const vals = eq > 0 ? [a.slice(eq + 1)] : [];
      if (eq < 0) while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) vals.push(argv[++i]);
      const items = vals.flatMap(splitToolList);
      if (/^--allowed/.test(flag)) o.allowed = [...(o.allowed || []), ...items];
      else if (/^--disallowed/.test(flag)) o.disallowed.push(...items);
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (flag === "--output-format") o.outputFormat = v;
      else if (flag === "--model") o.model = v;
      else if (flag === "--agent") o.agent = v;
      else if (flag === "--append-system-prompt") o.append = [...(o.append || []), v];
      else if (flag === "--append-system-prompt-file") o.append = [...(o.append || []), fs.readFileSync(v, "utf8")];
      else if (flag === "--system-prompt") o.system = v;
      else if (flag === "--system-prompt-file") o.system = fs.readFileSync(v, "utf8");
      else if (flag === "-n" || flag === "--name") o.name = v;
      else if (flag === "--max-turns") o.maxTurns = Number(v);
      else if (flag === "--mcp-config") o.mcpConfig = v;
      else o.ignored.push(`${flag}=${v}`);
      continue;
    }
    if (a === "--strict-mcp-config") { o.strictMcp = true; continue; }
    if (a.startsWith("-")) { o.ignored.push(a); continue; }
    positional.push(a);
  }
  if (positional.length) o.prompt = positional.join(" ");
  return o;
}

/** "Read,Grep Bash(git log:*)" 这类写法 → 单项列表(括号里的逗号 / 空格不拆)。 */
function splitToolList(s) {
  const out = []; let cur = "", depth = 0;
  for (const ch of String(s)) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && (ch === "," || ch === " ")) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** ~/.claude/agents/<name>.md(或 <cwd>/.claude/agents/)→ { body, tools }。frontmatter 的 tools 当允许表。 */
function loadAgentDef(name, cwd, env = process.env) {
  const home = env.HOME || os.homedir();
  for (const dir of [path.join(cwd, ".claude", "agents"), path.join(home, ".claude", "agents")]) {
    const f = path.join(dir, `${name}.md`);
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, "utf8");
    const m = txt.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return { file: f, body: txt, tools: null };
    const tl = m[1].match(/^tools:\s*(.+)$/m);
    return { file: f, body: m[2], tools: tl ? splitToolList(tl[1]) : null };
  }
  throw new Error(`找不到 agent 定义 ${name}.md(查了 ${cwd}/.claude/agents 与 ~/.claude/agents)`);
}

/**
 * claude 的允许 / 禁止表 → pi 的 --tools 与 guard 设置。
 * 返回 { tools: [...pi 工具名], bashPrefixes: null(不限)| [...前缀], unsupported: [...] , mcp: [...] }。
 * allowed 为 null = 调用方没限制 → 全部内置工具(同 claude 在 bypass 下的默认)。
 */
function mapTools(allowed, disallowed = []) {
  const tools = new Set(); const unsupported = []; const mcp = [];
  let bashPrefixes = null; let bashFull = false;
  const items = allowed ?? BUILTIN.map((t) => t);
  for (const raw of items) {
    if (BUILTIN.includes(raw)) { tools.add(raw); if (raw === "bash") bashFull = true; continue; }
    if (raw.startsWith("mcp__")) { mcp.push(raw); continue; }
    const m = raw.match(/^(\w+)(?:\((.*)\))?$/);
    if (!m) { unsupported.push(raw); continue; }
    const [, name, arg] = m;
    if (name === "Bash" && arg != null) {
      tools.add("bash");
      bashPrefixes = [...(bashPrefixes || []), arg.replace(/(:\*|\s\*)$/, "").trim()];
      continue;
    }
    if (TOOL_MAP[name]) { for (const t of TOOL_MAP[name]) tools.add(t); if (name === "Bash") bashFull = true; continue; }
    unsupported.push(raw);
  }
  for (const raw of disallowed) {
    const name = raw.replace(/\(.*$/, "");
    if (raw.includes("(")) continue; // 带参数的禁止项(Bash(rm:*))靠允许前缀表兜,不整类去掉
    for (const t of TOOL_MAP[name] || (BUILTIN.includes(name) ? [name] : [])) tools.delete(t);
  }
  if (bashFull) bashPrefixes = null;
  if (!tools.has("bash")) bashPrefixes = null;
  return { tools: [...tools], bashPrefixes, unsupported, mcp };
}

/**
 * 按引号拆 shell 命令:引号外的 && || ; | & 换行切段;引号外出现 $( ` 或 > 重定向(2>&1 / >&2 这类 fd 复制除外)记 unsafe。
 * 引号里的这些字符原样留在段里(rg '"a"|"b"' 是一段)。不是完整的 shell 解析器,只为受限前缀判断用:拿不准的一律算 unsafe。
 */
function splitShell(cmd) {
  const parts = []; let cur = ""; let q = null; let unsafe = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1];
    if (q) {
      if (c === "\\" && q === '"') { cur += c + (n ?? ""); i++; continue; }
      if (c === q) q = null;
      else if (q === '"' && ((c === "$" && n === "(") || c === "`")) unsafe ??= "命令替换";
      cur += c; continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "\\") { cur += c + (n ?? ""); i++; continue; }
    if ((c === "$" && n === "(") || c === "`") unsafe ??= "命令替换";
    if (c === ">" || c === "<") {
      const fdDup = c === ">" && (n === "&" || /[0-9]$/.test(cur) && cmd[i + 1] === "&");
      if (!fdDup && !(c === ">" && /[0-9]&$/.test(cur))) unsafe ??= "重定向";
    }
    if (c === ";" || c === "\n" || c === "|" || (c === "&" && cur.slice(-1) !== ">" && n !== ">")) {
      if (cur.trim()) parts.push(cur.trim());
      cur = ""; if ((c === "|" || c === "&") && n === c) i++;
      continue;
    }
    cur += c;
  }
  if (q) unsafe ??= "引号没闭合";
  if (cur.trim()) parts.push(cur.trim());
  return { parts, unsafe };
}

/** 受限 bash:每段都得以某个允许前缀开头;引号外的命令替换与重定向一律拒。 */
function bashAllowed(cmd, prefixes) {
  if (!prefixes) return { ok: true };
  const { parts, unsafe } = splitShell(String(cmd));
  if (unsafe) return { ok: false, reason: `受限 bash 不许${unsafe}` };
  for (const part of parts) {
    if (!prefixes.some((p) => part === p || part.startsWith(p + " ") || (/[\/\-_.]$/.test(p) && part.startsWith(p)))) return { ok: false, reason: `不在允许前缀里: ${part.slice(0, 80)}` };
  }
  return { ok: true };
}

/** MCP 工具名(pi 名)是否放行:先看禁止表,再要求命中允许表;* 通配。 */
function mcpAllowed(name, allow = [], deny = []) {
  const hit = (pats) => pats.some((p) => new RegExp(`^${p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name));
  if (hit(deny)) return { ok: false, reason: `${name} 在禁止表里` };
  if (!hit(allow)) return { ok: false, reason: `${name} 不在允许表里` };
  return { ok: true };
}

/** 调用方名字:PIW_CALLER → -n → --agent → cwd 目录名。 */
function callerOf(o, cwd, env = process.env) {
  if (env.PIW_CALLER) return { caller: env.PIW_CALLER, source: "PIW_CALLER" };
  if (o.name) return { caller: o.name, source: "-n" };
  if (o.agent) return { caller: `agent-${o.agent}`, source: "--agent" };
  return { caller: path.basename(cwd), source: "cwd" };
}

function capOf(cfg, caller, env = process.env) {
  if (env.PIW_AGENT_CAP != null && env.PIW_AGENT_CAP !== "") return Number(env.PIW_AGENT_CAP);
  const caps = cfg.agentCaps || {};
  return Number(caps[caller] ?? caps.default ?? DEFAULT_CAP);
}

/** 今天这个调用方已经起了几次(按 runId 去重:一次调用换坐标会写多行)。 */
function runsToday(caller, env = process.env, now = Date.now()) {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const file = path.join(piw.usageDir(env), `${day}.jsonl`);
  const ids = new Set();
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.label === `agent:${caller}` && e.arm === "agent" && !e.capped) ids.add(e.runId || line);
  }
  return ids.size;
}

const GUARD_EXT = path.resolve(__dirname, "..", "ext", "agent-guard.ts");

/**
 * claude 写法的 MCP 允许项(mcp__<服务>__<工具> / mcp__<服务>)→ pi 的工具名与要连的服务。
 * pi 的工具名把服务名里的 - 换成 _;claude 的名字保留 -。只连允许表点名的服务,只开点名的工具(整服务 = 通配)。
 */
function mcpPlan(allowedMcp, servers) {
  const want = new Map(); const missing = [];
  for (const raw of allowedMcp) {
    const m = raw.match(/^mcp__(.+?)(?:__(.+))?$/);
    if (!m) continue;
    const [, server, tool] = m;
    const name = Object.keys(servers).find((n) => n === server || n.replace(/-/g, "_") === server);
    if (!name) { missing.push(raw); continue; }
    const pre = `mcp__${name.replace(/-/g, "_")}`;
    (want.get(name) ?? want.set(name, new Set()).get(name)).add(tool ? `${pre}__${tool}` : `${pre}__*`);
  }
  const config = { autoEnableCodemode: false, mcpServers: {} };
  for (const name of want.keys()) config.mcpServers[name] = { ...servers[name], exposure: "direct" };
  return { tools: [...want.values()].flatMap((s) => [...s]), config, missing };
}

/** claude 的 .mcp.json(或 --mcp-config 给的文件)→ mcpServers;--strict-mcp-config 时只认 --mcp-config。 */
function readMcpServers(o, cwd) {
  const files = [o.mcpConfig, o.strictMcp ? null : path.join(cwd, ".mcp.json")].filter(Boolean);
  const out = {};
  for (const f of files) {
    try { Object.assign(out, JSON.parse(fs.readFileSync(path.resolve(cwd, f), "utf8")).mcpServers || {}); } catch {}
  }
  return out;
}

/** 临时 pi agent 目录:真目录里的东西(auth.json / models.json …)逐项软链进来,只换 mcp.json。 */
function mcpAgentDir(config, env) {
  const real = env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), ".pi", "agent");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piw-agent-mcp-"));
  try { for (const n of fs.readdirSync(real)) if (n !== "mcp.json") fs.symlinkSync(path.join(real, n), path.join(dir, n)); } catch {}
  fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify(config, null, 2));
  return dir;
}

function piArgv({ coord, tools, system, append, prompt, mcp = false }) {
  return [
    "-p", "--mode", "json", "--no-session", "--no-extensions", "-e", GUARD_EXT, ...(mcp ? ["-e", "builtin:mcp"] : []), "--no-skills", "--no-prompt-templates", "--no-themes",
    ...(tools.length ? ["--tools", tools.join(",")] : ["--no-tools"]),
    "--model", coord,
    ...(system ? ["--system-prompt", system] : []),
    ...(append || []).flatMap((t) => ["--append-system-prompt", t]),
    prompt,
  ];
}

function runOnce({ bin, argv, cwd, env, timeoutMs, logFile }) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "", err = "", timedOut = false;
    const fd = logFile ? fs.openSync(logFile, "a") : null;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (b) => { out += b; if (fd != null) fs.writeSync(fd, b); });
    child.stderr.on("data", (b) => { err += b; });
    const done = (code) => { clearTimeout(timer); if (fd != null) fs.closeSync(fd); resolve({ code, out, err, timedOut }); };
    child.on("error", (e) => { err += e.message; done(null); });
    child.on("close", done);
  });
}

/** 整次运行的用量 = 最后一个 agent_end 里所有 assistant 消息的 usage 之和(parseAgentEnd 只取末条,会少算多轮)。 */
function sumUsage(out) {
  let last = null;
  for (const line of String(out).split("\n")) {
    if (!line.startsWith('{"type":"agent_end"')) continue;
    try { last = JSON.parse(line); } catch {}
  }
  const ms = (last?.messages || []).filter((m) => m.role === "assistant" && m.usage);
  if (!ms.length) return null;
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  for (const { usage: u } of ms) for (const k of Object.keys(t)) t[k] += u[k] || 0;
  return t;
}

const countToolCalls = (out) => (String(out).match(/^\{"type":"tool_execution_start"/gm) || []).length;

/** claude 形状的 result 行(调用方只认 type:"result" 这一条)。 */
function resultLine({ ok, text, subtype, usage, durationMs, turns, sessionId, coord, caller, role }) {
  return {
    type: "result", subtype: subtype || (ok ? "success" : "error_during_execution"), is_error: !ok,
    result: text ?? "", duration_ms: durationMs, num_turns: turns, session_id: sessionId,
    total_cost_usd: 0, // MiniMax 包月:单次美元读不到,用 usage 记量;报告里按 token 与次数看
    usage: usage ? { input_tokens: usage.input || 0, output_tokens: usage.output || 0, cache_read_input_tokens: usage.cacheRead || 0, cache_creation_input_tokens: usage.cacheWrite || 0 } : null,
    piw: { coord, caller, role },
  };
}

function emit(fmt, line, write = (s) => process.stdout.write(s)) {
  if (fmt === "stream-json") {
    write(JSON.stringify({ type: "system", subtype: "init", session_id: line.session_id, model: line.piw.coord, piw: line.piw }) + "\n");
    if (line.result) write(JSON.stringify({ type: "assistant", session_id: line.session_id, message: { role: "assistant", content: [{ type: "text", text: line.result }] } }) + "\n");
    write(JSON.stringify(line) + "\n");
  } else if (fmt === "json") write(JSON.stringify(line) + "\n");
  else write(line.is_error ? "" : (line.result.endsWith("\n") ? line.result : line.result + "\n"));
}

/** 主流程。返回进程退出码(0 成功 · 1 失败,同 claude)。 */
async function agent(argv, { env = process.env, cwd = process.cwd(), stdin = () => "" , log = (m) => process.stderr.write(m + "\n"), write } = {}) {
  const o = parseClaudeArgs(argv);
  const { caller, source } = callerOf(o, cwd, env);
  const runId = crypto.randomUUID();
  const started = Date.now();
  const cfg = piw.loadConfig({ repo: cwd, env });
  const role = piw.roleOf(cfg, caller, env);
  const say = (line) => { emit(o.outputFormat, line, write); return line.is_error ? 1 : 0; };
  const fail = (subtype, text, extra = {}) => say(resultLine({ ok: false, subtype, text, durationMs: Date.now() - started, turns: 0, sessionId: runId, coord: null, caller, role, ...extra }));

  let prompt = o.prompt ?? stdin();
  if (!prompt || !prompt.trim()) { log("PIW_AGENT 提示词为空(位置参数或 stdin)"); return fail("error_input", "提示词为空"); }

  let def = null;
  if (o.agent) { try { def = loadAgentDef(o.agent, cwd, env); } catch (e) { log(`PIW_AGENT ${e.message}`); return fail("error_input", e.message); } }
  const allowed = o.allowed ?? def?.tools ?? null;
  const m = mapTools(allowed, o.disallowed);
  if (m.unsupported.length) log(`PIW_AGENT 不支持的工具(已忽略): ${m.unsupported.join(" ")}`);
  // MCP:只在允许表点名 mcp__… 时开,只连点名的服务、只开点名的工具;没点名 = 不连任何 MCP
  let mcp = null;
  if (m.mcp.length) {
    mcp = mcpPlan(m.mcp, readMcpServers(o, cwd));
    if (mcp.missing.length) log(`PIW_AGENT .mcp.json 里找不到这些 MCP 服务(已忽略): ${mcp.missing.join(" ")}`);
    if (!mcp.tools.length) mcp = null;
  }
  const deniedMcp = o.disallowed.filter((t) => t.startsWith("mcp__"));
  if (o.ignored.length) log(`PIW_AGENT 忽略的 claude 参数: ${o.ignored.join(" ")}`);

  const cap = capOf(cfg, caller, env);
  const used = runsToday(caller, env);
  if (used >= cap) {
    try { piw.appendUsage(env, { at: Math.floor(Date.now() / 1000), label: `agent:${caller}`, arm: "agent", model: null, capped: true, runId, cwd, used, cap }); } catch {}
    log(`PIW_CAP ${caller} 今天已 ${used}/${cap} 次,不再起模型(config.agentCaps.${caller} 可调)`);
    return fail("error_cap", `PIW_CAP ${caller} ${used}/${cap}`);
  }

  let x;
  try { x = piw.expandChain(role, cfg, { env }); } catch (e) { log(`PIW_AGENT ${e.message}`); return fail("error_config", e.message); }
  const pi = piw.resolvePi(cfg, env);
  if (!pi.bin) return fail("error_config", "找不到 pi");
  if (!x.chain.length) return fail("error_cooldown", `角色 ${role} 的坐标全在冷却中`);
  if (x.budget.length) try { piw.appendUsage(env, { at: Math.floor(Date.now() / 1000), label: `agent:${caller}`, arm: "budget-skip", runId, caller, role, model: x.budget[0] }); } catch {}

  const system = o.system ?? null;
  const append = [...(def ? [def.body] : []), ...(o.append || [])];
  const runDir = path.join(env.PIW_AGENT_RUNS_DIR || path.join(env.HOME || os.homedir(), ".omd-lite", "agent-runs"), new Date(started).toISOString().slice(0, 10));
  fs.mkdirSync(runDir, { recursive: true });
  const timeoutMs = Number(env.PIW_AGENT_TIMEOUT_S || DEFAULT_TIMEOUT_S) * 1000;
  const maxToolCalls = o.maxTurns ? o.maxTurns * 4 : Number(env.PIW_AGENT_MAX_TOOL_CALLS || 200);
  const guard = { bashPrefixes: m.bashPrefixes, maxToolCalls, mcpAllow: mcp ? mcp.tools : [], mcpDeny: deniedMcp.map((t) => t.replace(/^mcp__([^_]+(?:-[^_]+)*)/, (x, sv) => `mcp__${sv.replace(/-/g, "_")}`)) };
  const agentDir = mcp ? mcpAgentDir(mcp.config, env) : null;
  const tools = mcp ? [...m.tools, ...mcp.tools] : m.tools;
  // 大提示词走文件(argv 过 128 KB 会 E2BIG)
  let promptArg = prompt;
  if (Buffer.byteLength(prompt) > 100000) { const f = path.join(runDir, `${caller}-${runId}.prompt.md`); fs.writeFileSync(f, prompt); promptArg = `@${f}`; }

  let last = null;
  for (const coord of x.chain) {
    const logFile = path.join(runDir, `${caller.replace(/[^\w.-]/g, "_")}-${String(started)}-${coord.replace(/[^\w.-]/g, "_")}.jsonl`);
    const r = await runOnce({ bin: pi.bin, argv: piArgv({ coord, tools, system, append, prompt: promptArg, mcp: !!mcp }), cwd,
      env: { ...env, PIW_AGENT_GUARD: JSON.stringify(guard), ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}) }, timeoutMs, logFile });
    const end = piw.parseAgentEnd(r.out);
    if (end) end.usage = sumUsage(r.out) ?? end.usage;
    const turns = countToolCalls(r.out);
    const ok = !!(end?.ok && end.text.trim());
    const detail = ok ? null : end && !end.ok ? end.error : r.timedOut ? "timeout" : end?.ok ? "空回答" : `pi exit ${r.code}: ${r.err.slice(-300)}`;
    const cls = ok ? "ok" : end && !end.ok ? piw.classifyError(detail) : r.timedOut ? "timeout" : end?.ok ? "empty" : "stream";
    try {
      piw.appendUsage(env, { at: Math.floor(Date.now() / 1000), label: `agent:${caller}`, arm: "agent", model: coord, tokens: tokensOf(end?.usage),
        runId, caller, callerSource: source, cwd, role, ok, class: cls, wallMs: Date.now() - started, toolCalls: turns, log: logFile });
    } catch (e) { log(`PIW_AGENT 用量台账写不进: ${e.message}`); }
    if (ok) {
      if (agentDir) fs.rmSync(agentDir, { recursive: true, force: true });
      log(`PIW_OK ${coord}`);
      return say(resultLine({ ok: true, text: end.text, usage: end.usage, durationMs: Date.now() - started, turns, sessionId: runId, coord, caller, role }));
    }
    last = { coord, cls, detail };
    log(`PIW_AGENT ${coord} 失败(${cls}): ${String(detail).slice(0, 200)}`);
    if (cls === "quota") piw.setCooldown(coord, detail, cfg, env);
    if (cls === "request") break;
  }
  if (agentDir) fs.rmSync(agentDir, { recursive: true, force: true });
  log(`PIW_FAIL ${last.cls} ${last.coord}`);
  return fail("error_during_execution", `PIW_FAIL ${last.cls} ${last.coord}: ${String(last.detail).slice(0, 300)}`, { coord: last.coord });
}

function tokensOf(usage) {
  if (!usage) return null;
  const t = { input: usage.input || 0, output: usage.output || 0, cacheRead: usage.cacheRead || 0, cacheWrite: usage.cacheWrite || 0 };
  return { ...t, total: usage.totalTokens || t.input + t.output + t.cacheRead + t.cacheWrite };
}

module.exports = { agent, sumUsage, mcpPlan, mcpAllowed, splitShell, parseClaudeArgs, splitToolList, mapTools, bashAllowed, loadAgentDef, callerOf, capOf, runsToday, piArgv, DEFAULT_CAP };
