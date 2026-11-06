// 闸自己报「没拿到闸槽、闸没跑」用 75(myapp gate-slice.sh 的 GATE_SLOT_WAIT_MAX_S)。
// 这不是闸红:同一道闸重排，不回灌执行体、不算一轮;重排到上限仍是 75 就原样交回，调用方记 not-run。
import fs from "node:fs";
import path from "node:path";

export const SLOT_BUSY = 75;
// 闸在执行体进程里排队时 stdout 没动静:每次起闸前 touch run 目录下这个文件,看门狗把它算作活动(25.10 -sq 被误判 hang)。
export const HEARTBEAT = "gate-heartbeat";

export async function runQueued(run, maxTries, beat = () => {}) {
  let r, tries = 0;
  do { beat(); r = await run(); tries++; } while (r.code === SLOT_BUSY && !r.timedOut && tries < maxTries);
  return { r, tries };
}

export function touchHeartbeat(dir) {
  if (!dir) return;
  try { const f = path.join(dir, HEARTBEAT); const t = new Date(); try { fs.utimesSync(f, t, t); } catch { fs.writeFileSync(f, ""); } } catch (e) { process.stderr.write(`piw: 闸心跳写不进 ${dir}:${e.message}\n`); }
}

export function lastActivity(lastAt, dir) {
  try { return Math.max(lastAt, fs.statSync(path.join(dir, HEARTBEAT)).mtimeMs); } catch { return lastAt; }
}
