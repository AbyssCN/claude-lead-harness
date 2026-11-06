// node --test test/piw-rename.test.mjs —— S11 改名兼容层:bin/omd-lite 软链、环境变量双读(PIW_X ?? OMD_LITE_X)、OMD_LITE_OUT 继续写出、判活匹配两个名字。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN_DIR = path.resolve(import.meta.dirname, "..", "bin");
const PIW = path.join(BIN_DIR, "piw");
const LEGACY = path.join(BIN_DIR, "omd-lite");
const STUB = path.resolve(import.meta.dirname, "fixtures", "pi-stub.mjs");

function sh(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-rename-"));
  const env = { ...process.env, HOME: home, PIW_PI_BIN: STUB, STUB_LOG: path.join(home, "stub.log") };
  for (const k of Object.keys(env)) if (/^(PIW_(?!PI_BIN)|OMD_LITE_)/.test(k)) delete env[k];
  delete env.CLAUDE_CODE_SESSION_ID;
  const repo = path.join(home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  fs.mkdirSync(path.join(repo, "docs", "research"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "research", "a.md"), "a\n");
  fs.mkdirSync(path.join(repo, "docs", "other"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "other", "b.md"), "b\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const cli = (bin, args, extra = {}) => spawnSync("node", [bin, ...args], { encoding: "utf8", env: { ...env, ...extra } });
  return { home, env, repo, cli };
}

test("bin/omd-lite 是指向 piw 的软链,realpath 落在 bin/piw", () => {
  assert.ok(fs.lstatSync(LEGACY).isSymbolicLink());
  assert.equal(fs.readlinkSync(LEGACY), "piw");
  assert.equal(fs.realpathSync(LEGACY), fs.realpathSync(PIW));
  assert.match(fs.realpathSync(LEGACY), /bin\/piw$/);
});

test("两个入口行为一致:用法文本相同,旧名走软链也能解析 ../lib", () => {
  const w = world();
  const a = w.cli(PIW, ["--help"]);
  const b = w.cli(LEGACY, ["--help"]);
  assert.equal(a.status, b.status);
  assert.equal(a.stdout + a.stderr, b.stdout + b.stderr);
  assert.match(a.stdout + a.stderr, /piw run --repo/);
  const d = w.cli(LEGACY, ["ask", "--role", "worker", "--dry-run"]);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /chain/);
});

test("ENV_FILE 双读:只有旧名 → 用旧名;两个都有 → PIW_ENV_FILE 优先", () => {
  const w = world();
  const spec = path.join(w.home, "s.md");
  fs.writeFileSync(spec, "x");
  const dry = (extra) => w.cli(PIW, ["run", "--role", "worker", "--dry-run", "--spec", spec], extra).stdout;
  assert.match(dry({ OMD_LITE_ENV_FILE: "/tmp/old.env" }), /← \/tmp\/old\.env/);
  assert.match(dry({ PIW_ENV_FILE: "/tmp/new.env" }), /← \/tmp\/new\.env/);
  assert.match(dry({ PIW_ENV_FILE: "/tmp/new.env", OMD_LITE_ENV_FILE: "/tmp/old.env" }), /← \/tmp\/new\.env/);
  assert.match(dry({}), /← .*provider\.env/, "都没设 → 默认值");
});

test("dry-run 仍打印 OMD_LITE_OUT(同时标出 PIW_OUT)", () => {
  const w = world();
  fs.writeFileSync(path.join(w.home, "s.md"), "x");
  const out = w.cli(PIW, ["run", "--role", "worker", "--dry-run", "--spec", path.join(w.home, "s.md")]).stdout;
  assert.match(out, /PIW_OUT=OMD_LITE_OUT=/);
});

test("SPARSE_EXCLUDE 双读:新名优先,旧名兜底", () => {
  const w = world();
  const plan = (extra) => w.cli(PIW, ["sparse-plan", "--repo", w.repo, "--base", "main", "--spec", "spec.md"], extra);
  const base = plan({});
  assert.equal(base.status, 0, base.stderr);
  const legacy = plan({ OMD_LITE_SPARSE_EXCLUDE: "docs/other" });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout + legacy.stderr, /docs\/other/);
  assert.doesNotMatch(legacy.stdout + legacy.stderr, /docs\/research/);
  const both = plan({ PIW_SPARSE_EXCLUDE: "docs/research", OMD_LITE_SPARSE_EXCLUDE: "docs/other" });
  assert.match(both.stdout + both.stderr, /docs\/research/);
  assert.doesNotMatch(both.stdout + both.stderr, /docs\/other/);
});

test("run 给子进程的环境:PIW_* 与 OMD_LITE_* 两套都有,OMD_LITE_OUT 必须在且等于 PIW_OUT", () => {
  const w = world();
  const dump = path.join(w.home, "env.json");
  const stub = path.join(w.home, "pi-env.mjs");
  fs.writeFileSync(stub, `#!/usr/bin/env node
import fs from "node:fs";
const pick = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PIW_(GATES|MAX_ROUNDS|BASE|ALLOWED|OUT)|OMD_LITE_(GATES|MAX_ROUNDS|BASE|ALLOWED|OUT))$/.test(k)));
fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify(pick));
console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }] }));
`, { mode: 0o755 });
  const envFile = path.join(w.home, "env");
  fs.writeFileSync(envFile, "DEEPSEEK_API_KEY=fake\n");
  fs.writeFileSync(path.join(w.repo, "spec.md"), "# spec\n\n允许改动: a.txt\n");
  sh(w.repo, "commit", "-qam", "spec");
  const r = w.cli(PIW, ["run", "--repo", w.repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal", "--model", "deepseek/deepseek-v4-flash", "--gate", "true", "--name", "env1"], { PIW_PI_BIN: stub, PIW_ENV_FILE: envFile });
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(fs.readFileSync(dump, "utf8"));
  for (const k of ["GATES", "MAX_ROUNDS", "BASE", "OUT"]) {
    assert.ok(e[`PIW_${k}`] !== undefined, `缺 PIW_${k}`);
    assert.equal(e[`OMD_LITE_${k}`], e[`PIW_${k}`], `OMD_LITE_${k} 与 PIW_${k} 不一致`);
  }
  assert.equal(e.OMD_LITE_OUT, path.join(w.home, ".omd-lite", "runs", "env1"));
});

test("gate-loop 扩展:PIW_GATES / OMD_LITE_GATES 任一设了都注册 agent_end;都没设什么也不做", async () => {
  const { default: ext } = await import("../ext/gate-loop.ts");
  const saved = { ...process.env };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "gl-"));
  const registered = (env) => {
    for (const k of Object.keys(process.env)) if (/^(PIW_|OMD_LITE_)/.test(k)) delete process.env[k];
    Object.assign(process.env, env);
    const events = [];
    ext({ on: (n) => events.push(n), sendUserMessage() {} });
    return events;
  };
  try {
    assert.deepEqual(registered({}), []);
    assert.deepEqual(registered({ PIW_GATES: '["true"]', PIW_OUT: out }), ["tool_call", "turn_end", "agent_end"]);
    assert.deepEqual(registered({ OMD_LITE_GATES: '["true"]', OMD_LITE_OUT: out }), ["tool_call", "turn_end", "agent_end"]);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(out, { recursive: true });
  }
});
