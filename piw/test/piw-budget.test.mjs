// node --test test/piw-budget.test.mjs —— 备用模型每日 token 上限与用量台账(M8a)。
// 临时 HOME + PIW_PI_BIN 替身(test/fixtures/pi-stub.mjs),不调任何模型。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const piw = require("../lib/piw.js");
const BIN = path.resolve(import.meta.dirname, "..", "bin", "piw");
const STUB = path.resolve(import.meta.dirname, "fixtures", "pi-stub.mjs");
const MM = "minimax-cp/MiniMax-M3.1-Flash-Preview:high";
const DS = "deepseek/deepseek-v4-flash";

// 台账文件名用的本机本地日期(offsetDays = -1 → 昨天)
const day = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const usageRow = (label, model, arm, total) => ({ at: Math.floor(Date.now() / 1000), label, model, arm,
  tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } });

test("usageToday:只算今天台账里 arm==fallback 的 total;byModel 按 model 求和(含 primary)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piw-usage-"));
  const env = { PIW_USAGE_DIR: dir };
  fs.writeFileSync(path.join(dir, `${day()}.jsonl`),
    [usageRow("a", DS, "fallback", 100), usageRow("b", "deepseek/deepseek-v4", "fallback", 200),
      usageRow("c", MM, "primary", 999)].map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, `${day(-1)}.jsonl`), JSON.stringify(usageRow("z", DS, "fallback", 5000)) + "\n");
  const u = piw.usageToday(env);
  assert.equal(u.fallbackTotal, 300);
  assert.deepEqual(u.byModel, { [DS]: 100, "deepseek/deepseek-v4": 200, [MM]: 999 });
});

test("fallbackCap:env PIW_DAILY_FALLBACK_TOKEN_CAP > config.json 的 dailyFallbackTokenCap > 3 亿", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piw-cfg-"));
  const cfgFile = path.join(dir, "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ dailyFallbackTokenCap: 777 }));
  assert.equal(piw.fallbackCap(piw.loadConfig({ env: { PIW_CONFIG: cfgFile } }), {}), 777);
  assert.equal(piw.fallbackCap(piw.loadConfig({ env: { PIW_CONFIG: cfgFile } }), { PIW_DAILY_FALLBACK_TOKEN_CAP: "1000" }), 1000);
  const none = piw.loadConfig({ env: { PIW_CONFIG: path.join(dir, "none.json") } });
  assert.equal(piw.fallbackCap(none, {}), 300000000);
  assert.equal(piw.fallbackCap(none, { PIW_DAILY_FALLBACK_TOKEN_CAP: "abc" }), 300000000, "不是整数的 env 值按缺省算");
});

