// node --test test/piw-yield.test.mjs —— piw yield:MiniMax token 按天 → 闸结论占比与每片闸绿的 token(26.10 owner 目标:没有闸结论 < 10% · 每片闸绿 < 8M)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { scanRun, yieldReport, helsinkiDay } = require("../lib/yield.js");

const at = (iso) => Date.parse(iso) / 1000;
const msg = (u, { provider = "minimax-cp", ts = 1 } = {}) =>
  JSON.stringify({ type: "message_end", message: { role: "assistant", provider, model: "M", timestamp: ts, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...u } } });

function mkRun(runs, label, meta, lines = [], fallback = null) {
  const d = path.join(runs, label);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify(meta));
  fs.writeFileSync(path.join(d, "pi.jsonl"), lines.join("\n") + "\n");
  if (fallback) { fs.mkdirSync(path.join(d, "fallback")); fs.writeFileSync(path.join(d, "fallback", "pi.jsonl"), fallback.join("\n") + "\n"); }
}

test("helsinkiDay:UTC 22:30 在赫尔辛基已是第二天(夏令时 +3)", () => {
  assert.equal(helsinkiDay(at("2026-10-20T22:30:00Z")), "2026-10-21");
  assert.equal(helsinkiDay(at("2026-10-20T20:30:00Z")), "2026-10-20");
});

test("scanRun:只算 MiniMax 的 assistant 用量与压缩调用(压缩归前一条 assistant 的供应商);输入 + 缓存读 + 缓存写 + 输出全价计;fallback 目录并入同一片;坏行跳过", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "piw-yield-"));
  mkRun(runs, "a", { start_epoch: 1, end_epoch: 2, result: { gates: "pass" } }, [
    msg({ input: 100, output: 10, cacheRead: 1000, cacheWrite: 5 }),
    msg({ input: 999, output: 999 }, { provider: "openai-codex" }),
    "{not json",
    JSON.stringify({ type: "message_end", message: { role: "toolResult", usage: { input: 7 } } }),
    JSON.stringify({ type: "compaction_end", result: { usage: { input: 20, output: 3, cacheRead: 0 } } }),
  ], [msg({ input: 1, output: 1, cacheRead: 1 }, { provider: "deepseek" }), msg({ input: 50 })]);
  const r = scanRun(path.join(runs, "a"));
  // 压缩紧跟 openai-codex 那条,不算;MiniMax 的 assistant 两条
  assert.equal(r.tokens, 100 + 10 + 1000 + 5 + 50);
  assert.equal(r.turns, 2);
  assert.equal(r.compactions, 0);
  mkRun(runs, "b", { start_epoch: 1, end_epoch: 2 }, [msg({ input: 1 }), JSON.stringify({ type: "compaction_end", result: { usage: { input: 20, output: 3 } } }), JSON.stringify({ type: "compaction_end", result: null })]);
  assert.deepEqual(scanRun(path.join(runs, "b")), { tokens: 24, turns: 1, compactions: 1, firstTs: 1 });
});

