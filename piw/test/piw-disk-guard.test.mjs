// node --test test/piw-disk-guard.test.mjs —— PIW_DISK_GUARD(20.10):设了就在 worktree add 前调用,worktree 路径追加在末尾;
// 非 0 → 不建 worktree、不起执行体,meta.json 记 failureClass disk 与钩子输出;没设不判。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "piw");
const STUB = path.resolve(import.meta.dirname, "fixtures", "pi-stub.mjs");

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-disk-"));
  const envFile = path.join(home, "env");
  fs.writeFileSync(envFile, "DEEPSEEK_API_KEY=fake\n");
  const env = { ...process.env, HOME: home, PIW_PI_BIN: STUB, STUB_PLAN: "{}", STUB_LOG: path.join(home, "stub.log"),
    OMD_LITE_ENV_FILE: envFile, PIW_USAGE_DIR: path.join(home, "usage") };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "PIW_ENV_FILE", "PIW_ENV_KEEP", "CLAUDE_CODE_SESSION_ID", "PIW_DISK_GUARD"]) delete env[k];
  const repo = path.join(home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "init");
  return { home, env, repo };
}
const args = (repo, name) => ["run", "--repo", repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal", "--gate", "true",
  "--model", "deepseek/deepseek-v4-flash", "--fallback-model", "none", "--name", name];

test("钩子退非 0:不建 worktree、不调执行体,meta 记 failureClass disk 与钩子 stderr", () => {
  const { home, env, repo } = fixture();
  const seen = path.join(home, "guard-args");
  const r = spawnSync("node", [BIN, ...args(repo, "low")], { encoding: "utf8",
    env: { ...env, PIW_DISK_GUARD: `sh -c 'echo "$@" > ${seen}; echo "disk-floor: 盘 root_free 92.4 GiB 拒" >&2; exit 1' guard --entry piw` } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /盘线拒起/);
  assert.match(r.stderr, /root_free 92\.4/);
  const wt = path.join(home, "repos", "omdl-low");
  assert.equal(fs.readFileSync(seen, "utf8").trim(), `--entry piw ${wt}`);
  assert.ok(!fs.existsSync(wt));
  assert.equal(git(repo, "worktree", "list").trim().split("\n").length, 1);
  assert.ok(!fs.existsSync(env.STUB_LOG), "执行体不该被调");
  const meta = JSON.parse(fs.readFileSync(path.join(home, ".omd-lite", "runs", "low", "meta.json"), "utf8"));
  assert.equal(meta.failureClass, "disk");
  assert.equal(meta.disk_guard.exit, 1);
  assert.match(meta.disk_guard.stderr, /root_free 92\.4/);
  const result = JSON.parse(fs.readFileSync(path.join(home, ".omd-lite", "runs", "low", "result.json"), "utf8"));
  assert.equal(result.failureClass, "disk");
});

test("钩子退 0:照常建 worktree 跑完", () => {
  const { home, env, repo } = fixture();
  const r = spawnSync("node", [BIN, ...args(repo, "ok")], { encoding: "utf8", env: { ...env, PIW_DISK_GUARD: "true" } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, "repos", "omdl-ok")));
});

test("没设钩子:不判", () => {
  const { home, env, repo } = fixture();
  const r = spawnSync("node", [BIN, ...args(repo, "none")], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, "repos", "omdl-none")));
});

test("--reuse-worktree 不新建,不调钩子", () => {
  const { home, env, repo } = fixture();
  const wt = path.join(home, "repos", "reuse-wt");
  git(repo, "worktree", "add", "-q", "-b", "omdl/r", wt, "main");
  const r = spawnSync("node", [BIN, ...args(repo, "r2"), "--reuse-worktree", wt], { encoding: "utf8", env: { ...env, PIW_DISK_GUARD: "exit 1" } });
  assert.equal(r.status, 0, r.stderr);
});
