// node --test test/deploy-s11.test.mjs —— deploy/s11-rename.sh 在沙箱 HOME 里跑:改名、软链、锚、补丁、settings.json;幂等;dry-run 不改东西;有 run 在跑就退出。
// 不碰真实的 ~/repos、~/.local/bin、~/.omd-lite、~/.claude:所有路径都从沙箱 HOME 来(S11_REPOS 指到沙箱里)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dirname, "..", "deploy", "s11-rename.sh");
const FIX = path.resolve(import.meta.dirname, "fixtures", "deploy");
const NEVER = "^zzz-never-matches-anything-zzz$";

function sandbox({ merged = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "s11-deploy-"));
  const repos = path.join(home, "repos");
  const omd = path.join(repos, "omd-lite");
  fs.mkdirSync(path.join(omd, "bin"), { recursive: true });
  spawnSync("git", ["-C", omd, "init", "-q", "-b", "main"]);
  if (merged) {
    fs.writeFileSync(path.join(omd, "bin", "piw"), "#!/bin/sh\necho piw\n", { mode: 0o755 });
    fs.symlinkSync("piw", path.join(omd, "bin", "omd-lite"));
  } else {
    fs.writeFileSync(path.join(omd, "bin", "omd-lite"), "#!/bin/sh\necho old\n", { mode: 0o755 });
  }
  fs.mkdirSync(path.join(home, ".omd-lite", "bin"), { recursive: true });
  fs.copyFileSync(path.join(FIX, "slot-run.sh.orig"), path.join(home, ".omd-lite", "bin", "slot-run.sh"));
  fs.chmodSync(path.join(home, ".omd-lite", "bin", "slot-run.sh"), 0o755);
  fs.mkdirSync(path.join(home, ".claude", "bin"), { recursive: true });
  fs.copyFileSync(path.join(FIX, "prune-agent-worktrees.sh.orig"), path.join(home, ".claude", "bin", "prune-agent-worktrees.sh"));
  fs.chmodSync(path.join(home, ".claude", "bin", "prune-agent-worktrees.sh"), 0o755);
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
    enabledPlugins: { "agent-guard@lead-harness": true },
    pluginConfigs: { "agent-guard@lead-harness": { options: { requireWorktreeRepos: "myapp,otherapp,oh-my-dag,omd-lite" } }, "other@x": { options: { a: 1 } } },
    other: [1, 2],
  }, null, 2) + "\n");
  const sh = (args = [], env = {}) => spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, S11_REPOS: repos, S11_PGREP_PATTERN: NEVER, ...env },
  });
  return { home, repos, omd, sh, settings: () => JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")) };
}

// 沙箱目录树的快照(路径 + 类型 + 文件内容/链接目标),用来断言 dry-run 什么都没改
function snapshot(root) {
  const out = [];
  const walk = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) out.push(`${p} -> ${fs.readlinkSync(p)}`);
    else if (st.isDirectory()) { out.push(`${p}/`); for (const f of fs.readdirSync(p).sort()) if (f !== ".git") walk(path.join(p, f)); }
    else out.push(`${p} ${st.mode.toString(8)} ${fs.readFileSync(p, "utf8").length}`);
  };
  walk(root);
  return out.join("\n");
}

test("执行:目录改名 + 旧路径软链 + bin/omd-lite 软链 + PATH 入口 + 锚 + 补丁 + settings.json,每处改前有 .bak-S11", () => {
  const w = sandbox();
  const r = w.sh();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const piw = path.join(w.repos, "piw");
  // A
  assert.ok(fs.statSync(piw).isDirectory() && !fs.lstatSync(piw).isSymbolicLink());
  assert.ok(fs.lstatSync(w.omd).isSymbolicLink());
  assert.equal(fs.readlinkSync(w.omd), "piw");
  // B(SDD 验收的 readlink 条目,在沙箱里)
  assert.match(fs.realpathSync(path.join(w.omd, "bin", "omd-lite")), /repos\/piw\/bin\/piw$/);
  assert.equal(spawnSync("sh", ["-c", `readlink -f "${w.omd}/bin/omd-lite" | grep -q repos/piw/bin/piw`]).status, 0);
  // C
  const link = path.join(w.home, ".local", "bin", "piw");
  assert.equal(fs.readlinkSync(link), path.join(piw, "bin", "piw"));
  assert.equal(spawnSync(link, [], { encoding: "utf8" }).stdout.trim(), "piw", "PATH 入口能跑到 piw");
  // D
  const slot = fs.readFileSync(path.join(w.home, ".omd-lite", "bin", "slot-run.sh"), "utf8");
  assert.ok(slot.includes("'^node [^ ]*/(omd-lite|piw) run'"));
  assert.ok(!slot.includes("'^node /home/user/repos/omd-lite/bin/omd-lite run'"));
  assert.equal(fs.statSync(path.join(w.home, ".omd-lite", "bin", "slot-run.sh")).mode & 0o777, 0o755, "权限保留");
  assert.equal(spawnSync("bash", ["-n", path.join(w.home, ".omd-lite", "bin", "slot-run.sh")]).status, 0);
  assert.equal(fs.readFileSync(path.join(w.home, ".omd-lite", "bin", "slot-run.sh.bak-S11"), "utf8"), fs.readFileSync(path.join(FIX, "slot-run.sh.orig"), "utf8"));
  // E
  const prune = path.join(w.home, ".claude", "bin", "prune-agent-worktrees.sh");
  assert.match(fs.readFileSync(prune, "utf8"), /resumed_done/);
  assert.equal(spawnSync("bash", ["-n", prune]).status, 0);
  assert.equal(fs.readFileSync(prune + ".bak-S11", "utf8"), fs.readFileSync(path.join(FIX, "prune-agent-worktrees.sh.orig"), "utf8"));
  // F
  const st = w.settings();
  assert.equal(st.pluginConfigs["agent-guard@lead-harness"].options.requireWorktreeRepos, "myapp,otherapp,oh-my-dag,omd-lite,piw");
  assert.deepEqual(st.pluginConfigs["other@x"], { options: { a: 1 } });
  assert.deepEqual(st.other, [1, 2]);
  assert.ok(fs.existsSync(path.join(w.home, ".claude", "settings.json.bak-S11")));
});

