// node --test test/piw-sibling.test.mjs —— 撞额度换同模型的兄弟坐标续跑(D-8,默认关的开关):
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
const CP = "minimax-cp/MiniMax-M3.1-Flash-Preview:high";    // 套餐 1
const CP2 = "minimax-cp2/MiniMax-M3.1-Flash-Preview:high";  // 套餐 2:同模型、不同供应商
const DS = "deepseek/deepseek-v4-flash";

function sh(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// 临时 HOME 的世界:角色表(worker 的 chain 里放两个兄弟坐标)+ models.json(两个 minimax 供应商都能起)+ 替身 pi
function world({ plan = {}, chain = [CP, CP2, DS], config = {}, env: extra = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-sib-"));
  const log = path.join(home, "stub.log");
  const envFile = path.join(home, "env");
  fs.writeFileSync(envFile, "DEEPSEEK_API_KEY=fake\n");
  fs.mkdirSync(path.join(home, ".config", "piw"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "piw", "config.json"), JSON.stringify({ ...config, roles: { worker: { chain } } }));
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { "minimax-cp": {}, "minimax-cp2": {} } }));
  const env = { ...process.env, HOME: home, PIW_PI_BIN: STUB, STUB_PLAN: JSON.stringify(plan), STUB_LOG: log, OMD_LITE_ENV_FILE: envFile };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "CLAUDE_CODE_SESSION_ID", "PIW_QUOTA_SIBLING", "PIW_QUOTA_BACKOFF", "PIW_NET_BACKOFF", "PIW_ROLE"]) delete env[k];
  Object.assign(env, { PIW_QUOTA_BACKOFF: "" }, extra);
  const repo = path.join(home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const runs = path.join(home, ".omd-lite", "runs");
  const meta = (name) => JSON.parse(fs.readFileSync(path.join(runs, name, "meta.json"), "utf8"));
  const runArgs = (name, extra = []) => ["run", "--repo", repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal", "--gate", "true", "--name", name, ...extra];
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  // timeout 是保险:实现坏了没换兄弟、真的去等 3600 s 时,这里 120 s 就砍掉,断言照样红
  const cli = (args, opts = {}) => spawnSync("node", [BIN, ...args], { encoding: "utf8", env, timeout: 120000, ...opts });
  const cdFile = path.join(home, ".cache", "piw", "cooldown.json");
  const cooldown = () => (fs.existsSync(cdFile) ? JSON.parse(fs.readFileSync(cdFile, "utf8")) : {});
  return { home, env, calls, cli, meta, runs, repo, runArgs, cooldown, cdFile };
}

// ── 开关 ─────────────────────────────────────────────────────────────────────
test("siblingSwitchOn:缺省 false;配置 true → true;环境 0 压过配置;环境 1 压过配置 false", () => {
  assert.equal(piw.siblingSwitchOn({}, {}), false, "缺省关");
  assert.equal(piw.siblingSwitchOn({ quotaSiblingSwitch: true }, {}), true, "配置文件开");
  assert.equal(piw.siblingSwitchOn({ quotaSiblingSwitch: true }, { PIW_QUOTA_SIBLING: "0" }), false, "环境 0 压过配置");
  assert.equal(piw.siblingSwitchOn({ quotaSiblingSwitch: false }, { PIW_QUOTA_SIBLING: "1" }), true, "环境 1 压过配置");
  assert.equal(piw.siblingSwitchOn({}, { PIW_QUOTA_SIBLING: "1" }), true, "光环境就能开");
});

test("loadConfig:读 quotaSiblingSwitch(配置文件里有就是它,没有按缺省 false)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piw-sib-cfg-"));
  const f = path.join(dir, "config.json");
  fs.writeFileSync(f, JSON.stringify({ quotaSiblingSwitch: true }));
  assert.equal(piw.loadConfig({ env: { PIW_CONFIG: f } }).quotaSiblingSwitch, true);
  const none = path.join(dir, "none.json");
  assert.equal(piw.loadConfig({ env: { PIW_CONFIG: none } }).quotaSiblingSwitch, false);
});

// ── 兄弟坐标 ─────────────────────────────────────────────────────────────────
test("siblingCoord:同后缀不同供应商 → 它;多个兄弟取第一个", () => {
  assert.equal(piw.siblingCoord(CP, [CP2]), CP2);
  assert.equal(piw.siblingCoord(CP, [CP, CP2]), CP2, "候选里有自己也跳不过去");
  assert.equal(piw.siblingCoord(CP, [CP2, "minimax-cp3/MiniMax-M3.1-Flash-Preview:high"]), CP2, "多个兄弟取第一个");
});

