// node --test test/  —— retro / gc 用临时 HOME(runs 目录)+ 临时 git 仓,子进程跑真 CLI。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "piw");
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
// 注入进程命令行($PIW_PROCS_FILE,一行一条;不注入时 CLI 照旧读 ps)
const cliWithProcs = (w, lines) => (...args) => {
  const f = path.join(w.home, "procs.txt");
  fs.writeFileSync(f, lines.map((l) => `${l}\n`).join(""));
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, HOME: w.home, PIW_PROCS_FILE: f } });
};

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
  assert.match(r.stdout, /可清 worktree \d+ 个 \/ 共 [\d.]+ GB\(piw gc 预览\)/);
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

test("gc:已合进 main 且有提交、worktree 还剩未提交改动 → 先归档(补丁 + 未跟踪 tar + head)再清", () => {
  const w = world();
  const { wt } = mkRun(w, "merged-dirty", { result: { gates: "pass", round: 1 } });
  fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
  sh(wt, "add", "."); sh(wt, "commit", "-qm", "work");
  sh(w.repo, "merge", "-q", "--no-ff", "-m", "m", "omdl/merged-dirty");
  const head = sh(wt, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(wt, "a.txt"), "late edit\n");
  fs.writeFileSync(path.join(wt, "new.txt"), "untracked\n");
  const a = cli(w, "gc", "--apply");
  assert.equal(a.status, 0, a.stderr);
  assert.ok(!fs.existsSync(wt));
  const day = path.join(w.home, ".omd-lite", "archive", `gc-${new Date().toISOString().slice(0, 10)}`, "merged-dirty");
  assert.match(fs.readFileSync(path.join(day, "diff.patch"), "utf8"), /\+late edit/);
  assert.equal(fs.readFileSync(path.join(day, "head"), "utf8").trim(), head);
  const tar = spawnSync("tar", ["-tzf", path.join(day, "untracked.tgz")], { encoding: "utf8" });
  assert.match(tar.stdout, /new\.txt/);
});

