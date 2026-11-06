// node --test test/piw-orphan-branch.test.mjs —— 起片进程在建完分支 / worktree、还没建 run 目录时被杀,
// 留下的空分支下次 run 要清掉;分支或 worktree 里有真东西就照旧拒绝。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "piw");
const STUB = path.resolve(import.meta.dirname, "fixtures", "pi-stub.mjs");

function sh(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-orphan-"));
  const envFile = path.join(home, "env");
  fs.writeFileSync(envFile, "DEEPSEEK_API_KEY=fake\n");
  const env = { ...process.env, HOME: home, PIW_PI_BIN: STUB, STUB_PLAN: "{}", STUB_LOG: path.join(home, "stub.log"),
    OMD_LITE_ENV_FILE: envFile, PIW_USAGE_DIR: path.join(home, "usage") };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "PIW_ENV_FILE", "PIW_ENV_KEEP", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  const repo = path.join(home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const f = { home, repo, wt: (name) => path.join(home, "repos", `omdl-${name}`) };
  // 宿主 /proc 里常驻 cwd 读不了的自己进程(systemd --user、gpg-agent),用真 /proc 永远清不了;默认给一个干净的假 /proc
  env.PIW_PROC_ROOT = fakeProc(f);
  f.run = (name, extra = {}, spec = "spec.md") => spawnSync("node", [BIN, "run", "--repo", repo, "--base", "main", "--spec", spec, "--prompt", "minimal",
    "--gate", "true", "--model", "deepseek/deepseek-v4-flash", "--fallback-model", "none", "--name", name], { encoding: "utf8", env: { ...env, ...extra } });
  return f;
}

test("被杀留下的空分支 + 没检出的 worktree → 清掉后照常开跑", () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", "--no-checkout", f.wt("killed"), "-b", "omdl/killed", "main");
  const r = f.run("killed");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /piw: 清掉上次被杀留下的空分支 omdl\/killed/);
  assert.ok(fs.existsSync(path.join(f.home, ".omd-lite", "runs", "killed", "meta.json")));
});

test("分支上有自己的提交 → 照旧拒绝,分支不动", () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", f.wt("work"), "-b", "omdl/work", "main");
  fs.writeFileSync(path.join(f.wt("work"), "a.txt"), "x\n");
  sh(f.wt("work"), "add", "."); sh(f.wt("work"), "commit", "-qm", "own");
  const tip = sh(f.repo, "rev-parse", "omdl/work");
  const r = f.run("work");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already exists/);
  assert.equal(sh(f.repo, "rev-parse", "omdl/work"), tip);
});

test("杀在 checkout 半路(index 为空,文件写了一半)→ 也算空,清掉开跑", () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", "--no-checkout", f.wt("half"), "-b", "omdl/half", "main");
  fs.writeFileSync(path.join(f.wt("half"), "spec.md"), "");
  const r = f.run("half");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /清掉上次被杀留下的空分支 omdl\/half/);
});

test("有进程 cwd 在 worktree 里 → 照旧拒绝", async () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", "--no-checkout", f.wt("busy"), "-b", "omdl/busy", "main");
  const p = spawn("sleep", ["30"], { cwd: f.wt("busy") });
  try {
    const r = f.run("busy", { PIW_PROC_ROOT: "/proc" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`进程 ${p.pid} 的 cwd 在 worktree 里`));
    assert.match(r.stderr, /already exists/);
    assert.ok(fs.existsSync(f.wt("busy")));
  } finally { p.kill(); }
});

test("别的 run 用 --reuse-worktree 在里面干过活(run 记录指向它)→ 照旧拒绝,改动还在", () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", "--no-checkout", f.wt("reused"), "-b", "omdl/reused", "main");
  fs.writeFileSync(path.join(f.wt("reused"), "spec.md"), "# edited by resumed run\n");
  const dir = path.join(f.home, ".omd-lite", "runs", "resume-1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ label: "resume-1", worktree: f.wt("reused") }));
  const r = f.run("reused");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already exists/);
  assert.equal(fs.readFileSync(path.join(f.wt("reused"), "spec.md"), "utf8"), "# edited by resumed run\n");
});

test("worktree 里有改过的跟踪文件 + 新文件 → 照样清掉,但两样都能从 refs/piw-orphan/ 存档里找回", () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", f.wt("edited"), "-b", "omdl/edited", "main");
  const tip = sh(f.repo, "rev-parse", "omdl/edited");
  fs.writeFileSync(path.join(f.wt("edited"), "spec.md"), "# hand edit\n");
  fs.writeFileSync(path.join(f.wt("edited"), "notes.txt"), "mine\n");
  const r = f.run("edited");
  assert.equal(r.status, 0, r.stderr);
  const [ref] = sh(f.repo, "for-each-ref", "--format=%(refname)", "refs/piw-orphan/").split("\n");
  assert.match(ref, /^refs\/piw-orphan\/edited-\d{8}T\d{6}Z$/);
  assert.match(r.stderr, new RegExp(`原样存档 ${ref}`));
  assert.equal(sh(f.repo, "rev-parse", `${ref}^`), tip);
  assert.equal(sh(f.repo, "show", `${ref}:spec.md`), "# hand edit");
  assert.equal(sh(f.repo, "show", `${ref}:notes.txt`), "mine");
});