test("幂等:第二次执行什么都不改,输出「全部已完成」,备份不被覆盖", () => {
  const w = sandbox();
  assert.equal(w.sh().status, 0);
  const before = snapshot(w.home);
  const bakBefore = fs.readFileSync(path.join(w.home, ".claude", "settings.json.bak-S11"), "utf8");
  const r = w.sh();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /全部已完成/);
  assert.match(r.stdout, /跳过\(已完成\):A/);
  assert.equal(snapshot(w.home), before);
  assert.equal(fs.readFileSync(path.join(w.home, ".claude", "settings.json.bak-S11"), "utf8"), bakBefore);
});

test("--dry-run:逐步打印要做什么,什么都不改", () => {
  const w = sandbox();
  const before = snapshot(w.home);
  const r = w.sh(["--dry-run"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const step of ["A mv", "C ln -sfn", "D slot-run.sh", "E prune-agent-worktrees.sh", "F settings.json"]) assert.ok(r.stdout.includes(step), `缺 ${step}\n${r.stdout}`);
  assert.match(r.stdout, /\[dry-run\] 将做/);
  assert.equal(snapshot(w.home), before);
});

test("已经改过名的(只有 settings 没改)再跑:只补缺的一步", () => {
  const w = sandbox();
  assert.equal(w.sh().status, 0);
  const f = path.join(w.home, ".claude", "settings.json");
  const j = w.settings();
  j.pluginConfigs["agent-guard@lead-harness"].options.requireWorktreeRepos = "myapp,omd-lite";
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  const r = w.sh();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /改了 1 处/);
  assert.equal(w.settings().pluginConfigs["agent-guard@lead-harness"].options.requireWorktreeRepos, "myapp,omd-lite,piw");
});

test("有 run 在跑:退出码 3,什么都不动", async () => {
  const w = sandbox();
  const before = snapshot(w.home);
  const k = spawn("sleep", ["30"], { argv0: "node /home/user/repos/piw/bin/piw run", stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  try {
    const r = w.sh([], { S11_PGREP_PATTERN: "^node [^ ]*/(omd-lite|piw) run" }); // 脚本的默认锚
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /有 \d+ 个 run 在跑/);
    assert.equal(snapshot(w.home), before);
    // dry-run 只报告
    const d = w.sh(["--dry-run"], { S11_PGREP_PATTERN: "^node [^ ]*/(omd-lite|piw) run" });
    assert.equal(d.status, 0);
    assert.match(d.stdout, /注意:现在有 \d+ 个 run 在跑/);
  } finally { k.kill(); }
});

test("默认的 pgrep 锚能数到 piw 与 omd-lite 两种命令行(不数调用方 shell 里的字)", async () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const m = src.match(/PATTERN=\$\{S11_PGREP_PATTERN:-'([^']+)'\}/);
  assert.ok(m, "脚本里找不到默认锚");
  const kids = ["node /home/user/repos/piw/bin/piw run", "node /home/user/repos/omd-lite/bin/omd-lite run", "node /home/user/.local/bin/piw run"].map((n) => spawn("sleep", ["30"], { argv0: n, stdio: "ignore" }));
  await new Promise((r) => setTimeout(r, 300));
  try {
    const pids = spawnSync("pgrep", ["-f", m[1]], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
    for (const k of kids) assert.ok(pids.includes(k.pid));
    // 调用方 bash -c 命令行里带这串字,也不该被数
    const holder = spawn("bash", ["-c", "sleep 30; : 'pgrep -fc (omd-lite|piw) run'"], { stdio: "ignore", detached: true });
    await new Promise((r) => setTimeout(r, 300));
    try { assert.ok(!spawnSync("pgrep", ["-f", m[1]], { encoding: "utf8" }).stdout.split("\n").includes(String(holder.pid))); } finally { try { process.kill(-holder.pid); } catch {} } // 整个进程组:bash 和它的 sleep 子进程都是本测试起的
  } finally { for (const k of kids) k.kill(); }
});

test("分支没合并(没有 bin/piw):退出码 4,不改名", () => {
  const w = sandbox({ merged: false });
  const before = snapshot(w.home);
  const r = w.sh();
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stderr, /bin\/piw 不存在/);
  assert.equal(snapshot(w.home), before);
});

test("补丁套不上(线上脚本被改过):退出码 5,已做的步骤不回退也不半改", () => {
  const w = sandbox();
  const prune = path.join(w.home, ".claude", "bin", "prune-agent-worktrees.sh");
  fs.writeFileSync(prune, "#!/bin/bash\necho 被人改过\n");
  const r = w.sh();
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(prune, "utf8"), "#!/bin/bash\necho 被人改过\n");
  assert.ok(!fs.existsSync(prune + ".bak-S11"));
});
