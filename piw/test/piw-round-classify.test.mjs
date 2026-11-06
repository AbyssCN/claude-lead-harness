// node --test test/piw-round-classify.test.mjs —— 白跑守卫的可选钩子(MyApp lead myapp-66 1.11):闸红的一轮先交 PIW_ROUND_CLASSIFY 分类,
// 判成 base-red / brief-red 就不回灌、直接结束,result.json 带 failureClass;不给环境变量 = 今天的行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { default: ext } = await import("../ext/gate-loop.ts");
const { parseVerdict, classOfResult, WASTED_CLASSES } = await import("../lib/round-classify.mjs");

function harness(env) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(PIW_|OMD_LITE_)/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  const h = {}, sent = [];
  ext({ on: (n, f) => { h[n] = f; }, sendUserMessage: (m) => sent.push(m) });
  const restore = () => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); };
  return { h, sent, restore };
}
const end = { messages: [{ role: "assistant", stopReason: "stop" }] };
const result = (out) => JSON.parse(fs.readFileSync(path.join(out, "result.json"), "utf8"));

test("不给 PIW_ROUND_CLASSIFY:闸红照常回灌,不写 result.json", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const { h, sent, restore } = harness({ PIW_GATES: '["false"]', PIW_OUT: out, PIW_MAX_ROUNDS: "4" });
  try {
    await h.agent_end(end, { cwd: out });
    assert.equal(sent.length, 1);
    assert.equal(fs.existsSync(path.join(out, "result.json")), false);
  } finally { restore(); fs.rmSync(out, { recursive: true }); }
});

test("分类说 base-red 要停:不回灌,result.json gates=fail + failureClass + wasted;钩子拿到轮次与这一轮的闸日志", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const seen = path.join(out, "seen");
  const cls = `printf '%s %s\\n' "$PIW_ROUND" "$(test -f "$PIW_ROUND_LOG" && echo log)" > ${seen}; echo noise; echo '{"stop":true,"failureClass":"base-red","why":"gate-census.test.mjs 在基线上也红"}'`;
  const { h, sent, restore } = harness({ PIW_GATES: '["false"]', PIW_OUT: out, PIW_MAX_ROUNDS: "4", PIW_ROUND_CLASSIFY: cls });
  try {
    await h.agent_end(end, { cwd: out });
    assert.equal(sent.length, 0);
    const r = result(out);
    assert.equal(r.gates, "fail");
    assert.equal(r.round, 1);
    assert.equal(r.failureClass, "base-red");
    assert.deepEqual(r.wasted, { class: "base-red", why: "gate-census.test.mjs 在基线上也红", round: 1 });
    assert.equal(fs.readFileSync(seen, "utf8").trim(), "1 log");
    assert.match(fs.readFileSync(path.join(out, "round-classify-1.log"), "utf8"), /noise/);
  } finally { restore(); fs.rmSync(out, { recursive: true }); }
});

test("分类说不停 / 输出不是判词 / 退非 0 / 类名不在白名单:都照常回灌", async () => {
  for (const cls of [`echo '{"stop":false}'`, "echo 乱码", "exit 3", `echo '{"stop":true,"failureClass":"gate","why":"x"}'`]) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
    const { h, sent, restore } = harness({ PIW_GATES: '["false"]', PIW_OUT: out, PIW_MAX_ROUNDS: "4", PIW_ROUND_CLASSIFY: cls });
    try {
      await h.agent_end(end, { cwd: out });
      assert.equal(sent.length, 1, cls);
      assert.equal(fs.existsSync(path.join(out, "result.json")), false, cls);
    } finally { restore(); fs.rmSync(out, { recursive: true }); }
  }
});

test("闸绿不调分类", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const probe = path.join(out, "called");
  const { h, restore } = harness({ PIW_GATES: '["true"]', PIW_OUT: out, PIW_ROUND_CLASSIFY: `touch ${probe}` });
  try {
    await h.agent_end(end, { cwd: out });
    assert.equal(result(out).gates, "pass");
    assert.equal(fs.existsSync(probe), false);
  } finally { restore(); fs.rmSync(out, { recursive: true }); }
});