test("同名 label 另一个起片正持有起片锁 → 明确失败,不清分支", () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", "--no-checkout", f.wt("race"), "-b", "omdl/race", "main");
  const runs = path.join(f.home, ".omd-lite", "runs");
  fs.mkdirSync(runs, { recursive: true });
  const holder = spawn("flock", [path.join(runs, ".race.launch.lock"), "sleep", "30"]);
  try {
    spawnSync("sleep", ["0.3"]);
    const r = f.run("race");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /正在起片/);
    assert.ok(sh(f.repo, "rev-parse", "--verify", "omdl/race"));
    assert.ok(fs.existsSync(f.wt("race")));
  } finally { holder.kill(); }
});

function fakeProc(f, { mounts = "proc /proc proc rw,nosuid 0 0\n", locked = false, undumpable = null } = {}) {
  const root = fs.mkdtempSync(path.join(f.home, "proc-"));
  fs.mkdirSync(path.join(root, "1"), { recursive: true });
  fs.writeFileSync(path.join(root, "mounts"), mounts);
  if (locked) { fs.mkdirSync(path.join(root, "4242")); fs.chmodSync(path.join(root, "4242"), 0o000); }
  if (undumpable) {
    // 不可 dump 的自己进程:readlink cwd 失败(这里用普通文件,readlink 报 EINVAL),status / cmdline 可读
    const d = path.join(root, "4343");
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "cwd"), "");
    fs.writeFileSync(path.join(d, "status"), `Name:\tbash\nState:\t${undumpable.state}\n`);
    fs.writeFileSync(path.join(d, "cmdline"), undumpable.cmdline);
  }
  return root;
}

// 证明不了没人在用:旧目录原样挪到 omdl-<label>.orphan-<时间>(HEAD 分离),分支删掉,新 run 在原路径照常起
function assertMovedAside(f, name, r, why) {
  assert.equal(r.status, 0, r.stderr);
  const m = r.stderr.match(new RegExp(`piw: 证明不了没人在用 ${f.wt(name)}\\((.*?)\\),挪到 (\\S+?\\.orphan-\\d{8}T\\d{6}Z)`));
  assert.ok(m, r.stderr);
  assert.match(m[1], why);
  const aside = m[2];
  assert.equal(path.basename(aside).replace(/\.orphan-.*$/, ""), `omdl-${name}`);
  assert.ok(fs.existsSync(path.join(aside, ".git")));
  assert.equal(spawnSync("git", ["-C", aside, "symbolic-ref", "-q", "HEAD"]).status, 1, "挪开的 worktree HEAD 已分离");
  assert.ok(fs.existsSync(path.join(f.home, ".omd-lite", "runs", name, "meta.json")));
  assert.ok(sh(f.repo, "for-each-ref", "refs/piw-orphan/"));
  return aside;
}

test("读某个进程的 cwd 被拒(EACCES)→ 证明不了没人在用,挪开不删", () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", "--no-checkout", f.wt("eacces"), "-b", "omdl/eacces", "main");
  const r = f.run("eacces", { PIW_PROC_ROOT: fakeProc(f, { locked: true }) });
  assertMovedAside(f, "eacces", r, /4242/);
});

test("/proc 挂了 hidepid → 看不全进程,挪开不删", () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", "--no-checkout", f.wt("hidden"), "-b", "omdl/hidden", "main");
  const r = f.run("hidden", { PIW_PROC_ROOT: fakeProc(f, { mounts: "proc /proc proc rw,hidepid=2 0 0\n" }) });
  assertMovedAside(f, "hidden", r, /hidepid/);
});

test("假 /proc 正常可读 → 照常清掉开跑", () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", "--no-checkout", f.wt("okproc"), "-b", "omdl/okproc", "main");
  const r = f.run("okproc", { PIW_PROC_ROOT: fakeProc(f) });
  assert.equal(r.status, 0, r.stderr);
});

test("目标目录是别的(detached)worktree → 不清分支,说明原因", () => {
  const f = fixture();
  sh(f.repo, "branch", "omdl/detached", "main");
  sh(f.repo, "worktree", "add", "--detach", f.wt("detached"), "main");
  const r = f.run("detached");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /不清 omdl\/detached.*不是这个分支的 worktree/);
  assert.ok(sh(f.repo, "rev-parse", "--verify", "omdl/detached"));
});

