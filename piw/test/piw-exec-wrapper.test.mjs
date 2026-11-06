// node --test test/piw-exec-wrapper.test.mjs —— --exec-wrapper(S1 沙箱,17.10):执行体必须经 wrapper 起,
// 形状 `<wrapper> <worktree> -- <原命令…>`;dry-run 打出 wrapper 路径;不存在的 wrapper 不开跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "piw");
const STUB = path.resolve(import.meta.dirname, "fixtures", "pi-stub.mjs");
const WRAPPER = path.resolve(import.meta.dirname, "fixtures", "wrapper-stub.sh");

function sh(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-wrap-"));
  const envFile = path.join(home, "env");
  fs.writeFileSync(envFile, "DEEPSEEK_API_KEY=fake\n");
  const env = { ...process.env, HOME: home, PIW_PI_BIN: STUB, STUB_PLAN: "{}", STUB_LOG: path.join(home, "stub.log"),
    OMD_LITE_ENV_FILE: envFile, PIW_USAGE_DIR: path.join(home, "usage"), WRAPPER_LOG: path.join(home, "wrapper.log") };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "PIW_ENV_FILE", "PIW_ENV_KEEP", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  const repo = path.join(home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  return { home, env, repo };
}
const base = (repo) => ["run", "--repo", repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal", "--gate", "true",
  "--model", "deepseek/deepseek-v4-flash", "--fallback-model", "none"];

test("run:pi 经 wrapper 起,argv = <worktree> -- timeout <wall> <pi> …;meta.exec_wrapper 记路径", () => {
  const { home, env, repo } = fixture();
  const r = spawnSync("node", [BIN, ...base(repo), "--name", "wrapped", "--exec-wrapper", WRAPPER], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const lines = fs.readFileSync(env.WRAPPER_LOG, "utf8").trim().split("\n");
  assert.ok(lines.length >= 1, "wrapper 一次都没被调");
  const [wt, dash, timeout, wall, pi] = lines[0].split(" ");
  assert.ok(fs.existsSync(wt) || wt.includes("omdl-wrapped"), `第一个参数应是 worktree:${wt}`);
  assert.equal(dash, "--");
  assert.equal(timeout, "timeout");
  assert.match(wall, /^\d+$/);
  assert.equal(pi, STUB);
  const meta = JSON.parse(fs.readFileSync(path.join(home, ".omd-lite", "runs", "wrapped", "meta.json"), "utf8"));
  assert.equal(meta.exec_wrapper, WRAPPER);
});

test("run:不给 --exec-wrapper 时裸起(wrapper 日志不存在),meta 不记 exec_wrapper", () => {
  const { home, env, repo } = fixture();
  const r = spawnSync("node", [BIN, ...base(repo), "--name", "bare"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(env.WRAPPER_LOG));
  const meta = JSON.parse(fs.readFileSync(path.join(home, ".omd-lite", "runs", "bare", "meta.json"), "utf8"));
  assert.equal(meta.exec_wrapper, undefined);
});

test("run:--exec-wrapper 指向不存在的文件 → 不开跑,exit 非 0", () => {
  const { env, repo } = fixture();
  const r = spawnSync("node", [BIN, ...base(repo), "--name", "nowrap", "--exec-wrapper", "/nonexistent/wrap.sh"], { encoding: "utf8", env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exec-wrapper 不存在/);
});

test("dry-run:打出 exec-wrapper 行", () => {
  const { env, repo } = fixture();
  const r = spawnSync("node", [BIN, ...base(repo), "--name", "dry", "--dry-run", "--exec-wrapper", WRAPPER], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`exec-wrapper: ${WRAPPER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const r2 = spawnSync("node", [BIN, ...base(repo), "--name", "dry2", "--dry-run"], { encoding: "utf8", env });
  assert.match(r2.stdout, /exec-wrapper: 无/);
});