test("parseVerdict 只认最后一行 JSON、stop 为 true 且类名在白名单", () => {
  assert.deepEqual(parseVerdict('x\n{"stop":true,"failureClass":"brief-red","why":"w"}\n'), { failureClass: "brief-red", why: "w" });
  assert.equal(parseVerdict('{"stop":true,"failureClass":"brief-red","why":"w"}\nlater'), null);
  assert.equal(parseVerdict('{"stop":true,"failureClass":"quota"}'), null);
  assert.equal(parseVerdict(""), null);
  assert.deepEqual([...WASTED_CLASSES].sort(), ["base-red", "brief-red"]);
});

test("classOfResult:result.json 带白名单里的 failureClass 就保留,否则 gates=fail 记 gate", () => {
  assert.equal(classOfResult({ gates: "fail", failureClass: "base-red" }), "base-red");
  assert.equal(classOfResult({ gates: "fail", failureClass: "brief-red" }), "brief-red");
  assert.equal(classOfResult({ gates: "fail", failureClass: "whatever" }), "gate");
  assert.equal(classOfResult({ gates: "fail" }), "gate");
  assert.equal(classOfResult({ gates: "pass" }), null);
  assert.equal(classOfResult({ gates: "not-run" }), undefined);
});

test("同一道闸连红三轮、第三轮分类说停:result.json 照原失败分支带 stuck(sol 审 F2)", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const cls = `[ "$PIW_ROUND" = 3 ] && echo '{"stop":true,"failureClass":"base-red","why":"w"}' || echo '{"stop":false}'`;
  const { h, sent, restore } = harness({ PIW_GATES: '["false"]', PIW_OUT: out, PIW_MAX_ROUNDS: "9", PIW_ROUND_CLASSIFY: cls });
  try {
    for (let i = 0; i < 3; i++) await h.agent_end(end, { cwd: out });
    assert.equal(sent.length, 2);
    const r = result(out);
    assert.equal(r.round, 3);
    assert.equal(r.stuck, "stuck-gate");
    assert.equal(r.failureClass, "base-red");
  } finally { restore(); fs.rmSync(out, { recursive: true }); }
});

test("分类期间心跳周期按 PIW_IDLE 定:idle 4 s 时每秒 touch,分类跑 2.5 s 期间心跳更新过(sol 审 F1)", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const stamp = path.join(out, "classify-start");
  const cls = `date +%s%N > ${stamp}; sleep 2.5; echo '{"stop":false}'`;
  const { h, restore } = harness({ PIW_GATES: '["false"]', PIW_OUT: out, PIW_MAX_ROUNDS: "4", PIW_IDLE: "4", PIW_ROUND_CLASSIFY: cls });
  try {
    await h.agent_end(end, { cwd: out });
    const started = Number(fs.readFileSync(stamp, "utf8").trim()) / 1e6;
    const beat = fs.statSync(path.join(out, "gate-heartbeat")).mtimeMs;
    assert.ok(beat > started + 900, `心跳 ${beat - started} ms 后才更新`);
  } finally { restore(); fs.rmSync(out, { recursive: true }); }
});

test("亚秒 idle(0.4 s)时心跳周期跟着缩到 100 ms,分类跑 0.6 s 期间心跳更新过(sol 审第二轮)", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const stamp = path.join(out, "classify-start");
  const cls = `date +%s%N > ${stamp}; sleep 0.6; echo '{"stop":false}'`;
  const { h, restore } = harness({ PIW_GATES: '["false"]', PIW_OUT: out, PIW_MAX_ROUNDS: "4", PIW_IDLE: "0.4", PIW_ROUND_CLASSIFY: cls });
  try {
    await h.agent_end(end, { cwd: out });
    const started = Number(fs.readFileSync(stamp, "utf8").trim()) / 1e6;
    const beat = fs.statSync(path.join(out, "gate-heartbeat")).mtimeMs;
    assert.ok(beat > started + 300, `心跳 ${beat - started} ms 后才更新`);
  } finally { restore(); fs.rmSync(out, { recursive: true }); }
});
