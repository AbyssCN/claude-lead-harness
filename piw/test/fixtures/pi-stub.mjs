#!/usr/bin/env node
// PIW_PI_BIN 替身:不调任何模型。按 --model 里的子串查 STUB_PLAN(JSON 文件路径或 JSON 文本),吐一个 agent_end。
// 行为:ok · empty(ok 但正文全空白)· 2056 · 402 · stream · 2013 · auth · noend(不吐 agent_end)· hang(工具调用不返回、不再出声)。每次调用把 argv / cwd / cwd 内容 / .pi/settings.json 追加进 STUB_LOG(jsonl)。
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const model = argv[argv.indexOf("--model") + 1] ?? "";
const plan = JSON.parse(process.env.STUB_PLAN || "{}");
const key = Object.keys(plan).find((k) => model.includes(k));
let kind = (key && plan[key]) || "ok";
// conn1 / quota1:同一坐标第一次调用连接错误(10 ms 就断的那种)/ 2056 额度用完,之后照常 ok —— 按 STUB_LOG 里已有的同坐标调用数判
if (kind === "conn1" || kind === "quota1") {
  const prior = process.env.STUB_LOG && fs.existsSync(process.env.STUB_LOG)
    ? fs.readFileSync(process.env.STUB_LOG, "utf8").split("\n").filter((l) => l && JSON.parse(l).model === model).length : 0;
  kind = prior > 0 ? "ok" : kind === "conn1" ? "conn" : "2056";
}
const cwd = process.cwd();
let settings = null;
try { settings = fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"); } catch {}
if (process.env.STUB_LOG) {
  let mcp = null;
  try { mcp = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), "utf8")); } catch {}
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv, cwd, model, kind, ls: fs.readdirSync(cwd).sort(), settings, mcp, envKeys: Object.keys(process.env).sort(), envProd: Object.values(process.env).some((v) => /prodref0000000000000|example-app\.fi/.test(v)) }) + "\n");
}

const ERR = {
  2056: '429: {"message":"Token Plan 用量上限 (2056)","http_code":"429"}',
  402: "402 Insufficient account balance",
  stream: "Stream ended without finish_reason",
  2013: '400: {"type":"error","error":{"message":"invalid params (2013)"}}',
  auth: "401 invalid api key (1004)",
  conn: "Connection error.",
};
const USAGE = { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20 };
const asst = (extra) => ({ role: "assistant", content: [], api: "x", provider: "x", model, usage: USAGE, timestamp: 1, ...extra });
let msg;
if (kind === "ok") msg = asst({ content: [{ type: "text", text: `STUB-OK:${model}` }], stopReason: "stop" });
else if (kind === "empty") msg = asst({ content: [{ type: "text", text: "   " }], stopReason: "stop" }); // 18.10 判官那个 1 字节静默回答
else if (kind === "noend") process.exit(1);
else if (kind === "hang") {
  // 一条永不返回的工具调用:吐 tool_execution_start 后不再出声(18.10 /proc/none 那种挂死)
  console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "node -e 'hang forever'" } }));
  setInterval(() => {}, 1 << 30);
}
else msg = asst({ stopReason: "error", errorMessage: ERR[kind] });
if (kind !== "hang") console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }, msg], willRetry: false }));
