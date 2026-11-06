// node --test test/piw-deliver.test.mjs —— run 结束时交付必须在 omdl/<run> 分支上(24.10 claude 臂 mg2 · mg7 · mr1 交付没提交,
// worktree 被 collect 的 wt-reap 归档删掉;claude-mods docs/investigations/2026-10-24-claude-executor-delivery-lost.md)。
// 判官:分支对基线的 diff --name-only = changed-files.txt(去掉「?? 」)· meta.delivered_sha = 分支头。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "piw");
const git = (cwd, ...a) => {
  const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piw-deliver-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // claude 替身:改一个已跟踪文件、建一个新文件,按 stream-json 报完成;不提交
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync("spec.md", "changed\\n");
fs.mkdirSync("src", { recursive: true });
fs.writeFileSync("src/new.ts", "export const x = 1;\\n");
console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "s-1" }));
`, { mode: 0o755 });
  const envFile = path.join(home, "env");
  fs.writeFileSync(envFile, "DEEPSEEK_API_KEY=fake\n");
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, OMD_LITE_ENV_FILE: envFile,
    PIW_USAGE_DIR: path.join(home, "usage") };
  for (const k of ["PIW_CONFIG", "PIW_COOLDOWN_FILE", "PIW_ENV_FILE", "PIW_ENV_KEEP", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  const repo = path.join(home, "repos", "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "spec.md"), "# spec\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "init");
  return { home, env, repo };
}

test("claude 臂 run 结束:改动提交在 omdl/<run> 上,分支 diff = changed-files.txt,meta.delivered_sha = 分支头", () => {
  const { home, env, repo } = fixture();
  const r = spawnSync("node", [BIN, "run", "--repo", repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal",
    "--executor", "claude", "--model", "opus", "--fallback-model", "none", "--gate", "true", "--name", "dl"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const run = path.join(home, ".omd-lite", "runs", "dl");
  const meta = JSON.parse(fs.readFileSync(path.join(run, "meta.json"), "utf8"));
  const files = fs.readFileSync(path.join(run, "changed-files.txt"), "utf8").split("\n").map((l) => l.replace(/^\?\? /, "")).filter(Boolean).sort();
  assert.deepEqual(files, ["spec.md", "src/new.ts"]);
  const onBranch = git(repo, "diff", "--name-only", meta.base_sha, "omdl/dl").split("\n").filter(Boolean).sort();
  assert.deepEqual(onBranch, files, "分支对基线的 diff 与 changed-files.txt 一致");
  assert.equal(meta.delivered_sha, git(repo, "rev-parse", "omdl/dl"));
  assert.equal(git(path.join(path.dirname(repo), "omdl-dl"), "status", "--porcelain"), "", "worktree 干净");
});

test("没有改动:不造空提交,delivered_sha = 基线", () => {
  const { home, env, repo } = fixture();
  fs.writeFileSync(path.join(home, "bin", "claude"), `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: "result", subtype: "success", session_id: "s-2" }));\n`, { mode: 0o755 });
  const r = spawnSync("node", [BIN, "run", "--repo", repo, "--base", "main", "--spec", "spec.md", "--prompt", "minimal",
    "--executor", "claude", "--model", "opus", "--fallback-model", "none", "--gate", "true", "--name", "nochg"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const meta = JSON.parse(fs.readFileSync(path.join(home, ".omd-lite", "runs", "nochg", "meta.json"), "utf8"));
  assert.equal(meta.delivered_sha, meta.base_sha);
  assert.equal(git(repo, "rev-parse", "omdl/nochg"), meta.base_sha);
});