test("siblingCoord:后缀不同 / 供应商相同 / 只有自己 / 候选空 / 模型不同 → null", () => {
  assert.equal(piw.siblingCoord(CP, ["minimax-cp2/MiniMax-M3.1-Flash-Preview:xhigh"]), null, ":high 对 :xhigh 不算兄弟");
  assert.equal(piw.siblingCoord(CP, ["minimax-cp/MiniMax-M3.1-Flash-Preview:high"]), null, "同供应商不算兄弟");
  assert.equal(piw.siblingCoord(CP, [CP]), null, "只有自己不换给自己");
  assert.equal(piw.siblingCoord(CP, []), null, "候选空");
  assert.equal(piw.siblingCoord(CP, [DS]), null, "模型不同");
  assert.equal(piw.siblingCoord(CP, [CP, CP]), null, "角色表里同一个坐标出现两次也不换给自己");
});

// ── 闸红过一次的原因(bin/piw 加载期 require ESM)────────────────────────────────
// bin/piw 以前在模块加载期 require lib/*.mjs(ESM)。node --test 跑全量时,测试里的 await import('../lib/slot-queue.mjs')
// 与别处 require bin/piw 同时发生 → ERR_INTERNAL_ASSERTION "Cannot require() ES Module … not yet fully loaded",
// 报成整轮 test 失败(闸因此红)。改成按需加载后不再撞车。
test("bin/piw:与动态 import ESM 同时发生也不炸(ESM 改成按需加载)", async () => {
  const p = import("../lib/slot-queue.mjs");
  const piwBin = require("../bin/piw");
  await p;
  assert.equal(typeof piwBin.allowedFromSpec, "function");
});

// ── run:开关打开 ────────────────────────────────────────────────────────────
test("run:开关打开 —— 撞额度立刻换同模型的兄弟坐标续跑(不等额度表)", () => {
  const w = world({ plan: { "minimax-cp/": "quota1", "minimax-cp2/": "ok" } });
  const r = w.cli(w.runArgs("sib1", ["--role", "worker"]), { env: { ...w.env, PIW_QUOTA_SIBLING: "1", PIW_QUOTA_BACKOFF: "3600" } });
  assert.equal(r.status, 0, r.stderr);
  const calls = w.calls();
  assert.deepEqual(calls.map((c) => c.model), [CP, CP2], "撞额度就换兄弟,没等额度表(等的话 3600 s 就超时了)");
  assert.ok(!calls[0].argv.includes("--continue"), "第一次不是续跑");
  assert.ok(calls[1].argv.includes("--continue"), "兄弟坐标上是 --continue 续跑");
  assert.equal(calls[1].argv[calls[1].argv.indexOf("--session-dir") + 1], path.join(w.runs, "sib1", "session"), "同一个会话目录");
  assert.match(calls[1].argv.at(-1), /额度/, "续跑任务说明里说额度");
  assert.ok(fs.existsSync(path.join(w.runs, "sib1", "quota-resume-1", "pi.jsonl")), "续跑目录 quota-resume-1");
  const m = w.meta("sib1");
  assert.equal(m.attempts[1].model, CP2);
  assert.equal(m.attempts[1].switched_from, CP);
  assert.equal(m.attempts[1].waited_s, 0);
  assert.match(m.attempts[1].resumed_after, /2056/);
  assert.deepEqual(m.sibling_switches, [{ from: CP, to: CP2 }]);
  assert.deepEqual(m.failedCoords, [], "最后成功了就没有失败坐标");
  assert.ok(w.cooldown()["minimax-cp/MiniMax-M3.1-Flash-Preview"], "撞额度的坐标写进冷却");
});

