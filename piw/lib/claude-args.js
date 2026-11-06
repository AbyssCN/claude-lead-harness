"use strict";
// 审查执行体能调 SendMessage / ListAgents 就能问别的会话要答案，读命令文字的泄漏检查看不见这条路;
// 起 Task / 上网同理。只留内置的读写与 shell(lead 30.10)。
const CLAUDE_RUN_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];

function claudeRunArgs({ model, sessionId, text }) {
  return ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
    "--setting-sources", "project,local", "--strict-mcp-config", "--disable-slash-commands",
    "--tools", CLAUDE_RUN_TOOLS.join(","), ...(model ? ["--model", model] : []),
    ...(sessionId ? ["--resume", sessionId] : []), text];
}

module.exports = { claudeRunArgs, CLAUDE_RUN_TOOLS };
