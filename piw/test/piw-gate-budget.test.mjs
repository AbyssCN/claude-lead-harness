// node --test test/piw-gate-budget.test.mjs —— gate-loop 的预算闸、执行片闸拦截、闸在跑标记(26.10 token 产出率,otherapp docs/plan/10.26/token-yield.md H3 · H4 · H1)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { default: ext, runsSliceGate, usageTokens, GATE_RUNNING } = await import("../ext/gate-loop.ts");

test("runsSliceGate:执行片闸的各种写法都认;读 / grep / 提到它不算", () => {
  for (const c of [
    "scripts/dev/gate-slice.sh abc",
    "bash scripts/dev/gate-slice.sh abc > /tmp/g.txt 2>&1",
    "cd /x && timeout 1500 bash scripts/dev/gate-slice.sh da61",
    "cd /x && PIW_GATE=1 timeout 1500 bash scripts/dev/gate-slice.sh da61",
    "env PIW_GATE=1 ./scripts/dev/gate-slice.sh HEAD",
    "true; /home/user/repos/omdl-x/scripts/dev/gate-slice.sh HEAD",
  ]) assert.equal(runsSliceGate(c), true, c);
  for (const c of [
    "sed -n 1,40p scripts/dev/gate-slice.sh",
    "grep -n MIGRATE scripts/dev/gate-slice.sh",
    "cat scripts/dev/gate-slice.sh",
    "bun test apps/api/src/routes/x.test.ts",
  ]) assert.equal(runsSliceGate(c), false, c);
});

test("usageTokens:输入 + 缓存读 + 缓存写 + 输出;缺字段按 0", () => {
  assert.equal(usageTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 10);
  assert.equal(usageTokens({ output: 5 }), 5);
  assert.equal(usageTokens(undefined), 0);
});

function harness(env) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(PIW_|OMD_LITE_)/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  const h = {}, sent = [];
  ext({ on: (n, f) => { h[n] = f; }, sendUserMessage: (m) => sent.push(m) });
  const restore = () => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); };
  return { h, sent, restore };
}
const assistant = (usage, stopReason = "toolUse") => ({ role: "assistant", usage, stopReason });

test("预算闸:累计到上限后拦工具调用(先拦,宽限 5 次后终止);收尾后只跑一次闸,红了不回灌,结果带 budget", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "gb-"));
  const { h, sent, restore } = harness({ PIW_GATES: '["false"]', PIW_OUT: out, PIW_MAX_ROUNDS: "4", PIW_TOKEN_BUDGET: "1000" });
  try {
    assert.equal(await h.tool_call({ toolName: "read", input: { path: "a" } }), undefined);
    await h.turn_end({ message: assistant({ input: 400, cacheRead: 300 }) });
    assert.equal(await h.tool_call({ toolName: "read", input: { path: "a" } }), undefined); // 700 < 1000
    await h.turn_end({ message: assistant({ cacheRead: 250, output: 50 }) }); // 1000:到了
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, "budget.json"), "utf8")).spent, 1000);
    const r1 = await h.tool_call({ toolName: "bash", input: { command: "ls" } });
    assert.equal(r1.block, true);
    assert.equal(r1.terminate, undefined);
    for (let i = 0; i < 4; i++) await h.tool_call({ toolName: "bash", input: { command: "ls" } });
    assert.equal((await h.tool_call({ toolName: "bash", input: { command: "ls" } })).terminate, true);
    // 终止后最后一条是 toolResult(或被拦后 stopReason=aborted):照样跑闸
    await h.agent_end({ messages: [assistant(undefined, "aborted")] }, { cwd: out });
    const res = JSON.parse(fs.readFileSync(path.join(out, "result.json"), "utf8"));
    assert.equal(res.gates, "fail");
    assert.equal(res.round, 1);
    assert.deepEqual(res.budget, { limit: 1000, spent: 1000 });
    assert.equal(sent.length, 0);
    assert.equal(fs.existsSync(path.join(out, GATE_RUNNING)), false);
  } finally { restore(); fs.rmSync(out, { recursive: true }); }
});

test("预算闸不设(或 0)时不拦;闸红照常回灌", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "gb-"));
  const { h, sent, restore } = harness({ PIW_GATES: '["false"]', PIW_OUT: out, PIW_MAX_ROUNDS: "4" });
  try {
    await h.turn_end({ message: assistant({ input: 9e9 }) });
    assert.equal(await h.tool_call({ toolName: "bash", input: { command: "ls" } }), undefined);
    await h.agent_end({ messages: [assistant({}, "stop")] }, { cwd: out });
    assert.equal(sent.length, 1);
    assert.equal(fs.existsSync(path.join(out, "result.json")), false);
  } finally { restore(); fs.rmSync(out, { recursive: true }); }
});

test("执行片闸的 bash 调用被拒(带 PIW_GATE=1 也拒);读片闸脚本放行", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "gb-"));
  const { h, restore } = harness({ PIW_GATES: '["true"]', PIW_OUT: out });
  try {
    const r = await h.tool_call({ toolName: "bash", input: { command: "PIW_GATE=1 timeout 1500 bash scripts/dev/gate-slice.sh abc" } });
    assert.equal(r.block, true);
    assert.match(r.reason, /启动器/);
    assert.equal(await h.tool_call({ toolName: "bash", input: { command: "sed -n 1,20p scripts/dev/gate-slice.sh" } }), undefined);
  } finally { restore(); fs.rmSync(out, { recursive: true }); }
});

test("闸在跑时 run 目录有 gate-running 标记,跑完删掉", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "gb-"));
  const probe = path.join(out, "seen");
  const { h, restore } = harness({ PIW_GATES: JSON.stringify([`test -f ${path.join(out, GATE_RUNNING)} && touch ${probe}`]), PIW_OUT: out });
  try {
    await h.agent_end({ messages: [assistant({}, "stop")] }, { cwd: out });
    assert.equal(fs.existsSync(probe), true);
    assert.equal(fs.existsSync(path.join(out, GATE_RUNNING)), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, "result.json"), "utf8")).gates, "pass");
  } finally { restore(); fs.rmSync(out, { recursive: true }); }
});
