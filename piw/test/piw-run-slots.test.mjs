import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PIW = path.resolve(import.meta.dirname, "../bin/piw");
const slots = () => fs.mkdtempSync(path.join(os.tmpdir(), "piw-slots-"));
const runPiw = (dir) => spawnSync(process.execPath, [PIW, "run"], { encoding: "utf8", env: { ...process.env, PIW_RUN_SLOTS: dir, PIW_MAX_RUNNING: "1", PIW_SLOT: "" } });

test("槽全被占 → 退 222,不进 run", async () => {
  const dir = slots();
  const holder = spawn("flock", [path.join(dir, "0"), "sleep", "30"]);
  await new Promise((r) => setTimeout(r, 300));
  try {
    const r = runPiw(dir);
    assert.equal(r.status, 222);
    assert.match(r.stderr, /满槽/);
  } finally { holder.kill(); }
});

test("有空槽 → 进 run(这里缺参数,退非 222)", () => {
  const r = runPiw(slots());
  assert.notEqual(r.status, 222);
  assert.doesNotMatch(r.stderr, /满槽/);
});

test("可用内存低于下限 → 按满槽退 222,不进 run", () => {
  const mi = path.join(slots(), "meminfo");
  fs.writeFileSync(mi, "MemTotal: 60000000 kB\nMemAvailable: 4194304 kB\n");
  const r = spawnSync(process.execPath, [PIW, "run"], { encoding: "utf8", env: { ...process.env, PIW_RUN_SLOTS: slots(), PIW_MEMINFO: mi, PIW_SLOT: "" } });
  assert.equal(r.status, 222);
  assert.match(r.stderr, /可用内存 4\.0G < 下限 8G/);
  fs.writeFileSync(mi, "MemAvailable: 33554432 kB\n");
  const ok = spawnSync(process.execPath, [PIW, "run"], { encoding: "utf8", env: { ...process.env, PIW_RUN_SLOTS: slots(), PIW_MEMINFO: mi, PIW_SLOT: "" } });
  assert.notEqual(ok.status, 222);
});
