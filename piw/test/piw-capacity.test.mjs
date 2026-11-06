// node --test test/piw-capacity.test.mjs —— 容量读数(lib/capacity.js):全部从盘上夹具读,不碰真 ~/.omd-lite。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { capacity, pct } = require("../lib/capacity.js");

const DAY = "2026-10-25";
const at = (h) => Math.floor(new Date(`${DAY}T${String(h).padStart(2, "0")}:00:00`).getTime() / 1000);

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
  const env = { HOME: root, PIW_MEM_SAMPLES: path.join(root, "mem.tsv"), PIW_GATE_LEDGER: path.join(root, "ledger.tsv"),
    PIW_RUNS_DIR: path.join(root, "runs"), PIW_USAGE_DIR: path.join(root, "usage") };
  fs.mkdirSync(env.PIW_RUNS_DIR); fs.mkdirSync(env.PIW_USAGE_DIR);
  const run = (name, repo, result, rounds = 1, extra = {}) => {
    const d = path.join(env.PIW_RUNS_DIR, name); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify({ repo }));
    fs.writeFileSync(path.join(d, "result.json"), JSON.stringify(result));
    const t = new Date(`${DAY}T12:00:00`); fs.utimesSync(path.join(d, "result.json"), t, t);
    for (let i = 1; i <= rounds; i++) fs.writeFileSync(path.join(d, `gate-round-${i}.log`), extra.log ?? "");
    if (extra.merged) fs.writeFileSync(path.join(d, "collect.json"), JSON.stringify({ steps: { merge: { status: "green" } } }));
    return d;
  };
  return { root, env, run };
}

test("pct:最近秩;空 → null", () => {
  assert.equal(pct([], 50), null);
  assert.equal(pct([5, 1, 3], 50), 3);
  assert.equal(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10), 1);
});

test("内存采样:p10 换算成 GiB,在跑数 p50/max", () => {
  const w = world();
  fs.writeFileSync(w.env.PIW_MEM_SAMPLES, [`${at(1)}\t${20 * 1048576}\t4`, `${at(2)}\t${30 * 1048576}\t8`, `${at(3)}\t${10 * 1048576}\t6`, `${at(0) - 7200}\t1\t99`].join("\n") + "\n");
  const c = capacity({ day: DAY, env: w.env });
  assert.equal(c.mem.n, 3, "前一天的样本不算");
  assert.equal(c.mem.memP10, 10);
  assert.equal(c.mem.max, 8);
});

test("台账:新 9 列行按第 9 列分仓、取第 8 列等待;旧 7 列行按 run 目录 meta 分仓、等待改读闸日志", () => {
  const w = world();
  const old = w.run("old", "/home/user/repos/myapp", { gates: "pass" }, 1, { log: "gate-slice: 等了 40 s,拿到内存闸槽 1/3(dev 道)\n" });
  const neu = w.run("neu", "/home/user/repos/otherapp", { gates: "pass" }, 1, { log: "gate-slice: 等了 999 s,拿到内存闸槽 1/3(dev 道)\n" });
  fs.writeFileSync(w.env.PIW_GATE_LEDGER, [
    `${at(9)}\tacquire\tdev\t1\t1\tpi\t${old}`,
    `${at(9)}\tacquire\tdev\t1\t1\tpi\t${neu}\t12\t/home/user/repos/otherapp`,
    `${at(9)}\ttimeout\tdev\t-\t1\tpi\t${neu}\t300\t/home/user/repos/otherapp`,
    `${at(9)}\trefuse\tdev\t-\t-\tpi\t${neu}\t0\t/home/user/repos/otherapp`,
  ].join("\n") + "\n");
  const c = capacity({ day: DAY, env: w.env });
  const bb = c.repos.find((r) => r.repo === "otherapp"), pl = c.repos.find((r) => r.repo === "myapp");
  assert.deepEqual([bb.waitP50, bb.timeouts, bb.refuses], [12, 1, 1], "新行有等待列,不再读闸日志里的 999");
  assert.equal(pl.waitP50, 40, "旧行没有等待列,退回读闸日志");
});

test("没跑占比 = 当天完成 run 里 error 闸槽排队超时的条数 ÷ 闸轮数;myapp 完成 < 5 片标待证伪", () => {
  const w = world();
  w.run("a", "/home/user/repos/otherapp", { gates: "not-run", error: "闸槽排队超时" }, 1);
  w.run("b", "/home/user/repos/otherapp", { gates: "pass" }, 3);
  w.run("p", "/home/user/repos/myapp", { gates: "pass" }, 1);
  const c = capacity({ day: DAY, env: w.env });
  const bb = c.repos.find((r) => r.repo === "otherapp"), pl = c.repos.find((r) => r.repo === "myapp");
  assert.equal(bb.notRunPct, 25);
  assert.equal(pl.pending, true);
  assert.equal(bb.pending, false);
});
