// node --test test/piw-mcode.test.mjs —— mcode 臂:PATH 上放 mcode 替身,不调任何模型。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "piw");

function world(mode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-mcode-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const log = path.join(home, "stub.log");
  // 替身:记 argv;带 --model → 照真 mcode 报「不在模型列表」退 4;ok 模式吐一个事件退 0
  fs.writeFileSync(path.join(bin, "mcode"), `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
if (a.includes("--model")) { process.stderr.write("mcode exec failed: " + a[a.indexOf("--model") + 1] + " is not in this Session's model list, so --effort high cannot be validated.\\n"); process.exit(4); }
if (process.env.MCODE_STUB === "dead") { process.stderr.write("mcode exec failed: No active Session exists for workspace\\n"); process.exit(4); }
console.log(JSON.stringify({ type: "exec.completed", result: { status: "succeeded" } }));
`, { mode: 0o755 });
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo);
  const sh = (...a) => { const r = spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" }); if (r.status) throw new Error(r.stderr); };
  sh("init", "-q", "-b", "main"); sh("config", "user.email", "t@t"); sh("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  sh("add", "."); sh("commit", "-qm", "init");
  fs.mkdirSync(path.join(home, ".config", "piw"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "piw", "config.json"), JSON.stringify({ roles: { worker: { chain: ["minimax-cp/MiniMax-M3.1-Flash:high", "deepseek/deepseek-flash"] } } }));
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, MCODE_STUB: mode };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  const run = (name, extra = []) => spawnSync("node", [BIN, "run", "--repo", repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal",
    "--gate", "false", "--name", name, "--executor", "mcode", "--max-rounds", "3", ...extra], { encoding: "utf8", env });
  const runDir = (name) => path.join(home, ".omd-lite", "runs", name);
  const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { run, runDir, calls };
}

test("mcode + --role:不把角色表的 pi 坐标当 --model 传给 mcode(用 mcode 自带默认)", () => {
  const w = world("ok");
  const r = w.run("m1", ["--role", "worker"]);
  assert.equal(r.status, 0, r.stderr);
  const [argv] = w.calls();
  assert.ok(!argv.includes("--model"), `argv 不该带 --model: ${argv}`);
});

test("mcode 没起来(非 0 退出、没吐事件):不跑闸、不续轮,记 not-run 与执行体报错", () => {
  const w = world("dead");
  const r = w.run("m2", ["--model", "default"]);
  assert.ok(fs.existsSync(path.join(w.runDir("m2"), "result.json")), r.stderr);
  assert.equal(w.calls().length, 1, "只跑一轮,不拿 --continue 去续一个不存在的会话");
  assert.ok(!fs.existsSync(path.join(w.runDir("m2"), "gate-round-1.log")), "空 diff 不跑闸");
  const res = JSON.parse(fs.readFileSync(path.join(w.runDir("m2"), "result.json"), "utf8"));
  assert.equal(res.gates, "not-run");
  const meta = JSON.parse(fs.readFileSync(path.join(w.runDir("m2"), "meta.json"), "utf8"));
  assert.notEqual(meta.failureClass, "gate");
  assert.notEqual(meta.failureClass, null);
});
