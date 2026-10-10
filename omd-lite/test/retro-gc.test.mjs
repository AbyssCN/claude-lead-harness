// node --test test/  —— retro / gc 用临时 HOME(runs 目录)+ 临时 git 仓,子进程跑真 CLI。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "omd-lite");
const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

function sh(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omdl-test-"));
  const repo = path.join(home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\nartifacts/\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const base = sh(repo, "rev-parse", "HEAD");
  const runs = path.join(home, ".omd-lite", "runs");
  fs.mkdirSync(runs, { recursive: true });
  return { home, repo, base, runs };
}

// 一个 run:建 worktree + 分支,写 meta / result / 任意产物文件
function mkRun(w, label, { meta = {}, result, files = {}, worktree = true } = {}) {
  const wt = path.resolve(w.repo, "..", `omdl-${label}`);
  if (worktree) sh(w.repo, "worktree", "add", "-q", wt, "-b", `omdl/${label}`, w.base);
  const dir = path.join(w.runs, label);
  fs.mkdirSync(dir, { recursive: true });
  const m = { label, repo: w.repo, base: "main", base_sha: w.base, worktree: wt, branch: `omdl/${label}`, spec: "spec.md",
    gates: ["g"], max_rounds: 3, executor: "mcode", start_epoch: now() - 600, end_epoch: now() - 60, wall_seconds: 540, ...meta };
  if (result) { m.result = result; fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result) + "\n"); }
  for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(m, null, 2) + "\n");
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  return { wt, dir };
}

const cli = (w, ...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, HOME: w.home } });

const gateLog = (...chunks) => chunks.map(([cmd, code, out]) => `### $ ${cmd}\n### exit=${code}\n${out}\n`).join("\n");
const NO_CHANGE = "gate-slice: FAIL 没有改动(基线 main):执行体什么也没交付";
const execFailed = (code) => JSON.stringify({ type: "exec.completed", result: { status: "failed", error: { code, message: "x" } } }) + "\n";
const execOk = JSON.stringify({ type: "exec.completed", result: { status: "succeeded" } }) + "\n";
const outsideLog = (...files) => gateLog(["scripts/dev/gate-slice.sh main", 0, "ok"],
  ["越界改动检查(任务书「允许改动:」)", 1, ["下列改动不在任务书「允许改动」里:", ...files.map((f) => `  ${f}`), "还原它们……"].join("\n")]);

// ── retro ──────────────────────────────────────────────────────────────

test("retro:首败区分「执行器挂了」与「执行体没交付」;锁冲突从 mcode 日志认出", () => {
  const w = world();
  mkRun(w, "r-blocked", { worktree: false, result: { gates: "pass", round: 2 }, files: {
    "mcode-round-1.jsonl": execFailed("CONTENT_REVIEW_BLOCKED"), "mcode-round-1.log": "",
    "gate-round-1.log": gateLog(["scripts/dev/gate-slice.sh main", 1, NO_CHANGE]),
    "mcode-round-2.jsonl": execOk, "gate-round-2.log": gateLog(["scripts/dev/gate-slice.sh main", 0, "ok"]) } });
  mkRun(w, "r-empty", { worktree: false, result: { gates: "fail", round: 1, failed_gate: "scripts/dev/gate-slice.sh main" }, files: {
    "mcode-round-1.jsonl": execOk, "gate-round-1.log": gateLog(["scripts/dev/gate-slice.sh main", 1, NO_CHANGE]) } });
  mkRun(w, "r-lock", { worktree: false, result: { gates: "fail", round: 1 }, files: {
    "mcode-round-1.jsonl": "", "mcode-round-1.log": "Error: agent_name_conflict_migration_failed:lock\n",
    "gate-round-1.log": gateLog(["scripts/dev/gate-slice.sh main", 1, NO_CHANGE]) } });
  const r = cli(w, "retro");
  assert.equal(r.status, 0, r.stderr);
  const line = (l) => r.stdout.split("\n").find((x) => x.startsWith(l + " ")) ?? "";
  assert.match(line("r-blocked"), /执行器挂了\(CONTENT_REVIEW_BLOCKED\)/);
  assert.match(line("r-empty"), /执行体没交付/);
  assert.doesNotMatch(line("r-empty"), /执行器挂了/);
  assert.match(line("r-lock"), /执行器挂了\(agent_name_conflict_migration_failed:lock\)/);
});

test("retro:聚合只列 ≥ 2 个 run 出现的模式(越界文件 · 首败闸)", () => {
  const w = world();
  mkRun(w, "o1", { worktree: false, result: { gates: "pass", round: 2, outside: [] }, files: {
    "gate-round-1.log": outsideLog("packages/engine/src/rules.ts", "once.ts"), "gate-round-2.log": gateLog(["g", 0, ""]) } });
  mkRun(w, "o2", { worktree: false, result: { gates: "fail", round: 1, outside: ["packages/engine/src/rules.ts"] }, files: {
    "gate-round-1.log": outsideLog("packages/engine/src/rules.ts") } });
  mkRun(w, "t1", { worktree: false, result: { gates: "fail", round: 1 }, files: {
    "gate-round-1.log": gateLog(["scripts/dev/gate-slice.sh main", 1, "== tsc\nok\n== vitest(5 个目录)\nFAIL x"]) } });
  const r = cli(w, "retro");
  assert.equal(r.status, 0, r.stderr);
  const agg = r.stdout.slice(r.stdout.indexOf("## 聚合"));
  assert.match(agg, /packages\/engine\/src\/rules\.ts\s+2/);
  assert.doesNotMatch(agg, /once\.ts/);
  assert.match(agg, /越界改动检查.*\s2\s/);
  assert.doesNotMatch(agg, /vitest/); // 只 1 个 run → 不进聚合
  assert.match(r.stdout, /t1 .*gate-slice\.sh main › vitest/); // 逐 run 表里有,带 gate-slice 的段名
  assert.match(agg, /多轮 run 占比:1 \/ 3/);
});