test("run:开关打开(配置文件 quotaSiblingSwitch)—— 兄弟也撞额度 → 写它的冷却、没有兄弟才进等待表", () => {
  const w = world({ plan: { "minimax-cp/": "2056", "minimax-cp2/": "2056", deepseek: "2056" }, config: { quotaSiblingSwitch: true } });
  const r = w.cli(w.runArgs("sib2", ["--role", "worker", "--fallback-model", DS]), { env: { ...w.env, PIW_QUOTA_BACKOFF: "0,0" } });
  assert.equal(r.status, 0, r.stderr);
  const calls = w.calls();
  assert.deepEqual(calls.map((c) => c.model), [CP, CP2, CP2, CP2, DS], "换兄弟一次,之后在兄弟上等额度表 2 次,最后换 deepseek");
  assert.ok(calls[2].argv.includes("--continue") && calls[3].argv.includes("--continue"), "等待表上的续跑是 --continue");
  const cd = w.cooldown();
  assert.ok(cd["minimax-cp/MiniMax-M3.1-Flash-Preview"], "cp 进冷却");
  assert.ok(cd["minimax-cp2/MiniMax-M3.1-Flash-Preview"], "cp2 进冷却");
  const m = w.meta("sib2");
  assert.deepEqual(m.sibling_switches, [{ from: CP, to: CP2 }]);
  assert.deepEqual(m.failedCoords, [CP, CP2, DS], "撞过额度的两个坐标都算失败坐标");
  assert.equal(m.failureClass, "quota");
});