function sh(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function repoWorld(plan = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-test-"));
  const log = path.join(home, "stub.log");
  const envFile = path.join(home, "env");
  const usage = path.join(home, "usage");
  fs.mkdirSync(usage, { recursive: true });
  fs.writeFileSync(envFile, "DEEPSEEK_API_KEY=fake\n");
  const env = {
    ...process.env, HOME: home, PIW_PI_BIN: STUB, STUB_PLAN: JSON.stringify(plan), STUB_LOG: log,
    OMD_LITE_ENV_FILE: envFile, PIW_USAGE_DIR: usage,
    PIW_QUOTA_BACKOFF: "", // 额度续跑默认等 330 分钟;这里测的是表用完之后换 fallback 的上限
  };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "PIW_ENV_FILE", "PIW_DAILY_FALLBACK_TOKEN_CAP", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const cli = (args, opts = {}) => spawnSync("node", [BIN, ...args], { encoding: "utf8", env, ...opts });
  const repo = path.join(home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const runArgs = (name, extra = []) => ["run", "--repo", repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal", "--gate", "true", "--name", name, ...extra];
  const runs = path.join(home, ".omd-lite", "runs");
  const meta = (name) => JSON.parse(fs.readFileSync(path.join(runs, name, "meta.json"), "utf8"));
  return { home, env, usage, repo, runArgs, runs, meta, calls, cli };
}

// 判据:模拟超限的 run 被停下 —— 主跑 2056、fallback ok,今天台账里 fallback 已用 5000 > 上限 1000
test("run 超每日上限:不换 fallback(没调模型、没建 out/fallback/),failureClass=budget,stderr 说为什么不换", () => {
  const w = repoWorld({ MiniMax: "2056" });
  fs.writeFileSync(path.join(w.usage, `${day()}.jsonl`), JSON.stringify(usageRow("昨天那个", DS, "fallback", 5000)) + "\n");
  const r = w.cli(w.runArgs("over", ["--role", "worker"]), { env: { ...w.env, PIW_DAILY_FALLBACK_TOKEN_CAP: "1000" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [MM], "备用模型一次都没被调");
  assert.ok(!fs.existsSync(path.join(w.runs, "over", "fallback")), "不建 out/fallback/");
  const m = w.meta("over");
  assert.equal(m.failureClass, "budget");
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.runs, "over", "result.json"), "utf8")).failureClass, "budget");
  assert.deepEqual(m.attempts.at(-1), { model: DS, skipped: "budget" });
  assert.ok(r.stderr.includes(`[piw] over: 今日备用模型已用 5000 token ≥ 上限 1000,不换 ${DS},本片停下`), r.stderr);
});

test("run 恰好用满上限(已用 == 上限)也停 —— 判据是「≥ 上限」", () => {
  const w = repoWorld({ MiniMax: "2056" });
  fs.writeFileSync(path.join(w.usage, `${day()}.jsonl`), JSON.stringify(usageRow("刚好用满", DS, "fallback", 5000)) + "\n");
  const r = w.cli(w.runArgs("exact", ["--role", "worker"]), { env: { ...w.env, PIW_DAILY_FALLBACK_TOKEN_CAP: "5000" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [MM]);
  assert.equal(w.meta("exact").failureClass, "budget");
});

test("run 没到每日上限:照旧换 fallback 重跑(out/fallback/ 建起来,备用模型被调过)", () => {
  const w = repoWorld({ MiniMax: "2056" });
  fs.writeFileSync(path.join(w.usage, `${day()}.jsonl`), JSON.stringify(usageRow("昨天那个", DS, "fallback", 5000)) + "\n");
  const r = w.cli(w.runArgs("under", ["--role", "worker"]), { env: { ...w.env, PIW_DAILY_FALLBACK_TOKEN_CAP: "1000000" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [MM, DS]);
  assert.ok(fs.existsSync(path.join(w.runs, "under", "fallback", "pi.jsonl")));
  assert.notEqual(w.meta("under").failureClass, "budget");
});

// 替身 2:吐 message_end(带 usage)+ agent_end,好让台账里的 tokens.total 是个真数而不是 0
function stubWithUsage(home) {
  const f = path.join(home, "pi-stub-usage.mjs");
  fs.writeFileSync(f, `#!/usr/bin/env node
const model = process.argv[process.argv.indexOf("--model") + 1];
const m = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20 } } }));
console.log(JSON.stringify({ type: "agent_end", messages: [m], model }));
`, { mode: 0o755 });
  return f;
}

test("台账:一次 pi 跑结束追加一行(arm/label/tokens 齐全),只管 pi 执行器", () => {
  const w = repoWorld();
  const r = w.cli(w.runArgs("ledger", ["--model", DS]), { env: { ...w.env, PIW_PI_BIN: stubWithUsage(w.home) } });
  assert.equal(r.status, 0, r.stderr);
  const rows = fs.readFileSync(path.join(w.usage, `${day()}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1, "主跑一行");
  assert.deepEqual(rows[0].tokens, { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, total: 20 });
  assert.equal(rows[0].arm, "primary");
  assert.equal(rows[0].label, "ledger");
  assert.equal(rows[0].model, DS);
  assert.equal(typeof rows[0].at, "number");
  const u = piw.usageToday({ PIW_USAGE_DIR: w.usage });
  assert.equal(u.fallbackTotal, 0);
  assert.deepEqual(u.byModel, { [DS]: 20 });
});

test("台账写不进去(PIW_USAGE_DIR 指向一个文件):run 照跑不挂,stderr 留一行台账写不进", () => {
  const w = repoWorld();
  const asFile = path.join(w.home, "usage-is-a-file");
  fs.writeFileSync(asFile, "x\n");
  const r = w.cli(w.runArgs("ledger-ro", ["--model", DS]), { env: { ...w.env, PIW_USAGE_DIR: asFile } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [DS], "模型照调");
  assert.match(r.stderr, new RegExp(`^\\[piw\\] 用量台账写不进 ${asFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m"), r.stderr);
});
