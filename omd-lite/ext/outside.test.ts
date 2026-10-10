// node --test ext/outside.test.ts(node ≥ 23 直接跑 TS)
import { test } from "node:test";
import assert from "node:assert/strict";
import { outsideFiles } from "./gate-loop.ts";

const allowed = ["apps/web/src/lib/billing/", "packages/domain/src/reminders.ts"];

test("允许表内(目录前缀 / 精确路径)不算越界", () => {
  assert.deepEqual(outsideFiles([
    { status: "A", path: "apps/web/src/lib/billing/client.ts" },
    { status: "M", path: "packages/domain/src/reminders.ts" },
  ], allowed), []);
});

test("目录前缀不吃同名前缀的兄弟目录", () => {
  assert.deepEqual(outsideFiles([{ status: "M", path: "apps/web/src/lib/billing-old/x.ts" }], allowed), ["apps/web/src/lib/billing-old/x.ts"]);
});

test("首批实测的越界类:新增 / 修改测试文件豁免，删除测试不豁免", () => {
  assert.deepEqual(outsideFiles([
    { status: "M", path: "apps/web/src/components/dashboard/overview.test.tsx" },
    { status: "A", path: "apps/web/src/components/dashboard/hint.test.tsx" },
    { status: "A", path: "services/worker/test_window.py" },
    { status: "D", path: "apps/web/src/components/dashboard/home-view.test.tsx" },
  ], allowed), ["apps/web/src/components/dashboard/home-view.test.tsx(删除)"]);
});

test("index.ts 只加 export 行豁免;改动或删除既有行不豁免", () => {
  const addOnly = "diff --git a/x b/x\n--- a/packages/domain/src/index.ts\n+++ b/packages/domain/src/index.ts\n@@ -3,0 +4,2 @@\n+export * from \"./leave/season\";\n+export { a } from \"./a\";\n";
  const edits = "--- a/packages/domain/src/index.ts\n+++ b/packages/domain/src/index.ts\n@@ -3 +3 @@\n-export * from \"./old\";\n+export * from \"./new\";\n";
  const logic = "--- a/packages/domain/src/index.ts\n+++ b/packages/domain/src/index.ts\n@@ -3,0 +4 @@\n+const x = 1;\n";
  assert.deepEqual(outsideFiles([{ status: "M", path: "packages/domain/src/index.ts", diff: addOnly }], allowed), []);
  assert.deepEqual(outsideFiles([{ status: "M", path: "packages/domain/src/index.ts", diff: edits }], allowed), ["packages/domain/src/index.ts"]);
  assert.deepEqual(outsideFiles([{ status: "M", path: "packages/domain/src/index.ts", diff: logic }], allowed), ["packages/domain/src/index.ts"]);
});

test("非测试、非 index 的越界照常报;原型截图之类也报", () => {
  assert.deepEqual(outsideFiles([
    { status: "M", path: "vitest.config.ts" },
    { status: "M", path: "docs/design/prototypes/_shots/a.png" },
  ], allowed), ["vitest.config.ts", "docs/design/prototypes/_shots/a.png"]);
});