test("gc:分支进的是别的 base(不是 main)且 worktree 脏 → 不清", () => {
  const w = world();
  sh(w.repo, "branch", "side");
  const { wt } = mkRun(w, "side-dirty", { meta: { base: "side" }, result: { gates: "pass", round: 1 } });
  fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
  sh(wt, "add", "."); sh(wt, "commit", "-qm", "work");
  sh(w.repo, "branch", "-f", "side", "omdl/side-dirty");
  fs.writeFileSync(path.join(wt, "a.txt"), "late edit\n");
  const a = cli(w, "gc", "--apply");
  assert.equal(a.status, 0, a.stderr);
  assert.ok(fs.existsSync(wt));
  assert.match(a.stdout, /omdl-side-dirty.*分支已在 side 里但 worktree 有未提交改动/);
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

test("gc:正在跑的 run 一律不碰(meta 无结束时间且未超墙钟 / piw 进程在用 worktree)", () => {
  const w = world();
  const a = mkRun(w, "live-meta", { meta: { end_epoch: undefined, wall_seconds: undefined, start_epoch: undefined } });
  const b = mkRun(w, "live-proc", { meta: { end_epoch: now() - 3 * DAY }, result: { gates: "fail", round: 3 } });
  // piw 本体进程的命令行里带着 worktree 路径:按路径认活
  const p = cliWithProcs(w, [`node /x/piw run --repo ${w.repo} ${b.wt}`])("gc", "--apply");
  assert.equal(p.status, 0, p.stderr);
  assert.ok(fs.existsSync(a.wt), "无提交分支 = trivially 是祖先,但 run 还在跑");
  assert.ok(fs.existsSync(b.wt));
  assert.match(p.stdout, /omdl-live-meta.*正在跑/);
  assert.match(p.stdout, /omdl-live-proc.*正在跑/);
});

test("gc:「正在跑」只认 piw / omd-lite 本体的进程 —— 别的进程命令行里有 worktree 路径不算", async () => {
  const w = world();
  const { wt } = mkRun(w, "echoed", { result: { gates: "pass", round: 1 } });
  fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
  sh(wt, "add", "."); sh(wt, "commit", "-qm", "work");
  sh(w.repo, "merge", "-q", "--no-ff", "-m", "m", "omdl/echoed"); // 已合进 base,fail 期限也过了
  // 另一个会话的 bash 命令行里带着这个 worktree 路径 —— 它不是在跑这个 run
  const child = spawn("bash", ["-c", "sleep 30; :", "x", wt], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  try {
    const p = cli(w, "gc");
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /omdl-echoed.*已合进 main/);
    assert.doesNotMatch(p.stdout, /omdl-echoed.*正在跑/);
    assert.doesNotMatch(p.stdout.split("## 不碰")[1], /omdl-echoed/);
    const a = cli(w, "gc", "--apply");
    assert.ok(!fs.existsSync(wt), "判不在跑就该真删");
  } finally { child.kill(); }
});

test("gc:Everything 索引器的 find(剪枝表里有 .omd-lite、repos/piw 与 worktree 路径)不算正在跑", () => {
  const w = world();
  const { wt } = mkRun(w, "pruned", { meta: { end_epoch: now() - 3 * DAY }, result: { gates: "fail", round: 3 } });
  const find = `find /home/user ( -name node_modules -o -name .git ) -prune -o ( -path /home/user/.omd-lite -o -path /home/user/repos/piw`
    + ` -o -path ${wt} -o -path ${w.repo} ) -prune -o -type d -print`;
  const p = cliWithProcs(w, [find, `bash -c echo ${wt} piw`, `node /x/piw report --name pruned`])("gc");
  assert.equal(p.status, 0, p.stderr);
  assert.doesNotMatch(p.stdout, /omdl-pruned.*正在跑/);
});

test("gc:同一个 run 在 piw 本体的进程里(按 --name 或按 worktree 路径命中)→ 仍判正在跑", () => {
  const w = world();
  const { wt } = mkRun(w, "live", { meta: { end_epoch: now() - 3 * DAY }, result: { gates: "fail", round: 3 } });
  const byName = cliWithProcs(w, [`node /x/piw run --name live --repo ${w.repo}`])("gc");
  assert.equal(byName.status, 0, byName.stderr);
  assert.match(byName.stdout, /omdl-live.*正在跑/);
  const byWt = cliWithProcs(w, [`node /x/piw run --repo ${w.repo} ${wt}`])("gc");
  assert.equal(byWt.status, 0, byWt.stderr);
  assert.match(byWt.stdout, /omdl-live.*正在跑/);
});

test("gc:按名字判活同时认 piw 与 omd-lite(`<name> run … --name <label>`)", async () => {
  const w = world();
  const a = mkRun(w, "by-piw", { meta: { end_epoch: now() - 3 * DAY }, result: { gates: "fail", round: 3 } });
  const b = mkRun(w, "by-old", { meta: { end_epoch: now() - 3 * DAY }, result: { gates: "fail", round: 3 } });
  const c = mkRun(w, "no-proc", { meta: { end_epoch: now() - 3 * DAY }, result: { gates: "fail", round: 3 } });
  // 参数里不含 worktree 路径,只靠 "<cli> run … --name <label>" 命中
  const kids = [["piw", "by-piw"], ["omd-lite", "by-old"]].map(([cliName, label]) =>
    spawn("bash", ["-c", "sleep 30; :", "x", `/x/bin/${cliName}`, "run", "--name", label], { stdio: "ignore", detached: true }));
  await new Promise((r) => setTimeout(r, 200));
  try {
    const p = cli(w, "gc");
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /omdl-by-piw.*正在跑/);
    assert.match(p.stdout, /omdl-by-old.*正在跑/);
    assert.doesNotMatch(p.stdout, /omdl-no-proc.*正在跑/);
    assert.ok(a.wt && b.wt && c.wt);
  } finally { for (const k of kids) try { process.kill(-k.pid); } catch {} } // 进程组:bash 与它的 sleep 子进程
});

test("gc:run 记录已不存在的孤儿 worktree 可清;有被忽略产物的(§17)不清", () => {
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

test("gc:起片清空分支时挪开的 omdl-<label>.orphan-<时间> 单列一类带大小,--apply 不删(要人手删)", () => {
  const w = world();
  const aside = path.resolve(w.repo, "..", "omdl-killed.orphan-20261020T080000Z");
  sh(w.repo, "worktree", "add", "-q", "--detach", aside, w.base);
  mkRun(w, "done", { result: { gates: "pass", round: 1 } });
  const p = cli(w, "gc");
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /## 挪开待人看\(1 个 · [\d.]+ GB;/);
  assert.match(p.stdout, new RegExp(`${aside.replace(/[.]/g, "\\.")}\\s.*[\\d.]+`));
  assert.match(p.stdout, /git -C \S+ worktree remove --force /);
  assert.doesNotMatch(p.stdout.split("## 挪开待人看")[0], /orphan-20261020/);
  const a = cli(w, "gc", "--apply");
  assert.equal(a.status, 0, a.stderr);
  assert.ok(fs.existsSync(aside));
});

// ── 审查 run(判词按设计留在 run 分支上,不合进 main,「已合进」永远判不出)───────────

// 提交一个文件(正文显式给:判词要靠「同内容进 main」与「另一版进 main」两种世界才分得开)
const commit = (cwd, file, body) => {
  fs.mkdirSync(path.join(cwd, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), body);
  sh(cwd, "add", "."); sh(cwd, "commit", "-qm", file);
};
const commitFile = (cwd, file) => commit(cwd, file, file + "\n");
// 一个不在 main 历史里的提交(做在被审分支上,做完回 main)
function offMain(w) {
  sh(w.repo, "checkout", "-q", "-b", "agent/foo");
  commitFile(w.repo, "f.txt");
  const sha = sh(w.repo, "rev-parse", "HEAD");
  sh(w.repo, "checkout", "-q", "main");
  return sha;
}
// 审查 run:任务书(含「审查对象」行)提交在 run 分支上
function mkReview(w, label, { spec, sha }) {
  const { wt } = mkRun(w, label, { meta: { spec }, result: { gates: "pass", round: 1 } });
  commit(wt, spec, `# 审查任务书\n\n审查对象:分支 \`agent/foo\` @ \`${sha}\`(m1-3)\n`);
  return wt;
}

test("gc:审查 run 的判词文件逐字在 main → 可清(spec 不像审查任务书的 run 行为不变)", () => {
  const w = world();
  const sha = offMain(w);
  const wt = mkReview(w, "rv-in", { spec: "docs/reviews/x-brief.md", sha });
  // 两份判词提交在 run 分支上,再把同内容提交进 main(判词只在分支上 = 清掉就是丢证据)
  commit(wt, "docs/reviews/x.minimax.md", "# 判词(minimax)\n");
  commit(wt, "docs/reviews/x.claude.md", "# 判词(claude)\n");
  commit(w.repo, "docs/reviews/x.minimax.md", "# 判词(minimax)\n");
  commit(w.repo, "docs/reviews/x.claude.md", "# 判词(claude)\n");
  // 非审查 run:分支有没合的提交 + pass → 今天就是 quiet
  commitFile(mkRun(w, "plain", { result: { gates: "pass", round: 1 } }).wt, "p.txt");
  const p = cli(w, "gc");
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /omdl-rv-in\s+审查 run,判词 2 份已逐字在 main/);
  assert.doesNotMatch(p.stdout, /omdl-plain/);
  assert.match(p.stdout, /其余 1 个\(pass 未合并 \/ 未到期限\):不动/);
});

test("gc:同名判词在 main 上但内容不同 → 不可清(一份不逐字就都不清)", () => {
  const w = world();
  const sha = offMain(w);
  const wt = mkReview(w, "rv-diff", { spec: "docs/reviews/x-brief.md", sha });
  commit(wt, "docs/reviews/x.minimax.md", "# 判词 A(分支上那版)\n");
  commit(wt, "docs/reviews/x.claude.md", "# 判词 C\n");
  commit(w.repo, "docs/reviews/x.minimax.md", "# 判词 B(main 上是另一版)\n"); // 同名不同内容
  commit(w.repo, "docs/reviews/x.claude.md", "# 判词 C\n");                     // 这一份逐字相同
  const p = cli(w, "gc");
  assert.equal(p.status, 0, p.stderr);
  assert.doesNotMatch(p.stdout, /omdl-rv-diff/, "一份不逐字就不许清");
  assert.match(p.stdout, /其余 1 个\(pass 未合并 \/ 未到期限\):不动/);
});

test("gc:被审提交已进 main、但判词只在分支上 → 不可清(清掉就是丢判词,17.10 fix5-client-a-oct2 形状)", () => {
  const w = world();
  commitFile(w.repo, "b.txt"); // 被审 head 在 main 上
  const sha = sh(w.repo, "rev-parse", "HEAD");
  // 真实形状:review-launch 的 base = 被审 head 上多一个任务书提交;meta.base / base_sha 记的是那个 sha,不是分支名
  const { wt } = mkRun(w, "rv-base", { meta: { spec: "docs/reviews/x-brief.md", base: sha, base_sha: sha }, result: { gates: "pass", round: 1 } });
  commit(wt, "docs/reviews/x-brief.md", `# 审查任务书\n\n审查对象:分支 \`agent/foo\` @ \`${sha}\`(m1-3)\n`);
  commit(wt, "docs/reviews/x.minimax.md", "# 判词(只在分支上)\n");
  const p = cli(w, "gc");
  assert.equal(p.status, 0, p.stderr);
  assert.doesNotMatch(p.stdout, /omdl-rv-base/, "被审提交进了 main ≠ 判词进了 main");
  assert.match(p.stdout, /其余 1 个\(pass 未合并 \/ 未到期限\):不动/);
});

test("gc:审查 run 的判词已进 main 上的合并稿 → 可清(重审任务书 x-brief-2 同 slug)", () => {
  const w = world();
  const sha = offMain(w);
  mkReview(w, "rv-out", { spec: "docs/reviews/x-brief.md", sha });
  mkReview(w, "rv-2", { spec: "docs/reviews/x-brief-2.md", sha });
  fs.mkdirSync(path.join(w.repo, "docs/reviews"), { recursive: true });
  fs.writeFileSync(path.join(w.repo, "docs/reviews/x.merged.md"), "# 判词\n");
  sh(w.repo, "add", "."); sh(w.repo, "commit", "-qm", "verdict");
  const p = cli(w, "gc");
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /omdl-rv-out\s+审查 run,判词已进合并稿 docs\/reviews\/x\.merged\.md/);
  assert.match(p.stdout, /omdl-rv-2\s+审查 run,判词已进合并稿 docs\/reviews\/x\.merged\.md/);
  assert.match(p.stdout, /其余 0 个/);
});

test("gc:spec 不是 docs/reviews/<slug>-brief(.N).md 的 run,即便判词逐字在 main / 旁边有合并稿也不动", () => {
  const w = world();
  const sha = offMain(w);
  // 两条都不是审查任务书:docs/reviews/ 下的别的文档 · reviews 目录外的 brief;正文里照样有「审查对象」行
  const docWt = mkReview(w, "rv-doc", { spec: "docs/reviews/doc.md", sha });
  mkReview(w, "rv-else", { spec: "other/x-brief.md", sha });
  commit(docWt, "docs/reviews/doc.minimax.md", "# 判词\n"); // 判词确实逐字在 main,spec 不认它就不清
  commit(w.repo, "docs/reviews/doc.minimax.md", "# 判词\n");
  commit(w.repo, "docs/reviews/doc.merged.md", "# 判词\n");
  commit(w.repo, "docs/reviews/x.merged.md", "# 判词\n");
  const p = cli(w, "gc");
  assert.equal(p.status, 0, p.stderr);
  assert.doesNotMatch(p.stdout, /omdl-rv-doc/);
  assert.doesNotMatch(p.stdout, /omdl-rv-else/);
  assert.match(p.stdout, /其余 2 个/);
});

test("gc:审查 run 只剩分支(worktree 已删)时按分支上的判词判,照旧可清", () => {
  const w = world();
  const sha = offMain(w);
  const wt = mkReview(w, "rv-wt", { spec: "docs/reviews/x-brief.md", sha });
  commit(wt, "docs/reviews/x.minimax.md", "# 判词\n");
  commit(w.repo, "docs/reviews/x.minimax.md", "# 判词\n");
  sh(w.repo, "worktree", "remove", wt); // 判词只在分支上,main 的工作区里没有
  const p = cli(w, "gc");
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /omdl\/rv-wt\s+审查 run,判词 1 份已逐字在 main/);
});

