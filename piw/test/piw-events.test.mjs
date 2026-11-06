// node --test test/piw-events.test.mjs —— F2 事件流:piw 起片 / 每轮执行体返回 / 每轮闸判完各写一行事件。
// 执行体与闸全用替身:agy 替身只在第 2 轮提示词(带上轮回灌的「闸未通过」)里把判据文件补出来 → 第 1 轮闸红、第 2 轮闸绿。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "piw");

function sh(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// agy 替身:闸判据 = marker 在不在。替身只在看到上轮的闸红回灌时才补 marker,替 run 造出「第 1 轮红、第 2 轮绿」
function stubAgy(home, marker) {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "agy"), `#!/usr/bin/env node
import fs from "node:fs";
if ((process.argv.at(-1) ?? "").includes("闸未通过")) fs.writeFileSync(${JSON.stringify(marker)}, "ok\\n");
`, { mode: 0o755 });
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-events-"));
  const marker = path.join(home, "gate-marker");
  stubAgy(home, marker);
  const envFile = path.join(home, "env");
  fs.writeFileSync(envFile, "DEEPSEEK_API_KEY=fake\n");
  const env = { ...process.env, HOME: home, PATH: `${path.join(home, "bin")}:${process.env.PATH}`,
    PIW_PI_BIN: path.resolve(import.meta.dirname, "fixtures", "pi-stub.mjs"), STUB_PLAN: "{}", STUB_LOG: path.join(home, "stub.log"),
    OMD_LITE_ENV_FILE: envFile, PIW_USAGE_DIR: path.join(home, "usage"), FACTORY_EVENTS: path.join(home, "events.jsonl") };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "PIW_ENV_FILE", "PIW_ENV_KEEP", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  const repo = path.join(home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  return { home, env, repo, marker };
}
const base = (repo, ...extra) => ["run", "--repo", repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal",
  "--executor", "agy", "--model", "default", "--fallback-model", "none", ...extra];
const runDir = (home, name) => path.join(home, ".omd-lite", "runs", name);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const events = (home, run) => fs.readFileSync(path.join(home, "events.jsonl"), "utf8").trim().split("\n")
  .map((l) => JSON.parse(l)).filter((e) => e.run === run);

test("第 1 轮闸红、第 2 轮闸绿:1 行 launch + 2 行 round + 2 行 gate(gate 的 status/round 依次 fail/1 · pass/2)", () => {
  const { home, env, repo, marker } = fixture();
  const r = spawnSync("node", [BIN, ...base(repo, "--gate", `test -f ${marker}`, "--max-rounds", "2", "--name", "ev")], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const res = readJson(path.join(runDir(home, "ev"), "result.json"));
  assert.equal(res.gates, "pass", "替身 run 应第 2 轮闸绿");
  assert.equal(res.round, 2);

  const ev = events(home, "ev");
  assert.deepEqual(ev.map((e) => [e.phase, e.round ?? null, e.status]),
    [["launch", null, "start"], ["round", 1, "exit:0"], ["gate", 1, "fail"], ["round", 2, "exit:0"], ["gate", 2, "pass"]]);
  const [launch] = ev;
  assert.equal(launch.repo, repo, "repo = meta.repo(绝对路径)");
  assert.equal(launch.actor, "agy", "actor = meta.executor");
  assert.equal(launch.evidence, path.join(runDir(home, "ev"), "meta.json"));
  assert.equal(launch.model, "default");
  assert.equal(launch.spec, "spec.md");
  for (const e of ev) assert.match(e.ts, /^\d{4}-\d\d-\d\dT.*Z$/, `ts 不是 ISO 时间:${e.ts}`);
  const [gate1, gate2] = ev.filter((e) => e.phase === "gate");
  assert.equal(gate1.failed_gate, `test -f ${marker}`, "fail 行带 failed_gate");
  assert.equal(gate1.evidence, path.join(runDir(home, "ev"), "gate-round-1.log"));
  assert.equal(gate2.failed_gate, undefined, "pass 行不带 failed_gate");
  assert.equal(gate2.evidence, path.join(runDir(home, "ev"), "gate-round-2.log"));
  assert.ok(fs.existsSync(gate2.evidence), "gate 事件的 evidence 指向真落盘的闸日志");
});

test("每行都有七键 ts repo run phase status actor evidence(消费方按固定形状读)", () => {
  const { home, env, repo, marker } = fixture();
  const r = spawnSync("node", [BIN, ...base(repo, "--gate", `test -f ${marker}`, "--max-rounds", "2", "--name", "keys")], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const ev = events(home, "keys");
  assert.equal(ev.length, 5);
  for (const e of ev) {
    for (const k of ["ts", "repo", "run", "phase", "status", "actor", "evidence"]) assert.ok(k in e, `${e.phase} 行缺键 ${k}`);
    assert.equal(e.run, "keys");
    assert.equal(e.actor, "agy");
  }
});

test("事件写不进去(FACTORY_EVENTS 指到写不了的地方):run 照常跑完、result.json 照写、退出码不变", () => {
  const { home, env, repo } = fixture();
  // 父路径是一个普通文件 → appendEvent 的 mkdir(…, recursive) 立刻 ENOTDIR。
  // 任务书原写的 /proc/none/x 在本机不行:node 对 procfs 路径做 recursive mkdir 会挂住不返回(见报告),不是快速失败。
  const notdir = path.join(home, "not-a-dir");
  fs.writeFileSync(notdir, "");
  env.FACTORY_EVENTS = path.join(notdir, "events.jsonl");
  const r = spawnSync("node", [BIN, ...base(repo, "--gate", "true", "--max-rounds", "1", "--name", "nowhere")], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /factory events: 写不进 .*not-a-dir\/events\.jsonl/, "写失败要留一行证据,不能静默");
  const res = readJson(path.join(runDir(home, "nowhere"), "result.json"));
  assert.equal(res.gates, "pass");
  assert.equal(res.round, 1);
});
