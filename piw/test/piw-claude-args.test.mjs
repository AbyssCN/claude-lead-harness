import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// lead 30.10:sol 撞额度期间 claude(opus)顶审查;执行体不许带能问别的会话、起子 agent、上网的工具
test("claude 执行体只带内置的读写与 shell 工具，关掉斜杠命令与 MCP", () => {
  const { claudeRunArgs } = require("../lib/claude-args.js");
  const args = claudeRunArgs({ model: "opus", text: "任务书" });
  const i = args.indexOf("--tools");
  assert.ok(i >= 0, "要带 --tools 白名单");
  assert.deepEqual(args[i + 1].split(","), ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]);
  for (const f of ["--disable-slash-commands", "--strict-mcp-config", "-p"]) assert.ok(args.includes(f), f);
  assert.equal(args.at(-1), "任务书");
});

test("续轮带 --resume,白名单不变", () => {
  const { claudeRunArgs } = require("../lib/claude-args.js");
  const args = claudeRunArgs({ text: "x", sessionId: "s-1" });
  assert.equal(args[args.indexOf("--resume") + 1], "s-1");
  assert.ok(args.includes("--tools"));
});
