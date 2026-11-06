// node --test test/piw-brief.test.mjs —— F1b:bin/piw 的 allowedFromSpec 解析走 lib/brief.mjs。
// 紧贴路径的「(新建)」不再是路径的一部分(TODO 18.10:任务书写成 `x.ts(新建)` 时整串被当路径);
// frontmatter 块拥有 允许改动,正文里的同名行不读。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// bin/piw 是 CLI,但把 allowedFromSpec 导出来才能在测试里直接读它的判词(不改名字与返回形状)。
const { allowedFromSpec } = require("../bin/piw");

const SPECS = {
  "tight-new.md": "允许改动:src/x.ts(新建) src/y.ts",
  "frontmatter.md": "---\n允许改动: a.ts\n---\n允许改动:b.ts",
  "none.md": "# spec\n正文里没有允许改动这一行",
};

// allowedFromSpec 自己走 `git show <base_sha>:<spec>` 取文本,所以判词要落在一次真的提交上。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-brief-"));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const repo = path.join(home, "repo");
fs.mkdirSync(repo);
const git = (...a) => {
  const r = spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
git("init", "-q", "-b", "main");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
for (const [name, text] of Object.entries(SPECS)) fs.writeFileSync(path.join(repo, name), text + "\n");
git("add", "-A");
git("commit", "-qm", "briefs");
const base_sha = git("rev-parse", "HEAD");
const allowed = (spec) => allowedFromSpec({ repo, base_sha, spec });

test("紧贴路径的 (新建) 剥掉:任务书写 x.ts(新建) 时路径是 x.ts,不是 x.ts(新建)", () => {
  assert.deepEqual(allowed("tight-new.md"), ["src/x.ts", "src/y.ts"]);
});

test("frontmatter 块拥有 允许改动:块外的同名行不读", () => {
  assert.deepEqual(allowed("frontmatter.md"), ["a.ts"]);
});

test("任务书没有 允许改动 → null(没有可比对的清单,不是空清单)", () => {
  assert.equal(allowed("none.md"), null);
});

test("任务书在 base 上不存在 → null(git show 失败也不当成空清单)", () => {
  assert.equal(allowed("missing.md"), null);
});
