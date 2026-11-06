// node --test ext/fixed-summary.test.ts(契约 otherapp docs/plan/2026-10-25-fixed-summary-compaction-sdd.md INV-1 · INV-6 · GWT-1 · GWT-2 · GWT-8)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummary, CAPS, lastGateText } from "./fixed-summary.ts";

const paths = (n: number, p = "f") => Array.from({ length: n }, (_, i) => `apps/${p}${i}.ts`);

test("GWT-1 喂回 20 次,摘要有界且不随次数涨(护栏)", () => {
  let narrative: string | null = null;
  const lens: number[] = [];
  for (let i = 0; i < 20; i++) {
    const r = buildSummary({ task: "t".repeat(3000), read: paths(200), modified: paths(200, "m"), gateText: "g".repeat(5000), narrative: (narrative ?? "") + "x".repeat(4000) });
    narrative = r.narrative;
    lens.push(r.summary.length);
  }
  for (const l of lens) assert.ok(l <= 18000, `${l}`);
  assert.ok(lens[19]! <= 1.3 * lens[0]!);
});

test("GWT-2 Gate state 超长保留尾部", () => {
  const gate = "head\n" + "a".repeat(10000) + "\nLAST LINE";
  const r = buildSummary({ task: "t", read: [], modified: [], gateText: gate, narrative: null });
  const sec = r.summary.split("## Gate state\n")[1]!.split("\n## ")[0]!;
  assert.ok(sec.length <= CAPS.gate);
  assert.ok(sec.endsWith("LAST LINE"));
  assert.deepEqual(r.truncated.gate, { count: 1, dropped: gate.length - CAPS.gate });
});

test("GWT-8 路径超 80 条记账 +120;全在上限内五节 dropped 为 0", () => {
  const r = buildSummary({ task: "t", read: paths(200), modified: [], gateText: null, narrative: null });
  assert.deepEqual(r.truncated.read, { count: 1, dropped: 120 });
  const sec = r.summary.split("## Files read\n")[1]!.split("\n## ")[0]!;
  assert.equal(sec.trim().split("\n").at(-1), "… +120");
  const ok = buildSummary({ task: "t", read: paths(3), modified: paths(2, "m"), gateText: "闸未通过(第 1/4 轮)", narrative: "n" });
  for (const k of ["task", "modified", "read", "gate", "progress"] as const) assert.equal(ok.truncated[k].dropped, 0, k);
});

test("没有闸红写 no gate feedback yet;节目固定五节", () => {
  const r = buildSummary({ task: "t", read: [], modified: [], gateText: null, narrative: null });
  assert.match(r.summary, /## Gate state\nno gate feedback yet/);
  assert.deepEqual(r.summary.match(/^## .+$/gm), ["## Task", "## Files modified", "## Files read", "## Gate state", "## Progress · Next · Open problems"]);
});

test("lastGateText 取到此刻为止最后一条闸红 user 消息原文", () => {
  const u = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
  const entries = [u("task"), u("闸未通过(第 1/4 轮)。g1"), { type: "message", message: { role: "assistant", content: [] } }, u("闸未通过(第 2/4 轮)。g2"), u("别的")];
  assert.equal(lastGateText(entries), "闸未通过(第 2/4 轮)。g2");
  assert.equal(lastGateText([u("task")]), null);
});