test("自己的进程 cwd 读不了(手开的 shell cd 进去后不可 dump,命令行不提路径也不算证明)→ 不删,挪开;里面的改动原地还在", () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", f.wt("undump"), "-b", "omdl/undump", "main");
  fs.writeFileSync(path.join(f.wt("undump"), "spec.md"), "# shell 里正在改\n");
  const r = f.run("undump", { PIW_PROC_ROOT: fakeProc(f, { undumpable: { state: "S (sleeping)", cmdline: "bash\0-i\0" } }) });
  const aside = assertMovedAside(f, "undump", r, /4343/);
  assert.equal(fs.readFileSync(path.join(aside, "spec.md"), "utf8"), "# shell 里正在改\n");
  assert.equal(fs.readFileSync(path.join(f.wt("undump"), "spec.md"), "utf8"), "# spec\n");
});

test("cwd 读不了的自己进程是僵尸 → 不挡,照常清掉", () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", "--no-checkout", f.wt("zombie"), "-b", "omdl/zombie", "main");
  const r = f.run("zombie", { PIW_PROC_ROOT: fakeProc(f, { undumpable: { state: "Z (zombie)", cmdline: "" } }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /清掉上次被杀留下的空分支 omdl\/zombie/);
});

test("完整检出后人手删了 / 改名了跟踪文件 → 存档里删的不在、改名只剩新名", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, "gone.txt"), "g\n");
  fs.writeFileSync(path.join(f.repo, "old.txt"), "o\n");
  sh(f.repo, "add", "."); sh(f.repo, "commit", "-qm", "more");
  sh(f.repo, "worktree", "add", f.wt("deleted"), "-b", "omdl/deleted", "main");
  fs.rmSync(path.join(f.wt("deleted"), "gone.txt"));
  fs.renameSync(path.join(f.wt("deleted"), "old.txt"), path.join(f.wt("deleted"), "new.txt"));
  const r = f.run("deleted");
  assert.equal(r.status, 0, r.stderr);
  const [ref] = sh(f.repo, "for-each-ref", "--format=%(refname)", "refs/piw-orphan/").split("\n");
  assert.deepEqual(sh(f.repo, "ls-tree", "-r", "--name-only", ref).split("\n").sort(), ["new.txt", "spec.md"]);
});

test("稀疏检出:排除目录里的跟踪文件没检出不算删,执行手写进排除目录的新文件也存下", () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.repo, "arch"));
  fs.writeFileSync(path.join(f.repo, "arch", "old.md"), "a\n");
  sh(f.repo, "add", "."); sh(f.repo, "commit", "-qm", "arch");
  sh(f.repo, "worktree", "add", "--no-checkout", f.wt("sparse"), "-b", "omdl/sparse", "main");
  sh(f.wt("sparse"), "sparse-checkout", "set", "--no-cone", "/*", "!/arch/");
  sh(f.wt("sparse"), "checkout", "-q");
  assert.ok(!fs.existsSync(path.join(f.wt("sparse"), "arch", "old.md")));
  fs.mkdirSync(path.join(f.wt("sparse"), "arch"));
  fs.writeFileSync(path.join(f.wt("sparse"), "arch", "new.md"), "n\n");
  const r = f.run("sparse");
  assert.equal(r.status, 0, r.stderr);
  const [ref] = sh(f.repo, "for-each-ref", "--format=%(refname)", "refs/piw-orphan/").split("\n");
  assert.deepEqual(sh(f.repo, "ls-tree", "-r", "--name-only", ref).split("\n").sort(), ["arch/new.md", "arch/old.md", "spec.md"]);
});

test("worktree 开了 split index → 仍按检出过处理,人手删的不复活", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, "gone.txt"), "g\n");
  sh(f.repo, "add", "."); sh(f.repo, "commit", "-qm", "more");
  sh(f.repo, "worktree", "add", f.wt("split"), "-b", "omdl/split", "main");
  sh(f.wt("split"), "update-index", "--split-index");
  fs.rmSync(path.join(f.wt("split"), "gone.txt"));
  const r = f.run("split");
  assert.equal(r.status, 0, r.stderr);
  const [ref] = sh(f.repo, "for-each-ref", "--format=%(refname)", "refs/piw-orphan/").split("\n");
  assert.deepEqual(sh(f.repo, "ls-tree", "-r", "--name-only", ref).split("\n"), ["spec.md"]);
});

test("挪开失败(目标被 lock)→ 不删分支、HEAD 不分离,说明原因", () => {
  const f = fixture();
  sh(f.repo, "worktree", "add", f.wt("locked"), "-b", "omdl/locked", "main");
  sh(f.repo, "worktree", "lock", f.wt("locked"));
  const r = f.run("locked", { PIW_PROC_ROOT: fakeProc(f, { locked: true }) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /不清 omdl\/locked.*挪开失败/);
  assert.equal(sh(f.wt("locked"), "symbolic-ref", "HEAD"), "refs/heads/omdl/locked");
});

test("任务书给成仓内绝对路径 → 换成相对仓根照常开跑,meta.spec 记相对路径", () => {
  const f = fixture();
  const r = f.run("abs-spec", {}, path.join(f.repo, "spec.md"));
  assert.equal(r.status, 0, r.stderr);
  const meta = JSON.parse(fs.readFileSync(path.join(f.home, ".omd-lite", "runs", "abs-spec", "meta.json"), "utf8"));
  assert.equal(meta.spec, "spec.md");
});
