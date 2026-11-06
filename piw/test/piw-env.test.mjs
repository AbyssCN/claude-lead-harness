// node --test test/piw-env.test.mjs —— worker 环境收窄(Q2,15.10):执行体的 bash 继承 pi 的环境,
// 主机 shell 里的密钥(RESEND_API_KEY 等)与带生产域名的变量不许跟进去;模型供应商的那一个 key 照旧单独注入。
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

test("workerEnv:按名字去掉密钥类变量,按值去掉带生产域名的变量,其余照留", () => {
  const out = piw.workerEnv({
    PATH: "/bin", HOME: "/h", PIW_OUT: "/o", OMD_LITE_BASE: "abc", LANG: "C.UTF-8",
    GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file",
    RESEND_API_KEY: "r", TAVILY_API_KEY: "t", CLAUDE_CODE_MESSAGING_TOKEN: "m", DB_PASSWORD: "p",
    STRIPE_WEBHOOK: "w", SUPABASE_URL: "https://x", DATABASE_URL: "postgres://x",
    SITE: "https://example-app.fi/fi", API: "https://prodref0000000000000.supabase.co",
  });
  assert.deepEqual(Object.keys(out).sort(),
    ["GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND", "HOME", "LANG", "OMD_LITE_BASE", "PATH", "PIW_OUT"]);
});

test("workerEnv:PIW_ENV_KEEP 点名留下的照留(逗号分隔),不点名的照去", () => {
  const out = piw.workerEnv({ PATH: "/bin", TAVILY_API_KEY: "t", RESEND_API_KEY: "r", PIW_ENV_KEEP: "TAVILY_API_KEY" });
  assert.equal(out.TAVILY_API_KEY, "t");
  assert.equal(out.RESEND_API_KEY, undefined);
});

// 19.10:执行体带着 HERDR_PANE_ID 时,codex / agy 的 SessionStart hook 会把这次批跑的会话报给 herdr,
// herdr 重启后在 piw 跑的那个 pane 里起交互式 `codex resume <id>`,piw 的闸循环就接不回来了
test("workerEnv:HERDR_* 一律不进执行体", () => {
  const out = piw.workerEnv({ PATH: "/bin", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p3", HERDR_SOCKET_PATH: "/s", HERDR_TAB_ID: "w1:t1",
    HERDR_WORKSPACE_ID: "w1", HERDR_BIN_PATH: "/b", TERM_PROGRAM: "herdr" });
  assert.deepEqual(Object.keys(out).sort(), ["PATH", "TERM_PROGRAM"]);
});

function sh(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// 判据(Q2):抽查一个 run 的 worker 环境,grep 不到生产 URL,也没有主机 shell 里的密钥
test("run:pi 看到的环境里没有 RESEND_API_KEY、没有带生产域名的变量;PIW_OUT 照有", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-env-"));
  const log = path.join(home, "stub.log");
  const envFile = path.join(home, "env");
  fs.writeFileSync(envFile, "DEEPSEEK_API_KEY=fake\n");
  const env = {
    ...process.env, HOME: home, PIW_PI_BIN: STUB, STUB_PLAN: "{}", STUB_LOG: log, OMD_LITE_ENV_FILE: envFile,
    PIW_USAGE_DIR: path.join(home, "usage"),
    RESEND_API_KEY: "re_fake", NEXT_PUBLIC_SUPABASE_URL: "https://prodref0000000000000.supabase.co",
  };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "PIW_ENV_FILE", "PIW_ENV_KEEP", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  const repo = path.join(home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const r = spawnSync("node", [BIN, "run", "--repo", repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal",
    "--gate", "true", "--name", "envcheck", "--role", "worker"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.ok(!c.envKeys.includes("RESEND_API_KEY"), "RESEND_API_KEY 跟进了 worker");
    assert.ok(!c.envKeys.includes("NEXT_PUBLIC_SUPABASE_URL"), "带生产域名的变量跟进了 worker");
    assert.equal(c.envProd, false, "worker 环境里 grep 得到生产域名");
    assert.ok(c.envKeys.includes("PIW_OUT"));
    assert.ok(c.envKeys.includes("STUB_LOG"), "非密钥的变量照留");
    assert.ok(c.envKeys.includes("PI_OFFLINE"), "pi 要带 PI_OFFLINE:沙箱里看不到 ~/.pi/agent/npm,不带就每次起片都去 npm 重装扩展");
  }
});
