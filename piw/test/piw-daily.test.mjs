// node --test test/piw-daily.test.mjs —— piw daily:价钱按北京高峰 / 空闲折算;continuity 实数段与重建段分开数。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { report, rowCny, isPeak } = require("../lib/report.js");

test("isPeak:北京周二 10 点高峰、13 点空闲、周六 10 点空闲", () => {
  const bj = (iso) => Date.parse(iso + "+08:00") / 1000;
  assert.equal(isPeak(bj("2026-10-20T10:00:00")), true);
  assert.equal(isPeak(bj("2026-10-20T13:00:00")), false);
  assert.equal(isPeak(bj("2026-10-24T10:00:00")), false);
});

test("rowCny:flash 高峰 1M 命中 + 1M 未命中 + 1M 输出 = 0.04 + 2 + 8;空闲减半;非 deepseek 为 0", () => {
  const at = Date.parse("2026-10-20T10:00:00+08:00") / 1000;
  const t = { cacheRead: 1e6, input: 1e6, output: 1e6 };
  assert.equal(rowCny({ at, model: "deepseek/deepseek-flash", tokens: t }).toFixed(2), "10.04");
  assert.equal(rowCny({ at: at + 3 * 3600, model: "deepseek/deepseek-flash", tokens: t }).toFixed(2), "5.02");
  assert.equal(rowCny({ at, model: "minimax-cp/M", tokens: t }), 0);
});

