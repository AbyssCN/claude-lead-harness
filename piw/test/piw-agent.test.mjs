// node --test test/piw-agent.test.mjs —— piw agent(claude -p 替身):临时 HOME + PIW_PI_BIN 替身,不调任何模型。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require("../lib/agent.js");
const BIN = path.resolve(import.meta.dirname, "..", "bin", "piw");
const STUB = path.resolve(import.meta.dirname, "fixtures", "pi-stub.mjs");

function world(plan = {}, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-agent-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piw-agent-cwd-"));
  const log = path.join(home, "stub.log");
  const env = { ...process.env, HOME: home, PIW_PI_BIN: STUB, STUB_PLAN: JSON.stringify(plan), STUB_LOG: log, ...extraEnv };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "PIW_CALLER", "PIW_ROLE", "PIW_AGENT_CAP", "PIW_USAGE_DIR"]) if (!(k in extraEnv)) delete env[k];
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const cli = (args, opts = {}) => spawnSync("node", [BIN, "agent", ...args], { encoding: "utf8", env, cwd, ...opts });
  const ledger = () => {
    const dir = path.join(home, ".omd-lite", "usage");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  };
  return { home, cwd, env, calls, cli, ledger };
}

test("parseClaudeArgs:claude -p 常见写法", () => {
  const o = A.parseClaudeArgs(["-p", "--model", "sonnet", "--permission-mode", "dontAsk", "--allowedTools", "Read", "Grep", "Bash(git log:*)",
    "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "做事"]);
  assert.deepEqual(o.allowed, ["Read", "Grep", "Bash(git log:*)"]);
  assert.equal(o.outputFormat, "stream-json");
  assert.equal(o.prompt, "做事");
  assert.equal(o.model, "sonnet");
  assert.ok(o.ignored.includes("--verbose"));
  const b = A.parseClaudeArgs(["-p", "--allowedTools=Read,Glob", "--disallowedTools", "Write", "Edit", "--agent", "x", "提示"]);
  assert.deepEqual(b.allowed, ["Read", "Glob"]);
  assert.deepEqual(b.disallowed, ["Write", "Edit"]);
  assert.equal(b.agent, "x");
});

test("mapTools:claude 名 → pi 名;Bash(前缀) 收进前缀表;禁止表减掉", () => {
  const m = A.mapTools(["Read", "Glob", "Bash(git log:*)", "Bash(node scripts/x.mjs *)", "WebFetch", "mcp__publer__list"]);
  assert.deepEqual(m.tools.sort(), ["bash", "find", "ls", "read"]);
  assert.deepEqual(m.bashPrefixes, ["git log", "node scripts/x.mjs"]);
  assert.deepEqual(m.unsupported, ["WebFetch"]);
  assert.deepEqual(m.mcp, ["mcp__publer__list"]);
  const all = A.mapTools(null, ["Write", "Bash"]);
  assert.deepEqual(all.tools.sort(), ["edit", "find", "grep", "ls", "read"]);
  assert.equal(A.mapTools(["Bash", "Bash(git:*)"]).bashPrefixes, null, "给了整类 Bash 就不限前缀");
});

test("bashAllowed:每段都要以允许前缀开头;命令替换 / 重定向拒", () => {
  const p = ["git log", "node scripts/x.mjs"];
  assert.ok(A.bashAllowed("git log -3 --oneline", p).ok);
  assert.ok(A.bashAllowed("git log -3 2>&1 | node scripts/x.mjs --x", p).ok);
  assert.equal(A.bashAllowed("git log; rm -rf ~", p).ok, false);
  assert.equal(A.bashAllowed("git log > out.txt", p).ok, false);
  assert.equal(A.bashAllowed("git log $(rm -rf ~)", p).ok, false);
  assert.equal(A.bashAllowed("git logx", p).ok, false);
  assert.ok(A.bashAllowed("anything at all", null).ok);
});

test("agent:stream-json 出 claude 形状的 result 行;台账记 agent:<调用方>;pi argv 带守卫与工具表", () => {
  const w = world({}, { PIW_CALLER: "unit-job" });
  const r = w.cli(["-p", "你好", "--output-format", "stream-json", "--verbose", "--allowedTools", "Read", "Bash(git log:*)"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  const res = lines.find((l) => l.type === "result");
  assert.equal(res.subtype, "success");
  assert.equal(res.is_error, false);
  assert.match(res.result, /^STUB-OK:minimax-cp\//);
  assert.equal(res.piw.caller, "unit-job");
  const [c] = w.calls();
  assert.deepEqual(c.argv.slice(c.argv.indexOf("--tools"), c.argv.indexOf("--tools") + 2), ["--tools", "read,bash"]);
  assert.ok(c.argv.includes("-e") && c.argv[c.argv.indexOf("-e") + 1].endsWith("ext/agent-guard.ts"));
  assert.ok(c.argv.includes("--no-extensions"), "关掉 pi 的内置扩展(含 MCP)");
  assert.equal(c.cwd, fs.realpathSync(w.cwd), "cwd 原样(claude -p 在调用方的目录里干活)");
  assert.ok(c.envKeys.includes("PIW_AGENT_GUARD"));
  const [row] = w.ledger();
  assert.equal(row.label, "agent:unit-job");
  assert.equal(row.arm, "agent");
  assert.equal(row.ok, true);
  assert.equal(row.tokens.total, 20);
});

test("agent:text 格式只出正文;提示词可从 stdin 来", () => {
  const w = world({}, { PIW_CALLER: "t" });
  const r = w.cli(["-p"], { input: "从 stdin" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^STUB-OK:/);
  assert.equal(w.calls()[0].argv.at(-1), "从 stdin");
});

test("agent:每日上限 —— 到了不起模型,退 1,stderr PIW_CAP,台账记 capped", () => {
  const w = world({}, { PIW_CALLER: "noisy", PIW_AGENT_CAP: "2" });
  assert.equal(w.cli(["-p", "一"]).status, 0);
  assert.equal(w.cli(["-p", "二"]).status, 0);
  const r = w.cli(["-p", "--output-format", "json", "三"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PIW_CAP noisy 今天已 2\/2/);
  assert.equal(JSON.parse(r.stdout).subtype, "error_cap");
  assert.equal(w.calls().length, 2, "第三次没调 pi");
  assert.equal(w.ledger().filter((e) => e.capped).length, 1);
});

test("agent:上限按调用方分开算;config.agentCaps 生效", () => {
  const w = world({}, {});
  fs.mkdirSync(path.join(w.home, ".config", "piw"), { recursive: true });
  fs.writeFileSync(path.join(w.home, ".config", "piw", "config.json"), JSON.stringify({ agentCaps: { default: 5, solo: 1 } }));
  const as = (c, p) => spawnSync("node", [BIN, "agent", "-p", p], { encoding: "utf8", env: { ...w.env, PIW_CALLER: c }, cwd: w.cwd });
  assert.equal(as("solo", "a").status, 0);
  assert.equal(as("solo", "b").status, 1);
  assert.equal(as("other", "c").status, 0);
});

test("agent:--agent 读 .claude/agents/<名>.md —— 正文进 --append-system-prompt,frontmatter tools 当允许表", () => {
  const w = world({}, { PIW_CALLER: "spec" });
  fs.mkdirSync(path.join(w.home, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(w.home, ".claude", "agents", "spec-reviewer.md"), "---\nname: spec-reviewer\ntools: Read, Bash\n---\n你是审查员。只读。\n");
  const r = w.cli(["-p", "--agent", "spec-reviewer", "--output-format", "stream-json", "审这片"]);
  assert.equal(r.status, 0, r.stderr);
  const a = w.calls()[0].argv;
  assert.equal(a[a.indexOf("--tools") + 1], "read,bash");
  assert.match(a[a.indexOf("--append-system-prompt") + 1], /你是审查员/);
});

test("agent:模型报额度错 —— 退 1,result is_error,写冷却,台账记失败", () => {
  const w = world({ MiniMax: "2056" }, { PIW_CALLER: "q" });
  const r = w.cli(["-p", "--output-format", "json", "x"]);
  assert.equal(r.status, 1);
  const res = JSON.parse(r.stdout);
  assert.equal(res.is_error, true);
  assert.match(res.result, /PIW_FAIL quota/);
  assert.ok(fs.existsSync(path.join(w.home, ".cache", "piw", "cooldown.json")));
  assert.equal(w.ledger()[0].ok, false);
});

test("agent:空提示词 —— 退 1,不调 pi", () => {
  const w = world({}, { PIW_CALLER: "e" });
  const r = w.cli(["-p"], { input: "  " });
  assert.equal(r.status, 1);
  assert.equal(w.calls().length, 0);
});

test("sumUsage:多轮 assistant 的 usage 相加", () => {
  const u = (n) => ({ input: n, output: 1, cacheRead: 2, cacheWrite: 0, totalTokens: n + 3 });
  const out = [
    JSON.stringify({ type: "tool_execution_start" }),
    JSON.stringify({ type: "agent_end", messages: [{ role: "user" }, { role: "assistant", usage: u(10) }, { role: "toolResult" }, { role: "assistant", usage: u(20) }] }),
  ].join("\n");
  assert.deepEqual(A.sumUsage(out), { input: 30, output: 2, cacheRead: 4, cacheWrite: 0, totalTokens: 36 });
  assert.equal(A.sumUsage("nothing"), null);
});

test("agent:允许表点名 mcp__… 才开 MCP —— 只连点名的服务、只开点名的工具,守卫拿到允许 / 禁止表", () => {
  const w = world({}, { PIW_CALLER: "mcp-job" });
  fs.writeFileSync(path.join(w.cwd, ".mcp.json"), JSON.stringify({ mcpServers: { "publer-hq": { command: "node", args: ["x.js"] }, postiz: { url: "http://p" }, secret: { command: "s" } } }));
  fs.mkdirSync(path.join(w.home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(w.home, ".pi", "agent", "auth.json"), "{}");
  const r = w.cli(["-p", "读帖子", "--allowedTools", "Read", "mcp__publer-hq__publer_list_posts", "--disallowedTools", "mcp__postiz"]);
  assert.equal(r.status, 0, r.stderr);
  const [c] = w.calls();
  assert.equal(c.argv[c.argv.indexOf("--tools") + 1], "read,mcp__publer_hq__publer_list_posts");
  assert.ok(c.argv.includes("builtin:mcp"));
  assert.deepEqual(Object.keys(c.mcp.mcpServers), ["publer-hq"], "只连点名的服务");
  assert.equal(c.mcp.mcpServers["publer-hq"].exposure, "direct");
  assert.equal(c.mcp.autoEnableCodemode, false);
  assert.ok(c.envKeys.includes("PI_CODING_AGENT_DIR"));
});

test("agent:没点名 mcp__… → 不加载 MCP 扩展、不换 agent 目录", () => {
  const w = world({}, { PIW_CALLER: "plain" });
  fs.writeFileSync(path.join(w.cwd, ".mcp.json"), JSON.stringify({ mcpServers: { "publer-hq": { command: "node" } } }));
  assert.equal(w.cli(["-p", "x", "--allowedTools", "Read"]).status, 0);
  const [c] = w.calls();
  assert.ok(!c.argv.includes("builtin:mcp"));
  assert.equal(c.mcp, null);
});

test("mcpAllowed:禁止表优先;不在允许表一律拒;* 通配", () => {
  assert.ok(A.mcpAllowed("mcp__a__x", ["mcp__a__*"]).ok);
  assert.equal(A.mcpAllowed("mcp__a__x", ["mcp__a__*"], ["mcp__a__x"]).ok, false);
  assert.equal(A.mcpAllowed("mcp__b__x", ["mcp__a__*"]).ok, false);
});

test("bashAllowed:引号里的 | ; > $( 不算分段 / 重定向;引号外照拦", () => {
  const p = ["rg", "git log", "jq"];
  assert.ok(A.bashAllowed(`rg -n '"count":|"x"' a.json`, p).ok);
  assert.ok(A.bashAllowed(`rg 'a;b > c' f | jq '.x'`, p).ok);
  assert.ok(A.bashAllowed(`git log --format="%h $(x)"`, p).ok === false, "双引号里的 $( 仍会被 shell 展开");
  assert.ok(A.bashAllowed(`rg 'x' f 2>&1 | jq .`, p).ok);
  assert.equal(A.bashAllowed(`rg x f > out`, p).ok, false);
  assert.equal(A.bashAllowed(`rg x f && rm -rf ~`, p).ok, false);
  assert.equal(A.bashAllowed(`rg 'x`, p).ok, false, "引号没闭合");
  assert.deepEqual(A.splitShell(`rg 'a|b' f | jq . ; git log -1`).parts, [`rg 'a|b' f`, "jq .", "git log -1"]);
});

test("bashAllowed:前缀以 / - _ . 结尾时按纯前缀匹配(Bash(bash /tmp/learn-proof-:*))", () => {
  const p = ["bash /tmp/learn-proof-", "git log"];
  assert.ok(A.bashAllowed("bash /tmp/learn-proof-fg/scripts/dev/floor-guard.sh x", p).ok);
  assert.equal(A.bashAllowed("bash /tmp/other/x.sh", p).ok, false);
  assert.equal(A.bashAllowed("git logx", p).ok, false, "字母结尾的前缀仍要求词边界");
});
