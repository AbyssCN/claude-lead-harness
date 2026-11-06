// 工厂事件流(F2,myapp docs/plan/10.18/f2-events-contract.md):一行一事件,只追加。
// 消费方各带本文件的逐字副本(插件装进 cache 后不能跨目录 import),brief-sync.mjs --check 判字节相等。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PHASES = ['launch', 'round', 'gate', 'report', 'collect', 'review', 'verdict', 'merge', 'label'];
export const ACTORS = ['pi', 'codex', 'agy', 'mcode', 'collect', 'lead', 'owner'];

export const eventsFile = (env = process.env) => env.FACTORY_EVENTS || path.join(os.homedir(), '.omd-lite', 'events.jsonl');

/** 写一行;写不进去只打一行 stderr,不让调用方失败(事件流是观测,不是闸)。 */
export function appendEvent({ repo, run, phase, status, actor, evidence = null, ...extra }, env = process.env) {
  const line = JSON.stringify({ ts: new Date().toISOString(), repo, run, phase, status, actor, evidence, ...extra });
  const file = eventsFile(env);
  // 不用 recursive mkdir:Node 对 /proc 下不存在的路径递归建目录会永久挂住(18.10 F2a 两次 run 因此超时)。
  // 先直接写;目录不在时只建最后一级再写一次,上一级也不在就算写不进。
  try {
    try {
      fs.appendFileSync(file, line + '\n');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      fs.mkdirSync(path.dirname(file));
      fs.appendFileSync(file, line + '\n');
    }
  } catch (e) {
    process.stderr.write(`factory events: 写不进 ${eventsFile(env)}:${e.message}\n`);
  }
}

/** 读全部事件;坏行跳过并计数。 */
export function readEvents(env = process.env) {
  const f = eventsFile(env);
  if (!fs.existsSync(f)) return { events: [], bad: 0 };
  let bad = 0;
  const events = [];
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { events.push(JSON.parse(l)); } catch { bad++; }
  }
  return { events, bad };
}
