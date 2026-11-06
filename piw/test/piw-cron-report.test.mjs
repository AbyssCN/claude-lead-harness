// node --test test/piw-cron-report.test.mjs —— piw cron-report:无人值守 Claude 会话的计数与豁免 · 回退记录一节 · 首行格式(SDD 2026-10-25 读数一)。
// 临时 HOME,手写 ~/.claude/projects 下的会话 jsonl,不调任何模型、不发信。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "piw");
const DAY = "2026-10-20";
const TS = "2026-10-20T10:00:00.000Z";

function world({ exempt = [], fallbacks = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-cr-"));
  fs.mkdirSync(path.join(home, ".config", "piw"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "piw", "config.json"), JSON.stringify({ cronClaudeExempt: exempt }));
  const proj = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(proj, { recursive: true });
  let n = 0;
  const session = ({ entrypoint = "sdk-cli", cwd, head }) => {
    const lines = [{ type: "user", entrypoint, cwd, timestamp: TS, message: { content: head } },
      { type: "assistant", entrypoint, cwd, timestamp: TS, message: { usage: { input_tokens: 1, output_tokens: 2 } } }];
    if (head == null) delete lines[0].message.content;
    const f = path.join(proj, `s${n++}.jsonl`);
    fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const t = new Date(TS); fs.utimesSync(f, t, t);
  };
  if (fallbacks.length) {
    fs.mkdirSync(path.join(home, ".omd-lite"), { recursive: true });
    fs.writeFileSync(path.join(home, ".omd-lite", "cron-fallbacks.jsonl"), fallbacks.map((f) => JSON.stringify(f)).join("\n") + "\n");
  }
  const out = path.join(home, "r.html");
  const env = { ...process.env, HOME: home };
  for (const k of ["PIW_CONFIG", "PIW_USAGE_DIR", "PIW_CRON_FALLBACKS"]) delete env[k];
  const run = () => spawnSync("node", [BIN, "cron-report", "--day", DAY, "--out", out], { encoding: "utf8", env });
  return { session, run, html: () => fs.readFileSync(out, "utf8") };
}

const OPSBOT = { name: "ops-bot Lark bot", head: "^处理工单 ", why: "bot 本体与它的 boundary 回归" };
const SEURANTA = { name: "acme seuranta", cwd: "^/mnt/nas/acme_internal/", why: "客户案卷留 Claude(owner 25.10)" };

test("首行:无人值守 Claude <N>(豁免 <M>)—— 命中豁免的不计入 N(GWT-2)", () => {
  const w = world({ exempt: [OPSBOT, SEURANTA] });
  w.session({ cwd: "/home/x/repos/marketing-hub", head: "处理工单 boundary-ratia-rules。" });
  w.session({ cwd: "/mnt/nas/acme_internal/operations/a", head: "You are the assistant of Acme Oy" });
  w.session({ cwd: "/tmp/x", head: "你是规格轴审查员" });
  w.session({ cwd: "/home/x/repos/bridge-1", head: "有人的远程会话" });
  w.session({ entrypoint: "cli", cwd: "/tmp/y", head: "交互会话" });
  const r = w.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /无人值守 Claude 1\(豁免 2\)/);
  assert.match(w.html(), /豁免:ops-bot Lark bot/);
});

test("没有豁免表:所有 sdk-cli 非远程会话都计入", () => {
  const w = world();
  w.session({ cwd: "/home/x/repos/marketing-hub", head: "处理工单 a" });
  w.session({ cwd: "/tmp/x", head: "b" });
  assert.match(w.run().stdout, /无人值守 Claude 2\(豁免 0\)/);
});

test("读不到首句的会话按无人值守计,不落进豁免(宁可多报)", () => {
  const w = world({ exempt: [{ name: "全豁", head: ".*", why: "x" }] });
  w.session({ cwd: "/tmp/x", head: null });
  assert.match(w.run().stdout, /无人值守 Claude 1\(豁免 0\)/);
});

test("当天的回退记录单列成「回退到 Claude」一节,首行带回退数(GWT-3)", () => {
  const w = world({ fallbacks: [
    { at: TS, caller: "ratia-weekly-review", from: "minimax", to: "claude", why: "captions-mrgao caption-lint 退 1" },
    { at: "2026-10-19T10:00:00.000Z", caller: "old", from: "minimax", to: "claude", why: "前一天的" },
  ] });
  const r = w.run();
  assert.match(r.stdout, /回退 1 /);
  const h = w.html();
  assert.match(h, /回退到 Claude/);
  assert.match(h, /ratia-weekly-review/);
  assert.match(h, /caption-lint 退 1/);
  assert.doesNotMatch(h, /前一天的/);
});
