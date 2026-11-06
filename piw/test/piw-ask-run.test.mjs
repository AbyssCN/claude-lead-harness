// node --test test/piw-ask-run.test.mjs —— ask / run --role 等:临时 HOME + PIW_PI_BIN 替身(test/fixtures/pi-stub.mjs),不调任何模型。
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

function sh(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function world(plan = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-test-"));
  const log = path.join(home, "stub.log");
  const envFile = path.join(home, "env");
  fs.writeFileSync(envFile, "DEEPSEEK_API_KEY=fake\n");
  const env = {
    ...process.env, HOME: home, PIW_PI_BIN: STUB, STUB_PLAN: JSON.stringify(plan), STUB_LOG: log, OMD_LITE_ENV_FILE: envFile,
    PIW_QUOTA_BACKOFF: "", // 额度续跑默认等 330 分钟;既有用例测的是表用完之后的路径,续跑用例自己给表
  };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const cli = (args, opts = {}) => spawnSync("node", [BIN, ...args], { encoding: "utf8", env, ...opts });
  return { home, env, calls, cli, cooldownFile: path.join(home, ".cache", "piw", "cooldown.json") };
}

// ── ask ─────────────────────────────────────────────────────────────────────
test("ask:成功 —— stdout 是模型文本;pi argv 带隔离开关,cwd 是临时空目录(只有 .pi/settings.json 关 retry)", () => {
  const w = world();
  const r = w.cli(["ask", "--role", "continuity"], { input: "你好" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /STUB-OK:minimax-cp\/MiniMax-M3\.1-Flash-Preview:xhigh/);
  const [c] = w.calls();
  for (const f of ["--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-tools", "--no-session", "--no-extensions", "--approve", "-p"])
    assert.ok(c.argv.includes(f), `argv 缺 ${f}: ${c.argv}`);
  assert.deepEqual(c.argv.slice(c.argv.indexOf("--mode"), c.argv.indexOf("--mode") + 2), ["--mode", "json"]);
  assert.equal(c.argv.at(-1), "你好");
  assert.ok(c.cwd.startsWith(os.tmpdir()) && path.basename(c.cwd).startsWith("piw-ask-"), c.cwd);
  assert.deepEqual(c.ls, [".pi"], "cwd 里除 .pi 外必须是空的");
  assert.deepEqual(JSON.parse(c.settings), { retry: { enabled: false } });
  assert.ok(!fs.existsSync(c.cwd), "跑完临时目录被删");
});

test("ask:--system / --user 文件;system 走 --system-prompt", () => {
  const w = world();
  fs.writeFileSync(path.join(w.home, "s.md"), "SYS");
  fs.writeFileSync(path.join(w.home, "u.md"), "USR");
  const r = w.cli(["ask", "--role", "worker", "--system", path.join(w.home, "s.md"), "--user", path.join(w.home, "u.md")]);
  assert.equal(r.status, 0, r.stderr);
  const a = w.calls()[0].argv;
  assert.equal(a[a.indexOf("--system-prompt") + 1], "SYS");
  assert.equal(a.at(-1), "USR");
});

test("ask:2056 → 换 deepseek 成功,minimax 写入冷却", () => {
  const w = world({ MiniMax: "2056" });
  const r = w.cli(["ask", "--role", "worker"], { input: "x" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /STUB-OK:deepseek\/deepseek-v4-flash/);
  assert.deepEqual(w.calls().map((c) => c.model), [MM, DS]);
  const cd = JSON.parse(fs.readFileSync(w.cooldownFile, "utf8"));
  assert.ok(cd["minimax-cp/MiniMax-M3.1-Flash-Preview"].until > Date.now() + 299 * 60000, "额度类冷却 300 分钟");
});

test("ask:402 → 冷却写入(balance 1440 分钟),下次跳过该坐标", () => {
  const w = world({ MiniMax: "402" });
  assert.equal(w.cli(["ask", "--role", "worker"], { input: "x" }).status, 0);
  const cd = JSON.parse(fs.readFileSync(w.cooldownFile, "utf8"));
  assert.ok(cd["minimax-cp/MiniMax-M3.1-Flash-Preview"].until > Date.now() + 1439 * 60000);
  fs.rmSync(path.join(w.home, "stub.log"));
  const r2 = w.cli(["ask", "--role", "worker"], { input: "x" });
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [DS], "第二次根本没调 minimax");
});

test("ask:2013 请求错误 → exit 3,不换坐标,不写冷却", () => {
  const w = world({ MiniMax: "2013" });
  const r = w.cli(["ask", "--role", "worker"], { input: "x" });
  assert.equal(r.status, 3);
  assert.deepEqual(w.calls().map((c) => c.model), [MM]);
  assert.equal(r.stderr.trim().split("\n").at(-1), `PIW_FAIL request ${MM}`);
  assert.ok(!fs.existsSync(w.cooldownFile));
});

test("ask:流中断 → 换坐标,不写冷却", () => {
  const w = world({ MiniMax: "stream" });
  const r = w.cli(["ask", "--role", "worker"], { input: "x" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [MM, DS]);
  assert.ok(!fs.existsSync(w.cooldownFile));
});

test("ask:凭证类 → 输出 PIW_AUTH,换坐标,不写冷却", () => {
  const w = world({ MiniMax: "auth" });
  const r = w.cli(["ask", "--role", "worker"], { input: "x" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`^PIW_AUTH ${MM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.ok(!fs.existsSync(w.cooldownFile));
});

test("ask:chain 用完 → exit 2,stderr 末行 PIW_FAIL <class> <coord>", () => {
  const w = world({ MiniMax: "2056", deepseek: "stream" });
  const r = w.cli(["ask", "--role", "worker"], { input: "x" });
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim().split("\n").at(-1), `PIW_FAIL stream ${DS}`);
  assert.deepEqual(w.calls().map((c) => c.model), [MM, DS]);
});

test("ask:空回答(ok 但正文全空白)算失败 → 换坐标,stdout 是下一个坐标的正文", () => {
  const w = world({ MiniMax: "empty" });
  const r = w.cli(["ask", "--role", "worker"], { input: "x" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `STUB-OK:${DS}`);
  assert.deepEqual(w.calls().map((c) => c.model), [MM, DS]);
  assert.match(r.stderr, new RegExp(`^\\[piw\\] ${MM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 失败\\(empty\\):`, "m"), r.stderr);
  assert.ok(!fs.existsSync(w.cooldownFile), "空回答不写冷却");
});

test("ask:全部坐标都空回答 → exit 2,stderr 末行 PIW_FAIL empty <坐标>", () => {
  const w = world({ MiniMax: "empty", deepseek: "empty" });
  const r = w.cli(["ask", "--role", "worker"], { input: "x" });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "");
  assert.equal(r.stderr.trim().split("\n").at(-1), `PIW_FAIL empty ${DS}`);
  assert.deepEqual(w.calls().map((c) => c.model), [MM, DS]);
});

test("ask:每次尝试(成功 / 空回答 / 报错)都往当天台账写一行(arm=ask,label=ask:<role>)", () => {
  const w = world({ MiniMax: "empty" });
  const usage = path.join(w.home, "usage");
  const r = w.cli(["ask", "--role", "worker"], { input: "x", env: { ...w.env, PIW_USAGE_DIR: usage } });
  assert.equal(r.status, 0, r.stderr);
  const day = new Date();
  const rows = fs.readFileSync(path.join(usage, `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}.jsonl`), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 2, "A 空回答 + B 成功 = 两行");
  assert.deepEqual(rows.map((x) => [x.label, x.arm, x.model]), [["ask:worker", "ask", MM], ["ask:worker", "ask", DS]]);
  assert.deepEqual(rows[0].tokens, { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, total: 20 });
  assert.equal(typeof rows[0].at, "number");
});

test("ask:台账写不进去(PIW_USAGE_DIR 指向一个文件)→ 回答照给,stderr 留一行台账写不进", () => {
  const w = world();
  const asFile = path.join(w.home, "usage-is-a-file");
  fs.writeFileSync(asFile, "x\n");
  const r = w.cli(["ask", "--role", "worker"], { input: "x", env: { ...w.env, PIW_USAGE_DIR: asFile } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`STUB-OK:${MM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(r.stderr, new RegExp(`^\\[piw\\] 用量台账写不进 ${asFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m"), r.stderr);
});

test("ask:没有 agent_end(pi 崩了)算流类错误,继续下一个坐标", () => {
  const w = world({ MiniMax: "noend" });
  const r = w.cli(["ask", "--role", "worker"], { input: "x" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [MM, DS]);
});

test("ask:全部坐标冷却中 → exit 2 PIW_FAIL cooldown", () => {
  const w = world({ MiniMax: "402", deepseek: "402" });
  w.cli(["ask", "--role", "worker"], { input: "x" });
  const r = w.cli(["ask", "--role", "worker"], { input: "x" });
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim().split("\n").at(-1), `PIW_FAIL cooldown ${DS}`);
});

test("ask:user 文本超过 100 KB → 落临时目录以 @user.md 交给 pi(避免 argv E2BIG)", () => {
  const w = world();
  const r = w.cli(["ask", "--role", "worker"], { input: "a".repeat(150000) });
  assert.equal(r.status, 0, r.stderr);
  const c = w.calls()[0];
  assert.equal(c.argv.at(-1), "@user.md");
  assert.deepEqual(c.ls, [".pi", "user.md"]);
});

test("ask:仓库级 .claude/piw.json 按角色整条替换", () => {
  const w = world();
  const repo = path.join(w.home, "r");
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "piw.json"), JSON.stringify({ roles: { worker: { chain: ["x/y"] } } }));
  const r = w.cli(["ask", "--role", "worker", "--repo", repo], { input: "x" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), ["x/y"]);
});

test("ask --dry-run:打印 chain / pi / argv,exit 0,不调 pi", () => {
  const w = world();
  const r = w.cli(["ask", "--role", "continuity", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /chain\(展开后可用\): minimax-cp\/MiniMax-M3\.1-Flash-Preview:xhigh {2}→ {2}deepseek\/deepseek-v4-flash/);
  assert.match(r.stdout, new RegExp(`pi: ${STUB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(PIW_PI_BIN\\)`));
  assert.match(r.stdout, /--no-context-files.*--no-skills|--no-skills.*--no-context-files/);
  assert.equal(w.calls().length, 0);
});

// ── 分类 / 解析 / pi 定位 ────────────────────────────────────────────────────
test("classifyError:额度 / 凭证 / 请求 / 流", () => {
  const c = piw.classifyError;
  assert.equal(c('pi: 429: {"message":"Token Plan 用量上限 (2056)","http_code":"429"}'), "quota");
  assert.equal(c("402 Insufficient account balance"), "quota");
  assert.equal(c("insufficient_quota"), "quota");
  assert.equal(c("ERROR: You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage"), "quota"); // Codex 额度用完
  assert.equal(c('429 {"error":"usage_limit_reached"}'), "quota");
  assert.equal(c('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'), "quota"); // Anthropic 额度用完是 400,不能落成 request(会 break 不切下一家)
  assert.equal(c("401 invalid api key (1004)"), "auth");
  assert.equal(c("400: invalid params (2013)"), "request");
  assert.equal(c("Stream ended without finish_reason"), "stream");
  assert.equal(c("503 Service Unavailable"), "stream");
});

test("resolvePi:PIW_PI_BIN > fnm default alias > command -v", () => {
  const fnm = fs.mkdtempSync(path.join(os.tmpdir(), "piw-fnm-"));
  fs.mkdirSync(path.join(fnm, "aliases", "default", "bin"), { recursive: true });
  fs.writeFileSync(path.join(fnm, "aliases", "default", "bin", "pi"), "#!/bin/sh\n", { mode: 0o755 });
  const cfg = { pi: "auto" };
  assert.deepEqual(piw.resolvePi(cfg, { PIW_PI_BIN: "/x/pi", FNM_DIR: fnm }), { bin: "/x/pi", via: "PIW_PI_BIN" });
  assert.deepEqual(piw.resolvePi(cfg, { FNM_DIR: fnm, PATH: "/usr/bin:/bin" }), { bin: path.join(fnm, "aliases", "default", "bin", "pi"), via: "fnm default alias" });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "piw-fnm-"));
  const r = piw.resolvePi(cfg, { FNM_DIR: empty, PATH: "/nonexistent" });
  assert.equal(r.bin, null);
});

// ── run ─────────────────────────────────────────────────────────────────────
function repoWorld(plan) {
  const w = world(plan);
  const repo = path.join(w.home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const runArgs = (name, extra = []) => ["run", "--repo", repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal", "--gate", "true", "--name", name, ...extra];
  const runs = path.join(w.home, ".omd-lite", "runs");
  const meta = (name) => JSON.parse(fs.readFileSync(path.join(runs, name, "meta.json"), "utf8"));
  return { ...w, repo, runArgs, runs, meta };
}

test("run --role worker:展开成 --model chain[0] / fallback chain[1];主跑 2056 后在同一 worktree 换 deepseek", () => {
  const w = repoWorld({ MiniMax: "2056" });
  const r = w.cli(w.runArgs("r1", ["--role", "worker"]));
  assert.equal(r.status, 0, r.stderr);
  const calls = w.calls();
  assert.deepEqual(calls.map((c) => c.model), [MM, DS]);
  assert.equal(calls[0].cwd, calls[1].cwd, "同一 worktree");
  const m = w.meta("r1");
  assert.equal(m.model, MM);
  assert.equal(m.role, "worker");
  assert.deepEqual(m.attempts.map((a) => a.model), [MM, DS]);
  // minimax 档位已在坐标里(:high),不再叠 --thinking
  assert.ok(!calls[0].argv.includes("--thinking"));
});

test("run --role worker --skip-coord <minimax>:展开后只剩 deepseek(无 fallback)", () => {
  const w = repoWorld();
  const r = w.cli(w.runArgs("r2", ["--role", "worker", "--skip-coord", MM]));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [DS]);
  assert.equal(w.meta("r2").model, DS);
});

test("run --role:冷却中的坐标被跳过", () => {
  const w = repoWorld({ MiniMax: "402" });
  w.cli(["ask", "--role", "worker"], { input: "x" }); // 写入 minimax 冷却
  fs.rmSync(path.join(w.home, "stub.log"));
  const r = w.cli(w.runArgs("r3", ["--role", "worker"]));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [DS]);
});

test("run 失败:meta.json 写 failureClass 与 failedCoords(额度 → 两个坐标都挂)", () => {
  const w = repoWorld({ MiniMax: "2056", deepseek: "2056" });
  const r = w.cli(w.runArgs("r4", ["--role", "worker"]));
  assert.equal(r.status, 0, r.stderr);
  const m = w.meta("r4");
  assert.equal(m.failureClass, "quota");
  assert.deepEqual(m.failedCoords, [MM, DS]);
  // 闸没判过时 result.json 也带分类与坐标:pi_exit 是 0(pi -p 报错到底照样退 0),只看它会以为「正常结束、闸没跑」
  const res = JSON.parse(fs.readFileSync(path.join(w.runs, "r4", "result.json"), "utf8"));
  assert.equal(res.gates, "not-run");
  assert.equal(res.failureClass, "quota");
  assert.deepEqual(res.failedCoords, [MM, DS]);
});

test("run 失败:主跑额度、fallback 流中断 → failureClass=stream(末个报错),failedCoords 两个", () => {
  const w = repoWorld({ MiniMax: "2056", deepseek: "stream" });
  w.cli(w.runArgs("r5", ["--role", "worker"]));
  const m = w.meta("r5");
  assert.equal(m.failureClass, "stream");
  assert.deepEqual(m.failedCoords, [MM, DS]);
});

test("run 成功路径(闸已判过):result.json 补 failureClass:null;主跑失败的坐标仍记在 failedCoords", () => {
  const w = repoWorld({ MiniMax: "2056" });
  // 替身 2:对 deepseek 通过 OMD_LITE_OUT(run 传给 pi 的)写 result.json 模拟「闸判 pass」;对 minimax 报 2056
  const stub2 = path.join(w.home, "pi-stub2.mjs");
  fs.writeFileSync(stub2, `#!/usr/bin/env node
import fs from "node:fs"; import path from "node:path";
const model = process.argv[process.argv.indexOf("--model") + 1];
if (model.includes("deepseek")) fs.writeFileSync(path.join(process.env.OMD_LITE_OUT, "result.json"), JSON.stringify({ gates: "pass", round: 1 }) + "\\n");
const err = model.includes("MiniMax") ? '429: Token Plan (2056)' : null;
const m = err ? { role: "assistant", content: [], stopReason: "error", errorMessage: err } : { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
console.log(JSON.stringify({ type: "agent_end", messages: [m] }));
`, { mode: 0o755 });
  const r = w.cli(w.runArgs("r6", ["--role", "worker"]), { env: { ...w.env, PIW_PI_BIN: stub2 } });
  assert.equal(r.status, 0, r.stderr);
  const m = w.meta("r6");
  assert.equal(m.failureClass, null);
  assert.deepEqual(m.failedCoords, [MM]);
  assert.equal(m.result.gates, "pass");
  assert.equal(m.result.failureClass, null);
  assert.deepEqual(m.result.failedCoords, [MM]);
});

test("run --dry-run:打印 chain / pi / argv / 密钥注入,exit 0;不建 worktree、不写 runs、不调 pi", () => {
  const w = repoWorld();
  const spec = path.join(w.home, "任意文件.md");
  fs.writeFileSync(spec, "x");
  const r = w.cli(["run", "--role", "worker", "--dry-run", "--spec", spec]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /chain\(展开后可用\): minimax-cp\/MiniMax-M3\.1-Flash-Preview:high {2}→ {2}deepseek\/deepseek-v4-flash/);
  assert.match(r.stdout, /--model: minimax-cp\/MiniMax-M3\.1-Flash-Preview:high/);
  assert.match(r.stdout, /--fallback-model: deepseek\/deepseek-v4-flash/);
  assert.match(r.stdout, /\(PIW_PI_BIN\)/);
  assert.match(r.stdout, /argv\(主跑\): timeout 3600 .*"--no-extensions"/);
  assert.match(r.stdout, /DEEPSEEK_API_KEY.*dry-run 不读值/);
  assert.equal(w.calls().length, 0);
  assert.ok(!fs.existsSync(w.runs), "不建 runs 目录");
  assert.equal(sh(w.repo, "worktree", "list").split("\n").length, 1);
});

test("run --role worker --dry-run --skip-coord:只剩 deepseek", () => {
  const w = repoWorld();
  const r = w.cli(["run", "--role", "worker", "--dry-run", "--spec", "x", "--skip-coord", MM]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /chain\(展开后可用\): deepseek\/deepseek-v4-flash\n/);
  assert.match(r.stdout, /--fallback-model: none/);
  assert.match(r.stdout, new RegExp(`--skip-coord 剔除: ${MM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("run --skip-coord 没有 --role → 报错", () => {
  const w = repoWorld();
  const r = w.cli(["run", "--dry-run", "--model", DS, "--skip-coord", MM]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /需要 --role/);
});

test("run --reuse-worktree:不调用 git worktree add,在原 worktree 续跑,meta.resumedFrom 指向原 label", () => {
  const w = repoWorld();
  // 先用旧 label 建一个 worktree 与 run 记录(模拟被打断的 run)
  const wt = path.join(path.dirname(w.repo), "omdl-orig");
  sh(w.repo, "worktree", "add", "-q", wt, "-b", "omdl/orig", "main");
  fs.mkdirSync(path.join(w.runs, "orig"), { recursive: true });
  fs.writeFileSync(path.join(w.runs, "orig", "meta.json"), JSON.stringify({ label: "orig", worktree: wt, start_epoch: 1 }));
  fs.writeFileSync(path.join(wt, "partial.txt"), "上一个执行者的部分改动\n");
  // git 包装:记录每次调用的参数
  const bindir = path.join(w.home, "gitbin");
  fs.mkdirSync(bindir);
  const gitlog = path.join(w.home, "git.log");
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bindir, "git"), `#!/bin/sh\necho "$@" >> "${gitlog}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const r = w.cli(w.runArgs("orig-r2", ["--role", "worker", "--reuse-worktree", wt]), { env: { ...w.env, PATH: `${bindir}:${w.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  const gl = fs.readFileSync(gitlog, "utf8");
  assert.ok(gl.length > 0, "包装确实生效");
  assert.ok(!/worktree add/.test(gl), `不该有 worktree add:\n${gl}`);
  assert.ok(!/sparse-checkout/.test(gl), "复用时不做稀疏检出");
  assert.ok(!fs.existsSync(path.join(path.dirname(w.repo), "omdl-orig-r2")), "没建新 worktree");
  assert.equal(sh(w.repo, "worktree", "list").split("\n").length, 2);
  const m = w.meta("orig-r2");
  assert.equal(m.resumedFrom, "orig");
  assert.equal(m.worktree, wt);
  assert.equal(m.branch, "omdl/orig");
  assert.equal(m.reused_worktree, true);
  assert.equal(w.calls()[0].cwd, wt);
  assert.match(w.calls()[0].argv.at(-1), /先 git status \/ git diff 看清/, "续跑任务带「先看已有改动」");
  assert.ok(fs.existsSync(path.join(wt, "partial.txt")), "已有改动没被动");
  assert.ok(fs.existsSync(path.join(w.runs, "orig-r2", "result.json")), "result.json 写到本次 label 的 runs 目录");
});

test("run 现有语义不变:只给 --model(无 --role)仍按原样跑,DEFAULT_FALLBACK 照旧", () => {
  const w = repoWorld({ MiniMax: "2056" });
  const r = w.cli(w.runArgs("r7", ["--model", MM]));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [MM, DS]);
  assert.ok(!("role" in w.meta("r7")));
});

// ── ask 的 agy/<model> 坐标(gemini 家族判官)─────────────────────────────────
const AGY_STUB = path.resolve(import.meta.dirname, "fixtures", "agy-stub.mjs");
function agyWorld(mode, chain = ["agy/gemini-3.8-flash-high"]) {
  const w = world();
  const cfg = path.join(w.home, "piw.json");
  fs.writeFileSync(cfg, JSON.stringify({ roles: { "judge-agy": { chain } } }));
  Object.assign(w.env, { PIW_CONFIG: cfg, PIW_AGY_BIN: AGY_STUB, AGY_STUB_MODE: mode, PIW_USAGE_DIR: path.join(w.home, "usage") });
  return w;
}

test("ask agy/<model>:不用工具的开头 + system + user、走 stdin stream-json;argv 只带 --model,不批工具;台账按 agy 的 usage 记", () => {
  const w = agyWorld("ok");
  fs.writeFileSync(path.join(w.home, "s.md"), "SYS");
  const r = w.cli(["ask", "--role", "judge-agy", "--system", path.join(w.home, "s.md")], { input: "x".repeat(200000) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "AGY-OK:gemini-3.8-flash-high");
  const [c] = w.calls();
  assert.equal(c.bin, "agy");
  assert.deepEqual(c.argv.slice(0, 2), ["--model", "gemini-3.8-flash-high"]);
  assert.ok(!c.argv.includes("--dangerously-skip-permissions"));
  const msg = JSON.parse(c.input.trim());
  assert.equal(msg.event, "user");
  assert.match(msg.message.content, /^你在这一轮没有任何可用工具/);
  assert.ok(msg.message.content.endsWith("\n\nSYS\n\n" + "x".repeat(200000)));
  const [row] = fs.readFileSync(fs.readdirSync(path.join(w.home, "usage")).map((f) => path.join(w.home, "usage", f))[0], "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual([row.label, row.model, row.tokens.input, row.tokens.output, row.tokens.total], ["ask:judge-agy", "agy/gemini-3.8-flash-high", 100, 10, 110]);
});

test("ask agy/<model>:status 非 SUCCESS → 按错误分类换下一个坐标(额度写冷却)", () => {
  const w = agyWorld("error", ["agy/gemini-3.8-flash-high", "deepseek/deepseek-v4-flash"]);
  const r = w.cli(["ask", "--role", "judge-agy"], { input: "hi" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /STUB-OK:deepseek\/deepseek-v4-flash/);
  assert.ok(JSON.parse(fs.readFileSync(w.cooldownFile, "utf8"))["agy/gemini-3.8-flash-high"], "agy 额度错写冷却");
});

test("ask:材料里有 NUL → 剥掉再交给 pi,不崩;成功时 stderr 末行 PIW_OK <坐标>", () => {
  const w = world();
  fs.writeFileSync(path.join(w.home, "s.md"), "SY\0S");
  const r = w.cli(["ask", "--role", "worker", "--system", path.join(w.home, "s.md")], { input: "a\0b" });
  assert.equal(r.status, 0, r.stderr);
  const a = w.calls()[0].argv;
  assert.equal(a.at(-1), "ab");
  assert.equal(a[a.indexOf("--system-prompt") + 1], "SYS");
  assert.match(r.stderr.trim().split("\n").at(-1), /^PIW_OK minimax-cp\//);
});


test("run:主跑连接错误(Connection error.)→ 退避后在原会话、原坐标 --continue 续跑，不换 fallback", () => {
  const w = repoWorld({ MiniMax: "conn1" });
  const r = w.cli(w.runArgs("r-net", ["--role", "worker"]), { env: { ...w.env, PIW_NET_BACKOFF: "0,0,0" } });
  assert.equal(r.status, 0, r.stderr);
  const calls = w.calls();
  assert.deepEqual(calls.map((c) => c.model), [MM, MM], "两次都是主跑坐标，没换 deepseek");
  for (const c of calls) {
    assert.ok(!c.argv.includes("--no-session"), "要存会话才能续跑");
    assert.equal(c.argv[c.argv.indexOf("--session-dir") + 1], path.join(w.runs, "r-net", "session"));
  }
  assert.ok(!calls[0].argv.includes("--continue"));
  assert.ok(calls[1].argv.includes("--continue"));
  const m = w.meta("r-net");
  assert.deepEqual(m.attempts.map((a) => a.model), [MM, MM]);
  assert.equal(m.attempts[1].resumed_after, "Connection error.");
  assert.deepEqual(m.failedCoords, []);
});

test("run:连接错误退避用完仍不通 → 才换 fallback", () => {
  const w = repoWorld({ MiniMax: "conn" });
  const r = w.cli(w.runArgs("r-net2", ["--role", "worker"]), { env: { ...w.env, PIW_NET_BACKOFF: "0,0" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [MM, MM, MM, DS], "主跑 1 次 + 续跑 2 次,再换 deepseek");
});

test("run:主跑额度用完(2056)→ 立刻写冷却(新片改走 mcode),本片等额度表后在原会话、原坐标 --continue 续跑，不换 fallback", () => {
  const w = repoWorld({ MiniMax: "quota1" });
  const r = w.cli(w.runArgs("r-quota", ["--role", "worker"]), { env: { ...w.env, PIW_QUOTA_BACKOFF: "0,0,0" } });
  assert.equal(r.status, 0, r.stderr);
  const calls = w.calls();
  assert.deepEqual(calls.map((c) => c.model), [MM, MM], "两次都是主跑坐标，没换 deepseek");
  for (const c of calls) assert.equal(c.argv[c.argv.indexOf("--session-dir") + 1], path.join(w.runs, "r-quota", "session"));
  assert.ok(!calls[0].argv.includes("--continue"));
  assert.ok(calls[1].argv.includes("--continue"));
  assert.match(calls[1].argv.at(-1), /额度/, "续跑任务说明是额度恢复后续跑");
  assert.ok(r.stderr.includes("[omd-lite] r-quota: 额度用完,0 s 后在原会话续跑(第 1/3 次)"), r.stderr);
  const m = w.meta("r-quota");
  assert.deepEqual(m.attempts.map((a) => a.model), [MM, MM]);
  assert.match(m.attempts[1].resumed_after, /2056/);
  assert.equal(m.attempts[1].waited_s, 0);
  assert.ok(fs.existsSync(path.join(w.runs, "r-quota", "quota-resume-1", "pi.jsonl")));
  assert.ok(!fs.existsSync(path.join(w.runs, "r-quota", "fallback")), "没走 fallback");
  assert.deepEqual(m.failedCoords, []);
  assert.equal(m.failureClass, null);
  assert.ok(JSON.parse(fs.readFileSync(w.cooldownFile, "utf8"))["minimax-cp/MiniMax-M3.1-Flash-Preview"], "第一次撞额度就写冷却");
});

test("run:额度表用完仍 2056 → 才走原路径(写冷却 · 换 fallback · failureClass quota)", () => {
  const w = repoWorld({ MiniMax: "2056", deepseek: "2056" });
  const r = w.cli(w.runArgs("r-quota2", ["--role", "worker"]), { env: { ...w.env, PIW_QUOTA_BACKOFF: "0,0" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [MM, MM, MM, DS], "主跑 1 次 + 额度续跑 2 次,再换 deepseek");
  const m = w.meta("r-quota2");
  assert.deepEqual(m.attempts.slice(1, 3).map((a) => a.waited_s), [0, 0]);
  assert.ok(fs.existsSync(path.join(w.runs, "r-quota2", "quota-resume-2")));
  assert.equal(m.failureClass, "quota");
  assert.deepEqual(m.failedCoords, [MM, DS]);
  assert.ok(JSON.parse(fs.readFileSync(w.cooldownFile, "utf8"))["minimax-cp/MiniMax-M3.1-Flash-Preview"]);
});

test("run:余额不足(402)不等额度表,照旧直接换 fallback", () => {
  const w = repoWorld({ MiniMax: "402" });
  const r = w.cli(w.runArgs("r-quota3", ["--role", "worker"]), { env: { ...w.env, PIW_QUOTA_BACKOFF: "0,0" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.model), [MM, DS]);
  assert.ok(!fs.existsSync(path.join(w.runs, "r-quota3", "quota-resume-1")));
});

test("ask --read-tools:只开只读四件,cwd 是 --repo;不给 --repo 拒", () => {
  const w = world();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "piw-repo-"));
  const r = w.cli(["ask", "--role", "worker", "--repo", repo, "--read-tools"], { input: "x" });
  assert.equal(r.status, 0, r.stderr);
  const c = w.calls()[0];
  assert.ok(!c.argv.includes("--no-tools"), c.argv);
  assert.equal(c.argv[c.argv.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(repo));
  assert.notEqual(w.cli(["ask", "--role", "worker", "--read-tools"], { input: "x" }).status, 0);
});

// ── Anthropic 日限额(2026-10-26):Max 附带额度要匀速花到 11-11,当天估算花费到限额就跳过 anthropic/*,落到下一家 ──
test("expandChain:anthropic 当天估算花费到日限额就跳过(budget),没到照常;限额文件缺失按超额处理", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piw-budget-"));
  const usage = path.join(dir, "usage"); fs.mkdirSync(usage);
  const budget = path.join(dir, "budget.json");
  const env = { PIW_USAGE_DIR: usage, PIW_ANTHROPIC_BUDGET_FILE: budget, PIW_COOLDOWN_FILE: path.join(dir, "cd.json") };
  const cfg = { roles: { r: { chain: ["anthropic/claude-sonnet-5-5", "minimax-cp/M"] } } };
  const day = piw.localDay();
  const prices = { "anthropic/claude-sonnet-5-5": [2, 10, 2.5, 0.1] };
  // 缺文件:跳过
  assert.deepEqual(piw.expandChain("r", cfg, { env }).chain, ["minimax-cp/M"]);
  fs.writeFileSync(budget, JSON.stringify({ day, limitUsd: 10, calib: 1, prices }));
  assert.deepEqual(piw.expandChain("r", cfg, { env }).chain, ["anthropic/claude-sonnet-5-5", "minimax-cp/M"]);
  // 当天花了 1M output = $10 → 到限额
  fs.writeFileSync(path.join(usage, `${day}.jsonl`), JSON.stringify({ model: "anthropic/claude-sonnet-5-5", tokens: { input: 0, output: 1e6, cacheRead: 0, cacheWrite: 0 } }) + "\n");
  const x = piw.expandChain("r", cfg, { env });
  assert.deepEqual(x.chain, ["minimax-cp/M"]);
  assert.deepEqual(x.budget, ["anthropic/claude-sonnet-5-5"]);
  // calib 放大估算:$5 × 2 = $10 也算到
  fs.writeFileSync(path.join(usage, `${day}.jsonl`), JSON.stringify({ model: "anthropic/claude-sonnet-5-5", tokens: { input: 0, output: 5e5 } }) + "\n");
  fs.writeFileSync(budget, JSON.stringify({ day, limitUsd: 10, calib: 2, prices }));
  assert.deepEqual(piw.expandChain("r", cfg, { env }).chain, ["minimax-cp/M"]);
});

test("roleOf:PIW_ROLE > config.callerRoles[caller] > cron", () => {
  const cfg = { callerRoles: { "inbox-bot": "cron-light" } };
  assert.equal(piw.roleOf(cfg, "inbox-bot", {}), "cron-light");
  assert.equal(piw.roleOf(cfg, "inbox-bot", { PIW_ROLE: "x" }), "x");
  assert.equal(piw.roleOf(cfg, "other", {}), "cron");
});

test("loadConfig 保留 callerRoles(否则按难度分 Sonnet/Haiku 的映射读不到)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piw-cr-"));
  const f = path.join(dir, "config.json");
  fs.writeFileSync(f, JSON.stringify({ callerRoles: { "inbox-bot": "cron-light" } }));
  assert.equal(piw.roleOf(piw.loadConfig({ repo: dir, env: { PIW_CONFIG: f } }), "inbox-bot", {}), "cron-light");
});

test("expandChain:非豁免角色到 limit − reserveUsd 就跳过 anthropic,budgetExempt 角色不受限额约束", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piw-res-"));
  const usage = path.join(dir, "usage"); fs.mkdirSync(usage);
  const budget = path.join(dir, "b.json");
  const env = { PIW_USAGE_DIR: usage, PIW_ANTHROPIC_BUDGET_FILE: budget, PIW_COOLDOWN_FILE: path.join(dir, "cd.json") };
  const cfg = { roles: { cont: { chain: ["anthropic/claude-sonnet-5-5", "m/M"] }, key: { budgetExempt: true, chain: ["anthropic/claude-sonnet-5-5", "m/M"] } } };
  fs.writeFileSync(budget, JSON.stringify({ day: piw.localDay(), limitUsd: 10, reserveUsd: 3, calib: 1, prices: { "anthropic/claude-sonnet-5-5": [2, 10, 2.5, 0.1] } }));
  fs.writeFileSync(path.join(usage, `${piw.localDay()}.jsonl`), JSON.stringify({ model: "anthropic/claude-sonnet-5-5", tokens: { output: 2e6 } }) + "\n"); // $20,超过 limit
  assert.deepEqual(piw.expandChain("cont", cfg, { env }).chain, ["m/M"]);
  assert.deepEqual(piw.expandChain("key", cfg, { env }).chain, ["anthropic/claude-sonnet-5-5", "m/M"]);
  fs.writeFileSync(path.join(usage, `${piw.localDay()}.jsonl`), JSON.stringify({ model: "anthropic/claude-sonnet-5-5", tokens: { output: 6.5e5 } }) + "\n"); // $6.5 < 7
  assert.deepEqual(piw.expandChain("cont", cfg, { env }).chain, ["anthropic/claude-sonnet-5-5", "m/M"]);
});
