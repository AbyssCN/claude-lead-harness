// node --test test/piw-codex.test.mjs —— S6a-1:--executor codex 一条臂(codex exec,沙箱 workspace-write + 开网络);
// 非 pi 臂的闸也经 --exec-wrapper 起(bwrap-audit F9:闸与执行体同在沙箱内)。
// 执行体全用替身:PATH 上的 codex / agy 只记 argv 就退出,不调真 CLI、不打网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "piw");
const WRAPPER = path.resolve(import.meta.dirname, "fixtures", "wrapper-stub.sh");
const MODEL = "gpt-5-codex";

function sh(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// 执行体替身:把自己的 argv 记进 STUB_LOG(jsonl)再 exit 0 —— 不调真 CLI、不打网络
function stubCli(home, name) {
  const dir = path.join(home, "bin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`, { mode: 0o755 });
}

// wrapper 替身(test/fixtures/wrapper-stub.sh + 一行:codex 的子命令 exec 留给真 codex,替身只当 CLI)
function stubWrapper(home) {
  const f = path.join(home, "wrap-codex.sh");
  fs.writeFileSync(f, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${WRAPPER_LOG:?}"
wt=$1; shift; [ "$1" = "--" ] && shift
[ "$1" = "exec" ] && shift
exec "$@"
`, { mode: 0o755 });
  return f;
}

function fixture(names = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-codex-"));
  const envFile = path.join(home, "env");
  fs.writeFileSync(envFile, "DEEPSEEK_API_KEY=fake\n");
  for (const n of names) stubCli(home, n);
  const env = { ...process.env, HOME: home, PIW_PI_BIN: path.join(import.meta.dirname, "fixtures", "pi-stub.mjs"),
    STUB_PLAN: "{}", STUB_LOG: path.join(home, "stub.log"), OMD_LITE_ENV_FILE: envFile,
    PIW_USAGE_DIR: path.join(home, "usage"), WRAPPER_LOG: path.join(home, "wrapper.log") };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "PIW_ENV_FILE", "PIW_ENV_KEEP", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  if (names.length) env.PATH = `${path.join(home, "bin")}:${env.PATH}`;
  const repo = path.join(home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  return { home, env, repo };
}
const base = (repo, executor, ...extra) => ["run", "--repo", repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal",
  "--executor", executor, "--model", MODEL, "--fallback-model", "none", ...extra];
const lines = (f) => fs.readFileSync(f, "utf8").trim().split("\n");
const runDir = (home, name) => path.join(home, ".omd-lite", "runs", name);
const meta = (home, name) => JSON.parse(fs.readFileSync(path.join(runDir(home, name), "meta.json"), "utf8"));
const result = (home, name) => JSON.parse(fs.readFileSync(path.join(runDir(home, name), "result.json"), "utf8"));

test("run --executor codex:一轮经 wrapper 起,argv 形状固定;meta.executor 与 codex-round-1.log", () => {
  const { home, env, repo } = fixture(["codex"]);
  const wrap = stubWrapper(home);
  const r = spawnSync("node", [BIN, ...base(repo, "codex", "--gate", "true", "--name", "cx", "--exec-wrapper", wrap)], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);

  const wl = lines(env.WRAPPER_LOG);
  const cx = wl.find((l) => l.includes(" -- codex exec -s workspace-write "));
  assert.ok(cx, `wrapper 日志里没有 codex 那一行:\n${wl.join("\n")}`);
  const wt = path.join(path.dirname(repo), "omdl-cx");
  const want = ["codex", "exec", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-C", wt,
    "--skip-git-repo-check", "-m", MODEL, "-o", path.join(runDir(home, "cx"), "codex-round-1.last.md")];
  // wrapper 替身记的是 "$*"(空格拼起来的整条 argv),参数里没有空格,按空格切即可逐个比
  assert.deepEqual(cx.split(" ").slice(2, 2 + want.length), want, `-- 后依次是决策 2 的参数(实际:${cx})`);
  // 替身自己看到的 argv:wrapper 剥掉 <wt> 与 --,"codex" 是它的 argv[0] 不进参数(证明执行体真起了,不是只写了一行日志)
  const stubArgv = JSON.parse(fs.readFileSync(env.STUB_LOG, "utf8").trim());
  assert.deepEqual(stubArgv.slice(0, -1), want.slice(1), "替身收到的参数与 wrapper 日志里的一致");
  assert.match(stubArgv.at(-1), /你是执行者/, "整条 argv 的末位是提示词正文");
  assert.equal(meta(home, "cx").executor, "codex");
  assert.equal(result(home, "cx").gates, "pass");
  assert.ok(fs.existsSync(path.join(runDir(home, "cx"), "codex-round-1.log")), "run 目录里有 codex-round-1.log");
});

test("run --dry-run --executor codex:打 executor 行与第 1 轮 argv(开网络那一条在)", () => {
  const { env, repo } = fixture();
  const r = spawnSync("node", [BIN, ...base(repo, "codex", "--gate", "true", "--name", "cxdry", "--dry-run")], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^executor: codex$/m);
  assert.match(r.stdout, /"sandbox_workspace_write\.network_access=true"/);
});

test("非 pi 臂的闸经 wrapper 起:<wrapper> <worktree> -- bash -lc <cmd>(F9)", () => {
  const { home, env, repo } = fixture(["agy"]);
  const r = spawnSync("node", [BIN, ...base(repo, "agy", "--gate", "echo G1", "--name", "agygate", "--exec-wrapper", WRAPPER)], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const gate = lines(env.WRAPPER_LOG).find((l) => l.includes(" -- bash -lc "));
  assert.ok(gate, `wrapper 日志里没有闸那一行:\n${lines(env.WRAPPER_LOG).join("\n")}`);
  assert.ok(gate.endsWith(" -- bash -lc echo G1"), `闸那一行 argv 不对:${gate}`);
  assert.equal(result(home, "agygate").gates, "pass");
});

test("不给 --exec-wrapper:闸照常裸起(exit 3 → 判闸红),wrapper 一个都没起", () => {
  const { home, env, repo } = fixture(["agy"]);
  const r = spawnSync("node", [BIN, ...base(repo, "agy", "--gate", "exit 3", "--max-rounds", "1", "--name", "baregate")], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(env.WRAPPER_LOG), "没给 --exec-wrapper,不该有 wrapper 日志");
  const res = result(home, "baregate");
  assert.equal(res.gates, "fail");
  assert.equal(res.failed_gate, "exit 3");
  assert.equal(res.exit, 3);
  assert.equal(meta(home, "baregate").exec_wrapper, undefined);
});

// 18.10 S6b 首跑:闸经 wrapper 起时没带 run 的环境,sandbox-exec.sh 在 set -u 下读 PIW_MODEL 直接退出,所有非 pi 臂的闸都红。
test("非 pi 臂的闸经 wrapper 起时带着 run 的环境(PIW_MODEL · PIW_EXECUTOR · OMD_LITE_OUT)", () => {
  const { home, env, repo } = fixture(["agy"]);
  delete env.PIW_MODEL; delete env.PIW_EXECUTOR; delete env.OMD_LITE_OUT;
  const gate = `test "$PIW_MODEL" = ${MODEL} && test "$PIW_EXECUTOR" = agy && test -n "$OMD_LITE_OUT"`;
  const r = spawnSync("node", [BIN, ...base(repo, "agy", "--gate", gate, "--max-rounds", "1", "--name", "gateenv", "--exec-wrapper", WRAPPER)], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(result(home, "gateenv").gates, "pass");
});

test("红闸预检经 wrapper 起时也带 PIW_MODEL:缺了会假红放行", () => {
  const { home, env, repo } = fixture(["agy"]);
  delete env.PIW_MODEL;
  const r = spawnSync("node", [BIN, ...base(repo, "agy", "--gate", "true", "--max-rounds", "1", "--red-check", 'test -n "$PIW_MODEL"', "--name", "redenv", "--exec-wrapper", WRAPPER)], { encoding: "utf8", env });
  assert.notEqual(r.status, 0, "PIW_MODEL 在,red-check 在 base 上就绿,应拒绝开跑");
  assert.match(r.stderr, /红闸预检没红/);
});
