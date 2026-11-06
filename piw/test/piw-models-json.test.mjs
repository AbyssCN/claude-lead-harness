// node --test test/piw-models-json.test.mjs —— --models-json:每片自己的 pi agent 目录,只换 models.json
// (otherapp docs/plan/2026-10-25-real-context-window-sdd.md INV-1 · INV-2 · GWT-1 · GWT-2 · GWT-3)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { modelsJsonEnv } = require("../bin/piw");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piw-mj-"));
  const real = path.join(root, "real");
  fs.mkdirSync(path.join(real, "npm"), { recursive: true });
  for (const [n, v] of [["auth.json", "{}"], ["settings.json", "{\"a\":1}"], ["models.json", "{\"w\":196608}"]]) fs.writeFileSync(path.join(real, n), v);
  const x = path.join(root, "models-1m.json");
  fs.writeFileSync(x, "{\"w\":1000000}");
  const out = path.join(root, "run");
  fs.mkdirSync(out);
  return { real, x, out };
}

test("GWT-1 没给 --models-json:env 不加 PI_CODING_AGENT_DIR,meta 记 null", () => {
  const { real, out } = fixture();
  const meta = {};
  const extra = modelsJsonEnv({ o: {}, env: { SANDBOX_ENV_PASS: "K" }, meta, outDir: out, realDir: real });
  assert.deepEqual(extra, {});
  assert.equal(meta.models_json, null);
  assert.equal(meta.models_json_sha256, null);
  assert.equal(fs.existsSync(path.join(out, "agent")), false);
});

test("GWT-2 只换 models.json,其余逐项软链回真目录;env 放行 PI_CODING_AGENT_DIR", () => {
  const { real, x, out } = fixture();
  const meta = {};
  const extra = modelsJsonEnv({ o: { models_json: x }, env: { SANDBOX_ENV_PASS: "MINIMAX_API_KEY" }, meta, outDir: out, realDir: real });
  const dir = path.join(out, "agent");
  assert.equal(extra.PI_CODING_AGENT_DIR, dir);
  assert.deepEqual(extra.SANDBOX_ENV_PASS.split(","), ["MINIMAX_API_KEY", "PI_CODING_AGENT_DIR"]);
  for (const n of ["auth.json", "settings.json", "npm"]) {
    assert.ok(fs.lstatSync(path.join(dir, n)).isSymbolicLink(), n);
    assert.equal(fs.readlinkSync(path.join(dir, n)), path.join(real, n));
  }
  assert.equal(fs.lstatSync(path.join(dir, "models.json")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), "{\"w\":1000000}");
  assert.equal(meta.models_json, x);
  assert.match(meta.models_json_sha256, /^[0-9a-f]{64}$/);
});

test("GWT-3 续跑轮与 fallback 轮用的是同一个 env 对象(带 PI_CODING_AGENT_DIR 的那个)", () => {
  const src = fs.readFileSync(new URL("../bin/piw", import.meta.url), "utf8");
  const calls = src.match(/await runPi\(\{[^}]*\}/g) ?? [];
  assert.ok(calls.length >= 3, `${calls.length}`);
  for (const c of calls) assert.match(c, /\benv,/, c);
  assert.match(src, /Object\.assign\(env, modelsJsonEnv\(/);
});

test("给的文件不存在 → 抛错,不静默退回全局 models.json", () => {
  const { real, out } = fixture();
  assert.throws(() => modelsJsonEnv({ o: { models_json: "/nope/models.json" }, env: {}, meta: {}, outDir: out, realDir: real }), /models-json/);
});
