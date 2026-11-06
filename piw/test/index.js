// Node >= 22 的 `node --test test/` 把目录当模块解析,直接报 MODULE_NOT_FOUND;这个入口让该写法可用。
// 它把本目录所有 *.test.mjs 载入同一个测试进程;`node --test test/*.test.mjs` 逐文件跑也等价。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
for (const f of fs.readdirSync(__dirname).sort()) if (f.endsWith(".test.mjs")) import(path.join(__dirname, f));