test("retro --since 与 label 过滤;末尾附 gc 预览一行", () => {
  const w = world();
  mkRun(w, "old", { worktree: false, meta: { start_epoch: Date.parse("2026-01-01T12:00:00") / 1000 }, result: { gates: "pass", round: 1 } });
  mkRun(w, "new", { worktree: false, result: { gates: "pass", round: 1 } });
  const r = cli(w, "retro", "--since", "2026-06-01");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^new /m);
  assert.doesNotMatch(r.stdout, /^old /m);
  assert.match(r.stdout, /可清 worktree \d+ 个 \/ 共 [\d.]+ GB\(omd-lite gc 预览\)/);
  const r2 = cli(w, "retro", "old");
  assert.match(r2.stdout, /^old /m);
  assert.doesNotMatch(r2.stdout, /^new /m);
});

// ── gc ─────────────────────────────────────────────────────────────────

test("gc:已合进 base 的可清;默认只预览,--apply 才删 worktree + 分支,run 记录保留", () => {
  const w = world();
  const { wt, dir } = mkRun(w, "merged", { result: { gates: "pass", round: 1 } });
  fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
  sh(wt, "add", "."); sh(wt, "commit", "-qm", "work");
  sh(w.repo, "merge", "-q", "--no-ff", "-m", "m", "omdl/merged");
  const p = cli(w, "gc");
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /omdl-merged.*已合进 main/);
  assert.ok(fs.existsSync(wt), "预览不许删");
  const a = cli(w, "gc", "--apply");
  assert.equal(a.status, 0, a.stderr);
  assert.ok(!fs.existsSync(wt));
  assert.equal(sh(w.repo, "branch", "--list", "omdl/merged"), "");
  assert.ok(fs.existsSync(path.join(dir, "meta.json")), "run 记录要留着给 retro 读");
});

test("gc:分支没提交(trivially 是祖先)但 worktree 有未提交改动 → 不清", () => {
  const w = world();
  const { wt } = mkRun(w, "dirty", { result: { gates: "pass", round: 1 } });
  fs.writeFileSync(path.join(wt, "a.txt"), "changed\n");
  const p = cli(w, "gc", "--apply");
  assert.equal(p.status, 0, p.stderr);
  assert.ok(fs.existsSync(wt));
  assert.doesNotMatch(p.stdout.split("## 不碰")[0], /omdl-dirty/);
});

test("gc:fail / not-run 早于期限才可清;期限内不清", () => {
  const w = world();
  const old = mkRun(w, "f-old", { meta: { end_epoch: now() - 3 * DAY }, result: { gates: "fail", round: 3 } });
  const recent = mkRun(w, "f-new", { result: { gates: "not-run" } });
  fs.writeFileSync(path.join(old.wt, "a.txt"), "half\n"); // 失败 run 的 worktree 本来就脏,照清
  fs.writeFileSync(path.join(recent.wt, "a.txt"), "half\n");
  const p = cli(w, "gc", "--older-than", "2", "--apply");
  assert.equal(p.status, 0, p.stderr);
  assert.ok(!fs.existsSync(old.wt));
  assert.ok(fs.existsSync(recent.wt));
});

test("gc:正在跑的 run 一律不碰(meta 无结束时间且未超墙钟 / 有进程在用 worktree)", async () => {
  const w = world();
  const a = mkRun(w, "live-meta", { meta: { end_epoch: undefined, wall_seconds: undefined, start_epoch: undefined } });
  const b = mkRun(w, "live-proc", { meta: { end_epoch: now() - 3 * DAY }, result: { gates: "fail", round: 3 } });
  const child = spawn("bash", ["-c", "sleep 30; :", "x", b.wt], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  try {
    const p = cli(w, "gc", "--apply");
    assert.equal(p.status, 0, p.stderr);
    assert.ok(fs.existsSync(a.wt), "无提交分支 = trivially 是祖先,但 run 还在跑");
    assert.ok(fs.existsSync(b.wt));
    assert.match(p.stdout, /omdl-live-meta.*正在跑/);
    assert.match(p.stdout, /omdl-live-proc.*正在跑/);
  } finally { child.kill(); }
});

test("gc:run 记录已不存在的孤儿 worktree 可清;有被忽略产物的不清", () => {
  const w = world();
  const orphan = path.resolve(w.repo, "..", "omdl-orphan");
  sh(w.repo, "worktree", "add", "-q", orphan, "-b", "omdl/orphan", w.base);
  const art = mkRun(w, "art", { meta: { end_epoch: now() - 3 * DAY }, result: { gates: "fail", round: 3 } });
  fs.mkdirSync(path.join(art.wt, "artifacts")); fs.writeFileSync(path.join(art.wt, "artifacts", "voice.wav"), "w");
  fs.mkdirSync(path.join(art.wt, "node_modules")); fs.writeFileSync(path.join(art.wt, "node_modules", "x.js"), "");
  const p = cli(w, "gc");
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /omdl-orphan.*孤儿/);
  assert.match(p.stdout, /omdl-art.*被忽略的产物.*artifacts/);
  assert.doesNotMatch(p.stdout, /node_modules\//);
  const a = cli(w, "gc", "--apply");
  assert.equal(a.status, 0, a.stderr);
  assert.ok(!fs.existsSync(orphan));
  assert.ok(fs.existsSync(art.wt));
});