test("gc:判词文件名含非 ASCII 字符时也能逐字比对(git 默认 C 转义路径)", () => {
  const w = world();
  const sha = offMain(w);
  const wt = mkReview(w, "rv-cjk", { spec: "docs/reviews/x-brief.md", sha });
  commit(wt, "docs/reviews/x.中文.md", "# 判词\n");
  commit(w.repo, "docs/reviews/x.中文.md", "# 判词\n");
  const p = cli(w, "gc");
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /omdl-rv-cjk\s+审查 run,判词 1 份已逐字在 main/);
});

test("gc:只剩 worktree(分支没了)判不出判词 → 不动", () => {
  const w = world();
  const sha = offMain(w);
  const wt = mkReview(w, "rv-nobr", { spec: "docs/reviews/x-brief.md", sha });
  commit(wt, "docs/reviews/x.minimax.md", "# 判词\n");
  commit(w.repo, "docs/reviews/x.minimax.md", "# 判词\n");
  sh(wt, "checkout", "-q", "--detach"); // HEAD 不再挂在分支上,才能删掉那个分支
  sh(w.repo, "branch", "-q", "-D", "omdl/rv-nobr");
  const p = cli(w, "gc");
  assert.equal(p.status, 0, p.stderr);
  assert.doesNotMatch(p.stdout, /omdl-rv-nobr/, "分支没了就算不出分支上有哪几份判词");
  assert.match(p.stdout, /其余 1 个\(pass 未合并 \/ 未到期限\):不动/);
});

