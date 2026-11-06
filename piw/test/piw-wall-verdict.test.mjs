// node --test test/piw-wall-verdict.test.mjs —— 墙钟闸在跑时暂停;被停下时从 gate-round 日志恢复闸结论(26.10 token 产出率 H1 · H2)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { wallClock, verdictFromGateLogs } = require("../bin/piw");

test("wallClock:闸在跑的那段不计;只算执行体时间到墙钟才算用满", () => {
  let gate = false;
  const c = wallClock(100, () => gate, 0);
  assert.equal(c.tick(60e3), false); // 60 s
  gate = true;
  assert.equal(c.tick(600e3), false); // 闸跑了 540 s,不计
  gate = false;
  assert.equal(c.tick(630e3), false); // 90 s
  assert.equal(c.tick(640e3), true); // 100 s
  assert.equal(Math.round(c.active()), 100);
});

test("verdictFromGateLogs:取最后一轮;有红 → fail 带首个红的命令;全过 → pass;没有日志 → null", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vg-"));
  assert.equal(verdictFromGateLogs(d), null);
  fs.writeFileSync(path.join(d, "gate-round-1.log"), "### $ a\n### exit=0\nok\n\n### $ b\n### exit=1\nred\n");
  fs.writeFileSync(path.join(d, "gate-round-2.log"), "### $ a\n### exit=2 (timeout)\nslow\n");
  assert.deepEqual(verdictFromGateLogs(d), { gates: "fail", round: 2, failed_gate: "a", exit: "2" });
  fs.writeFileSync(path.join(d, "gate-round-10.log"), "### $ a\n### exit=0\n");
  assert.deepEqual(verdictFromGateLogs(d), { gates: "pass", round: 10 });
});