test("daily:call 行与 writer 结束行算实数;没有收尾行的调用单独计「调用方被杀」、不计成败(21.10 改口径);降级原因按类归并", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-daily-"));
  const usage = path.join(home, "usage"), cont = path.join(home, "cont");
  fs.mkdirSync(usage); fs.mkdirSync(path.join(cont, "projects"), { recursive: true });
  const day = "2026-10-21", at = Math.floor(Date.parse("2026-10-21T12:00:00") / 1000);
  const rows = [
    { at, label: "call:continuity", arm: "call-start", id: "a" }, { at, label: "call:continuity", arm: "call", id: "a", status: "ok", coord: "minimax-cp/M:xhigh" },
    { at, label: "call:continuity", arm: "call-start", id: "b" }, { at, label: "call:continuity", arm: "call", id: "b", status: "ok", coord: "deepseek/deepseek-flash" },
    { at, label: "call:continuity", arm: "call-start", id: "c" }, { at, label: "call:continuity", arm: "call", id: "c", status: "timeout", coord: null },
    { at, label: "call:continuity", arm: "call-start", id: "d" },
    { at, label: "ask:judge-deepseek", model: "deepseek/deepseek-flash", arm: "ask", tokens: { input: 0, output: 1e6, cacheRead: 0 } },
  ];
  fs.writeFileSync(path.join(usage, `${day}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const ts = new Date(at * 1000).toISOString();
  fs.writeFileSync(path.join(cont, "writer.log"), [
    `${ts} INFO writer 结束 {"degraded":false,"reason":null}`,
    `${ts} INFO writer 结束 {"degraded":true,"reason":"piw ask 超时(360000ms)"}`,
    `${ts} INFO writer 结束 {"degraded":true,"reason":"验真闸两次未过"}`,
    `${ts} INFO writer 结束 {"degraded":false,"reason":null}`,
  ].join("\n") + "\n");
  const r = report({ day, env: { PIW_USAGE_DIR: usage, CONTINUITY_DATA_DIR: cont } });
  const c = r.continuity;
  assert.deepEqual([c.calls, c.mmOk, c.dsOk, c.killed], [3, 1, 1, 1]);
  assert.deepEqual(c.failures, { timeout: 1 });
  assert.deepEqual([c.runs, c.degraded], [4, 2]);
  assert.deepEqual(c.reasons, { "piw ask 超时": 1, "验真闸两次未过": 1 });
  assert.ok(r.deepseek["ask:judge-deepseek"].cny > 0);
  assert.match(r.text, /MiniMax 一臂成功 \| 1\(33\.3%\)/);
  assert.match(r.text, /调用方被杀\(结果未知,不计成败\) \| 1 /);
});

// ── 余额对账 · 连续 3 天判据(21.10)────────────────────────────────────────
const { reconcile } = require("../lib/report.js");
const T = (iso) => Math.floor(Date.parse(iso) / 1000); // 本地时间
const dsRow = (at, label, out) => ({ at, label, model: "deepseek/deepseek-flash", arm: "ask", tokens: { input: 0, output: out, cacheRead: 0 } });
const offPeak = (cny) => cny / 4 * 1e6; // 空闲时段输出 4 元 / M → 这么多输出 token 折 cny 元

test("reconcile:实扣与台账差 ≤ 5% 不标红;Search / Fetch 按次 0.005 元", () => {
  // 周六本地 12 点:北京时间不在工作日高峰,按空闲价
  const day = "2026-10-24";
  const snaps = [{ at: T("2026-10-24T00:00:05"), cny: 10 }, { at: T("2026-10-24T12:00:00"), cny: 9 }, { at: T("2026-10-25T00:00:04"), cny: 8.99 }];
  const rows = [dsRow(T("2026-10-24T06:00:00"), "ask:judge-deepseek", offPeak(0.98)),
    { at: T("2026-10-24T13:00:00"), label: "web:search", model: "deepseek/search", arm: "tool", calls: 2 }];
  const rc = reconcile(day, snaps, rows);
  assert.equal(rc.actual.toFixed(2), "1.01");
  assert.equal(rc.ledger.toFixed(2), "0.99");
  assert.equal(rc.red, false);
  assert.equal(rc.headMissing || rc.unfinished, false);
});

test("reconcile:差 > 5% 标红,差额时段指到调用方;台账空的时段 = 台账外;充值段剔除", () => {
  const day = "2026-10-24";
  const snaps = [{ at: T("2026-10-24T00:00:00"), cny: 10 }, { at: T("2026-10-24T01:00:00"), cny: 9 },
    { at: T("2026-10-24T02:00:00"), cny: 59 }, { at: T("2026-10-24T03:00:00"), cny: 58 }, { at: T("2026-10-25T00:00:00"), cny: 58 }];
  const rows = [dsRow(T("2026-10-24T00:30:00"), "ask:judge-deepseek", offPeak(1)), dsRow(T("2026-10-24T01:30:00"), "memory-hub:distill", offPeak(1))];
  const rc = reconcile(day, snaps, rows);
  assert.equal(rc.topups.length, 1);
  assert.equal(rc.actual.toFixed(2), "2.00");
  assert.equal(rc.ledger.toFixed(2), "1.00");
  assert.equal(rc.red, true);
  const iv = rc.intervals.find((i) => i.gap > 0.5);
  assert.deepEqual(Object.keys(iv.by), []); // 02–03 点扣了 1 元,台账一行没有
});

test("reconcile:没有次日 0 点快照 = 未完;开头晚于 0:30 = 缺头", () => {
  const rc = reconcile("2026-10-24", [{ at: T("2026-10-24T02:00:00"), cny: 5 }, { at: T("2026-10-24T03:00:00"), cny: 4 }], []);
  assert.equal(rc.headMissing, true);
  assert.equal(rc.unfinished, true);
});

test("daily:连续 3 天 —— 每天一律 ≤ 5 元(没有 10 元例外);账户余额不足的日子判未达标", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-roll-"));
  const env = { PIW_USAGE_DIR: path.join(home, "u"), PIW_BALANCE_DIR: path.join(home, "b"), CONTINUITY_DATA_DIR: path.join(home, "c") };
  for (const d of Object.values(env)) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(env.CONTINUITY_DATA_DIR, "projects"));
  const put = (dir, day, rows) => fs.appendFileSync(path.join(dir, `${day}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const days = ["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  const spend = { "2026-10-22": 4, "2026-10-23": 8, "2026-10-24": 1 };
  let bal = 100;
  for (const d of days) {
    put(env.PIW_BALANCE_DIR, d, [{ at: T(`${d}T00:00:01`), cny: bal, available: d !== "2026-10-25" || bal > 0 }]);
    if (!spend[d]) continue;
    bal -= spend[d];
    const at = T(`${d}T12:00:00`);
    const cont = [];
    for (let i = 0; i < 10; i++) cont.push({ at, label: "call:continuity", arm: "call-start", id: `${d}${i}` }, { at, label: "call:continuity", arm: "call", id: `${d}${i}`, status: "ok", coord: "minimax-cp/M:xhigh" });
    cont.push(dsRow(T(`${d}T21:00:00`), "ask:judge-deepseek", offPeak(spend[d]))); // 本地 21 点 = 北京次日 2 点,空闲价
    put(env.PIW_USAGE_DIR, d, cont);
    const wl = Array.from({ length: 10 }, () => `${new Date(at * 1000).toISOString()} info writer 结束 {"degraded":false}`).join("\n") + "\n";
    fs.appendFileSync(path.join(env.CONTINUITY_DATA_DIR, "writer.log"), wl);
  }
  // 23.10 花了 8 元:超 5 元就未达标,台账里有 Codex 冷却行也不放宽
  put(env.PIW_USAGE_DIR, "2026-10-23", [{ at: T("2026-10-23T09:00:00"), label: "cooldown", model: "openai-codex/gpt-6.1-sol", arm: "cooldown", reason: "You've hit your usage limit" }]);
  const r1 = report({ day: "2026-10-24", env });
  assert.equal(r1.rolling.ok, false);
  assert.equal(r1.rolling.days.map((d) => d.verdict.ok).join(), "true,false,true", r1.text);
  assert.match(r1.text, /DeepSeek 8\.00 元 > 5 元/);
  // 余额 ≤ 0 的快照 → 账户不可用 → 未达标
  put(env.PIW_BALANCE_DIR, "2026-10-24", [{ at: T("2026-10-24T18:00:00"), cny: -0.03, available: false }, { at: T("2026-10-24T19:00:00"), cny: bal }]);
  assert.match(report({ day: "2026-10-24", env }).text, /账户余额不足/);
});