test("run:开关打开 —— 兄弟在冷却中 → 不换,按原逻辑等", () => {
  const w = world({ plan: { "minimax-cp/": "quota1" } });
  fs.mkdirSync(path.dirname(w.cdFile), { recursive: true });
  fs.writeFileSync(w.cdFile, JSON.stringify({ "minimax-cp2/MiniMax-M3.1-Flash-Preview": { until: Date.now() + 3600e3, at: Date.now(), reason: "test" } }));
  const r = w.cli(w.runArgs("sib3", ["--role", "worker"]), { env: { ...w.env, PIW_QUOTA_SIBLING: "1", PIW_QUOTA_BACKOFF: "0,0,0" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [CP, CP], "兄弟在冷却中,不换");
  assert.ok(!("sibling_switches" in w.meta("sib3")), "没换就没有这个键");
});

test("run:开关打开 —— --skip-coord 排除了兄弟 → 不换给它", () => {
  const w = world({ plan: { "minimax-cp/": "quota1" } });
  const r = w.cli(w.runArgs("sib4", ["--role", "worker", "--skip-coord", CP2]), { env: { ...w.env, PIW_QUOTA_SIBLING: "1", PIW_QUOTA_BACKOFF: "0,0,0" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [CP, CP], "被 skip 的兄弟不会被选");
  assert.ok(!("sibling_switches" in w.meta("sib4")), "没换就没有这个键");
});

test("run:开关打开但没有兄弟 —— 与既有用例「额度表用完仍 2056」逐项相同", () => {
  const w = world({ plan: { "minimax-cp/": "2056", deepseek: "2056" }, chain: [CP, DS] });
  const r = w.cli(w.runArgs("sib5", ["--role", "worker"]), { env: { ...w.env, PIW_QUOTA_SIBLING: "1", PIW_QUOTA_BACKOFF: "0,0" } });
  assert.equal(r.status, 0, r.stderr);
  const calls = w.calls();
  assert.deepEqual(calls.map((c) => c.model), [CP, CP, CP, DS], "主跑 1 次 + 额度续跑 2 次,再换 deepseek");
  const m = w.meta("sib5");
  assert.deepEqual(m.attempts.slice(1, 3).map((a) => a.waited_s), [0, 0]);
  assert.ok(fs.existsSync(path.join(w.runs, "sib5", "quota-resume-2")));
  assert.equal(m.failureClass, "quota");
  assert.deepEqual(m.failedCoords, [CP, DS]);
  assert.ok(!("sibling_switches" in m), "没换就没有这个键");
});

// ── run:开关关着(缺省)—— 与改之前逐字一致 ───────────────────────────────────
test("run:开关关着(缺省)—— 等额度表、在原坐标 --continue 续跑,不换兄弟", () => {
  const w = world({ plan: { "minimax-cp/": "quota1", "minimax-cp2/": "ok" } });
  const r = w.cli(w.runArgs("sib6", ["--role", "worker"]), { env: { ...w.env, PIW_QUOTA_BACKOFF: "0,0,0" } });
  assert.equal(r.status, 0, r.stderr);
  const calls = w.calls();
  assert.deepEqual(calls.map((c) => c.model), [CP, CP], "没换兄弟");
  assert.ok(calls[1].argv.includes("--continue"));
  assert.match(calls[1].argv.at(-1), /额度/);
  assert.ok(fs.existsSync(path.join(w.runs, "sib6", "quota-resume-1", "pi.jsonl")));
  const m = w.meta("sib6");
  assert.deepEqual(m.attempts.map((a) => a.model), [CP, CP]);
  assert.equal(m.attempts[1].waited_s, 0);
  assert.deepEqual(m.failedCoords, []);
  assert.equal(m.failureClass, null);
  assert.ok(w.cooldown()["minimax-cp/MiniMax-M3.1-Flash-Preview"], "第一次撞额度就写冷却");
  assert.ok(!("sibling_switches" in m), "没换就没有这个键");
});

test("run:开关关着 —— 额度表用完仍 2056,与既有用例逐项相同", () => {
  const w = world({ plan: { "minimax-cp/": "2056", "minimax-cp2/": "2056", deepseek: "2056" } });
  const r = w.cli(w.runArgs("sib7", ["--role", "worker", "--fallback-model", DS]), { env: { ...w.env, PIW_QUOTA_BACKOFF: "0,0" } });
  assert.equal(r.status, 0, r.stderr);
  const calls = w.calls();
  assert.deepEqual(calls.map((c) => c.model), [CP, CP, CP, DS], "主跑 1 次 + 额度续跑 2 次,再换 deepseek");
  const m = w.meta("sib7");
  assert.deepEqual(m.attempts.slice(1, 3).map((a) => a.waited_s), [0, 0]);
  assert.ok(fs.existsSync(path.join(w.runs, "sib7", "quota-resume-2")));
  assert.equal(m.failureClass, "quota");
  assert.deepEqual(m.failedCoords, [CP, DS]);
  assert.ok(!("sibling_switches" in m), "没换就没有这个键");
});

test("run:显式 --model(没有 --role)—— 不找兄弟,按等待表在原坐标续跑", () => {  const w = world({ plan: { "minimax-cp/": "quota1" } });
  const r = w.cli(w.runArgs("sib8", ["--model", CP]), { env: { ...w.env, PIW_QUOTA_SIBLING: "1", PIW_QUOTA_BACKOFF: "0,0,0" } });
  assert.equal(r.status, 0, r.stderr);
  const calls = w.calls();
  assert.deepEqual(calls.map((c) => c.model), [CP, CP], "没有 --role 就不找兄弟");
  assert.ok(calls[1].argv.includes("--continue"));
  assert.ok(fs.existsSync(path.join(w.runs, "sib8", "quota-resume-1", "pi.jsonl")));
  assert.ok(!("sibling_switches" in w.meta("sib8")), "没换就没有这个键");
});

// ── 兄弟起不来 / 冷却写不进去 ───────────────────────────────────────────────
test("run:兄弟坐标起不来(鉴权错)—— 不当额度再换,failedCoords 带上它", () => {
  const w = world({ plan: { "minimax-cp/": "quota1", "minimax-cp2/": "auth" } });
  const r = w.cli(w.runArgs("sib9", ["--role", "worker"]), { env: { ...w.env, PIW_QUOTA_SIBLING: "1", PIW_QUOTA_BACKOFF: "3600" } });
  assert.equal(r.status, 0, r.stderr);
  const models = w.calls().map((c) => c.model);
  assert.deepEqual(models.slice(0, 2), [CP, CP2], "撞额度换兄弟,兄弟报鉴权错");
  assert.ok(!models.includes(DS), "鉴权错不当额度再换(不换第三个坐标)");
  const m = w.meta("sib9");
  assert.deepEqual(m.failedCoords, [CP, CP2], "兄弟坐标也算失败坐标");
  assert.equal(m.failureClass, "auth");
});

test("run:冷却写不进去 —— 不会在两个坐标之间来回换(不死循环)", () => {
  const w = world({ plan: { "minimax-cp/": "2056", "minimax-cp2/": "2056" } });
  const cdDir = path.join(w.home, "cd-is-a-dir");
  fs.mkdirSync(cdDir); // 冷却文件写不进去(是目录)→ 写冷却失败,靠本次 run 的记录挡住来回换
  const r = w.cli(w.runArgs("sib10", ["--role", "worker", "--fallback-model", DS]),
    { env: { ...w.env, PIW_QUOTA_SIBLING: "1", PIW_QUOTA_BACKOFF: "0,0", PIW_COOLDOWN_FILE: cdDir } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [CP, CP2, CP2, CP2, DS], "换一次兄弟就完了,没在 cp / cp2 之间来回换");
});