test("yieldReport:闸结论按 meta.result.gates 判;没有 end_epoch 的算在跑、不进比例;按起片日归天;两条判据照算", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "piw-yield-"));
  const d1 = at("2026-10-21T08:00:00Z");
  mkRun(runs, "pass1", { start_epoch: d1, end_epoch: d1 + 60, result: { gates: "pass" } }, [msg({ cacheRead: 4e6, output: 1e6 })]);
  mkRun(runs, "pass2", { start_epoch: d1, end_epoch: d1 + 60, result: { gates: "pass" } }, [msg({ cacheRead: 2e6 })]);
  mkRun(runs, "fail", { start_epoch: d1, end_epoch: d1 + 60, result: { gates: "fail" } }, [msg({ cacheRead: 1e6 })]);
  mkRun(runs, "killed", { start_epoch: d1, end_epoch: d1 + 3600, result: { gates: "not-run", pi_exit: 124 } }, [msg({ cacheRead: 2e6 })]);
  mkRun(runs, "noresult", { start_epoch: d1, end_epoch: d1 + 60, result: null }, [msg({ input: 1e6 })]);
  mkRun(runs, "running", { start_epoch: d1 }, [msg({ input: 5e6 })]);
  mkRun(runs, "running2", { start_epoch: null }, [msg({ input: 5e6 }, { ts: d1 * 1000 })]); // 驱动在跑时 meta 还没写 start_epoch
  mkRun(runs, "nominimax", { start_epoch: d1, end_epoch: d1 + 60, result: { gates: "pass" } }, [msg({ input: 9e6 }, { provider: "openai-codex" })]);
  mkRun(runs, "redkilled", { start_epoch: d1, end_epoch: d1 + 3600, result: { gates: "not-run", pi_exit: 124 } }, [msg({ cacheRead: 1e6 })]);
  fs.writeFileSync(path.join(runs, "redkilled", "gate-round-1.log"), "### $ a\n### exit=1\n");
  mkRun(runs, "old", { start_epoch: at("2026-10-01T08:00:00Z"), end_epoch: 1, result: { gates: "pass" } }, [msg({ input: 1e6 })]);

  const rep = yieldReport({ runs, since: "2026-10-20", until: "2026-10-22" });
  const day = rep.days.find((d) => d.day === "2026-10-21");
  assert.equal(day.runs, 6); // 在跑的、没有 MiniMax 用量的不算
  assert.equal(day.running, 2);
  assert.equal(day.pass, 2);
  assert.equal(day.tokens, 12e6);
  assert.equal(day.noVerdictTokens, 3e6); // not-run 2M + 结果缺失 1M;fail 有结论
  assert.equal(day.perPass, 6e6);
  assert.equal(rep.total.tokens, 12e6);
  assert.equal(rep.days.some((d) => d.day === "2026-10-01"), false);
  assert.equal(rep.total.ok.noVerdict, false); // 25% ≥ 10%
  assert.equal(rep.total.ok.perPass, true); // 6M < 8M
  assert.match(rep.text, /2026-10-21/);
  assert.deepEqual(rep.total.byOutcome.map((o) => o.key), ["pass", "not-run:124", "fail", "fail:闸红后被停", "none"]);
  assert.deepEqual(rep.byRepo.map((r) => [r.day, r.runs]), [["?", 6]]); // fixture 的 meta 没写 repo
});

test("yieldReport:按仓分开;--repo 只看一个仓", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "piw-yield-"));
  const d1 = at("2026-10-21T08:00:00Z");
  mkRun(runs, "b1", { repo: "/r/otherapp", start_epoch: d1, end_epoch: d1 + 1, result: { gates: "not-run", pi_exit: 124 } }, [msg({ cacheRead: 30e6 })]);
  mkRun(runs, "b2", { repo: "/r/otherapp", start_epoch: d1, end_epoch: d1 + 1, result: { gates: "pass" } }, [msg({ cacheRead: 10e6 })]);
  mkRun(runs, "p1", { repo: "/r/myapp", start_epoch: d1, end_epoch: d1 + 1, result: { gates: "pass" } }, [msg({ cacheRead: 3e6 })]);
  const all = yieldReport({ runs, since: "2026-10-21", until: "2026-10-21" });
  assert.deepEqual(all.byRepo.map((r) => [r.day, r.pass, r.perPass]), [["otherapp", 1, 40e6], ["myapp", 1, 3e6]]);
  const bb = yieldReport({ runs, since: "2026-10-21", until: "2026-10-21", repo: "myapp" });
  assert.equal(bb.total.tokens, 3e6);
  assert.match(all.text, /按仓:[\s\S]*otherapp/);
});

test("yieldReport:一片都没过闸的天,每片闸绿记 null(不是 0),判据不成立", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "piw-yield-"));
  const d1 = at("2026-10-21T08:00:00Z");
  mkRun(runs, "killed", { start_epoch: d1, end_epoch: d1 + 3600, result: { gates: "not-run", pi_exit: 124 } }, [msg({ cacheRead: 2e6 })]);
  const rep = yieldReport({ runs, since: "2026-10-21", until: "2026-10-21" });
  assert.equal(rep.days[0].perPass, null);
  assert.equal(rep.total.ok.perPass, false);
});

test("scanRun:续跑目录(resume-<i> · quota-resume-<i>)的用量并入同一片", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "piw-yield-"));
  mkRun(runs, "q", { start_epoch: 1, end_epoch: 2, result: { gates: "pass" } }, [msg({ input: 100 })]);
  for (const [d, n] of [["resume-1", 20], ["quota-resume-1", 3], ["quota-resume-2", 4000]]) {
    fs.mkdirSync(path.join(runs, "q", d));
    fs.writeFileSync(path.join(runs, "q", d, "pi.jsonl"), msg({ input: n }) + "\n");
  }
  assert.equal(scanRun(path.join(runs, "q")).tokens, 100 + 20 + 3 + 4000);
});