test("gc:审查 run 的可清理由不绕过「正在跑」与「有被忽略产物(§17)」", () => {
  const w = world();
  const sha = offMain(w);
  const live = mkReview(w, "rv-live", { spec: "docs/reviews/x-brief.md", sha }); // meta 没有结束时间 → 判还在跑
  commit(live, "docs/reviews/x.minimax.md", "# 判词\n");
  commit(w.repo, "docs/reviews/x.minimax.md", "# 判词\n");
  const artWt = mkReview(w, "rv-art", { spec: "docs/reviews/y-brief.md", sha });
  commit(artWt, "docs/reviews/y.minimax.md", "# 判词\n");
  commit(w.repo, "docs/reviews/y.minimax.md", "# 判词\n");
  fs.writeFileSync(path.join(w.runs, "rv-live/meta.json"),
    JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(w.runs, "rv-live/meta.json"), "utf8")),
      end_epoch: undefined, start_epoch: undefined, wall_seconds: undefined }) + "\n");
  fs.mkdirSync(path.join(artWt, "artifacts")); fs.writeFileSync(path.join(artWt, "artifacts/voice.wav"), "w");
  const p = cli(w, "gc");
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /omdl-rv-live.*正在跑/);
  assert.match(p.stdout, /omdl-rv-art.*被忽略的产物.*artifacts/);
  assert.doesNotMatch(p.stdout.split("## 不碰")[0], /omdl-rv-live|omdl-rv-art/);
});
