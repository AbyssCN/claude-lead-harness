/**
 * agent-guard —— piw agent(claude -p 替身)的工具守卫,模型之外的确定性限制。
 *
 * 设置来自 env PIW_AGENT_GUARD(JSON,由 lib/agent.js 写):
 *   bashPrefixes: null = bash 不限;数组 = 调用方原来给的 Bash(<前缀>:*) 白名单,其余命令一律拒
 *   maxToolCalls: 整次运行的工具调用上限,到了就拒并让模型收尾(防一次 cron 跑成几百步)
 *   mcpAllow / mcpDeny: MCP 工具(pi 名,mcp__<服务>__<工具>,* 通配)的允许 / 禁止表;不在允许表里的 MCP 调用一律拒(含 codemode 脚本里嵌套发起的)
 * 判法与 lib/agent.js 的 bashAllowed 同源(测试在那边测)。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { bashAllowed, mcpAllowed } = require("../lib/agent.js");

const GRACE = 10

export default function (pi: ExtensionAPI) {
  let guard: { bashPrefixes: string[] | null; maxToolCalls: number; mcpAllow: string[]; mcpDeny: string[] } = { bashPrefixes: null, maxToolCalls: 200, mcpAllow: [], mcpDeny: [] };
  try { guard = { ...guard, ...JSON.parse(process.env.PIW_AGENT_GUARD || "{}") }; } catch {}
  let calls = 0;
  pi.on("tool_call", async (e) => {
    calls++;
    // 到上限先只拦不停:给模型留 GRACE 次机会改成直接作答(立刻 terminate 会让它连最终答复都写不出,25.10 learn 实测);再不收手才终止
    if (calls > guard.maxToolCalls) {
      const reason = `本次运行的工具调用已到上限 ${guard.maxToolCalls},不要再调工具,用已有信息直接给出最终答复(该写的文件已写就照实说,没写就说没写)。`;
      return calls > guard.maxToolCalls + GRACE ? { block: true, reason, terminate: true } : { block: true, reason };
    }
    if (e.toolName.startsWith("mcp__")) {
      const v = mcpAllowed(e.toolName, guard.mcpAllow, guard.mcpDeny);
      if (!v.ok) return { block: true, reason: `这个 MCP 工具不允许:${v.reason}` };
    }
    if (e.toolName === "bash") {
      const cmd = String((e.input as { command?: string }).command ?? "");
      const v = bashAllowed(cmd, guard.bashPrefixes);
      if (!v.ok) return { block: true, reason: `这条命令不允许:${v.reason}。只能用这些命令前缀:${(guard.bashPrefixes || []).join(" · ")}` };
    }
    return undefined;
  });
}
