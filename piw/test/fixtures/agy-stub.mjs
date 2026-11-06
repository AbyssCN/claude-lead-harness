#!/usr/bin/env node
// agy 替身(piw ask 的 agy/<model> 坐标):读 stdin 的 stream-json,记一行到 STUB_LOG,按 AGY_STUB_MODE 吐 result 事件。
import fs from "node:fs";
let input = "";
for await (const b of process.stdin) input += b;
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ bin: "agy", argv: process.argv.slice(2), input, cwd: process.cwd() }) + "\n");
const usage = { input_tokens: 100, output_tokens: 7, thinking_tokens: 3, cache_read_tokens: 0, total_tokens: 110 };
const mode = process.env.AGY_STUB_MODE || "ok";
const result = mode === "ok"
  ? { status: "SUCCESS", response: `AGY-OK:${process.argv[process.argv.indexOf("--model") + 1]}\n`, usage }
  : { status: "ERROR", response: "", error: "RESOURCE_EXHAUSTED: quota exceeded", usage };
console.log(JSON.stringify({ event: "init", tools: [] }));
console.log(JSON.stringify({ event: "result", result }));