test("outcomeKey:gate-slice 绿的照稿片,style-verdict.json 说 fail / none 就不算闸绿;pass 或没有这个文件照旧", () => {
  const { outcomeKey } = require("../lib/yield.js");
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "piw-yield-"));
  const meta = { start_epoch: 1, end_epoch: 2, result: { gates: "pass" } };
  for (const [l, sv] of [["a", null], ["b", { gates: "pass" }], ["c", { gates: "fail" }], ["d", { gates: "none" }]]) {
    mkRun(runs, l, meta, [msg({ input: 1 })]);
    if (sv) fs.writeFileSync(path.join(runs, l, "style-verdict.json"), JSON.stringify(sv));
  }
  assert.deepEqual(["a", "b", "c", "d"].map((l) => outcomeKey(meta, path.join(runs, l))), ["pass", "pass", "fail:照稿可改未清", "not-run:照稿未判"]);
  // 闸本来就红的片不看它
  mkRun(runs, "e", { ...meta, result: { gates: "fail" } }, [msg({ input: 1 })]);
  fs.writeFileSync(path.join(runs, "e", "style-verdict.json"), JSON.stringify({ gates: "pass" }));
  assert.equal(outcomeKey({ ...meta, result: { gates: "fail" } }, path.join(runs, "e")), "fail");
});

test("GWT-13 照稿(判官口径)行:只数 ruler: judge 的片;页有一片 pass 就算判过绿;不归页的只进合计;旧口径不数", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "piw-yield-"));
  const d1 = at("2026-10-27T08:00:00Z");
  const meta = { repo: "/x/otherapp", start_epoch: d1, end_epoch: d1 + 60, result: { gates: "pass" } };
  const sv = (l, o) => fs.writeFileSync(path.join(runs, l, "style-verdict.json"), JSON.stringify({ ruler: "judge", round: "r2", why: "", source: "t", ...o }));
  mkRun(runs, "a1", meta, [msg({ input: 10e6 })]); sv("a1", { gates: "pass", page: "asiakkaat" });
  mkRun(runs, "a2", meta, [msg({ input: 20e6 })]); sv("a2", { gates: "none", page: "asiakkaat" });
  mkRun(runs, "t1", meta, [msg({ input: 5e6 })]); sv("t1", { gates: "none", page: "tasks" });
  mkRun(runs, "old", meta, [msg({ input: 7e6 })]); fs.writeFileSync(path.join(runs, "old", "style-verdict.json"), JSON.stringify({ gates: "pass" }));
  const rep = yieldReport({ runs, since: "2026-10-27", until: "2026-10-27", repo: "otherapp" });
  assert.match(rep.text, /^照稿\(判官口径\):片 3 · token 35\.0M · 判过绿的页 1 · 每屏 35\.0M$/m);
  assert.match(rep.text, /^  asiakkaat 30\.0M 绿$/m);
  assert.match(rep.text, /^  tasks 5\.0M 未判$/m);
  mkRun(runs, "k1", meta, [msg({ input: 4e6 })]); sv("k1", { gates: "fail", page: "kausi" });
  mkRun(runs, "c1", meta, [msg({ input: 1e6 })]); sv("c1", { gates: "none", page: null });
  const rep2 = yieldReport({ runs, since: "2026-10-27", until: "2026-10-27", repo: "otherapp" });
  assert.match(rep2.text, /^照稿\(判官口径\):片 5 · token 40\.0M · 判过绿的页 1 · 每屏 40\.0M$/m);
  assert.match(rep2.text, /^  kausi 4\.0M 不绿$/m);
  assert.equal(rep2.zhaogao.pages.kausi.status, "不绿");
  // 没有照稿片的仓不出这一节
  const runs2 = fs.mkdtempSync(path.join(os.tmpdir(), "piw-yield-"));
  mkRun(runs2, "p", meta, [msg({ input: 1e6 })]);
  assert.doesNotMatch(yieldReport({ runs: runs2, since: "2026-10-27", until: "2026-10-27" }).text, /照稿/);
});
