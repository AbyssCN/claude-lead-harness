// node --test test/piw-idle.test.mjs —— 看门狗:执行体一条工具调用不返回、stdout 再没动静,超过 --idle 秒就杀,
// 不等墙钟(18.10 f2a 两次把 3600 s 耗在 mkdir /proc/none 上,result 只有 pi_exit 124,被误判成供应商卡住)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "piw");

test("工具调用挂死:--idle 2 秒内被杀,result.json failureClass=hang 并记下那条命令", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-idle-"));
  const repo = path.join(home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) spawnSync("git", ["-C", repo, ...a]);
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  spawnSync("git", ["-C", repo, "add", "."]); spawnSync("git", ["-C", repo, "commit", "-qm", "init"]);
  const envFile = path.join(home, "env");
  fs.writeFileSync(envFile, "DEEPSEEK_API_KEY=fake\n");
  const env = { ...process.env, HOME: home, PIW_PI_BIN: path.resolve(import.meta.dirname, "fixtures", "pi-stub.mjs"),
    STUB_PLAN: JSON.stringify({ "deepseek-hang": "hang" }), OMD_LITE_ENV_FILE: envFile, PIW_USAGE_DIR: path.join(home, "usage"),
    FACTORY_EVENTS: path.join(home, "events.jsonl") };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "PIW_ENV_FILE", "PIW_ENV_KEEP", "CLAUDE_CODE_SESSION_ID", "PIW_IDLE"]) delete env[k];
  const t0 = Date.now();
  const r = spawnSync("node", [BIN, "run", "--repo", repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal",
    "--model", "deepseek/deepseek-hang", "--fallback-model", "none", "--gate", "true", "--wall", "60", "--idle", "2", "--name", "hang"],
    { encoding: "utf8", env, timeout: 45_000 });
  const secs = (Date.now() - t0) / 1000;
  assert.ok(secs < 20, `应在空闲阈值附近被杀,实际 ${secs.toFixed(1)} s(stderr 末:${(r.stderr || "").slice(-300)})`);
  const res = JSON.parse(fs.readFileSync(path.join(home, ".omd-lite", "runs", "hang", "result.json"), "utf8"));
  assert.equal(res.gates, "not-run");
  assert.equal(res.failureClass, "hang");
  assert.equal(res.hang?.command, "node -e 'hang forever'");
  assert.ok(res.hang.idle_s >= 2);
});
