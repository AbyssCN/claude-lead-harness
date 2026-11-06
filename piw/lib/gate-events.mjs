// pi 臂的闸循环在 ext/gate-loop.ts 里，跑在执行体沙箱中，写不进宿主的 events.jsonl:每轮闸判完它在 run 目录记一行
// gate-events.jsonl(当时的时刻)。驱动收尾时把这些行原样转进事件流,ts 用记下的时刻，不用收尾时刻。
import fs from 'node:fs';
import path from 'node:path';

export function importGateEvents(dirs, base, append) {
  let n = 0;
  for (const d of dirs) {
    let text = '';
    try { text = fs.readFileSync(path.join(d, 'gate-events.jsonl'), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.phase !== 'gate' || !rec.ts) continue;
      append({ ...base, ...rec });
      n++;
    }
  }
  return n;
}
