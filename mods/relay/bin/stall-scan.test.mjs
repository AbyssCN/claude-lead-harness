import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asksNick, sanctioned, scan } from './stall-scan.mjs'

const wake = { kind: 'task-notification' }
const owner = { kind: 'human' }
const prompt = (t, origin, text = 'x') => ({ type: 'user', timestamp: t, origin, message: { content: text } })
const reply = (t, text) => ({ type: 'assistant', timestamp: t, message: { content: [{ type: 'text', text }] } })
function file(records) {
  const dir = mkdtempSync(join(tmpdir(), 'stall-'))
  const f = join(dir, 'aaaaaaaa-1.jsonl')
  writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return f
}

test('19.10 的两种停法都算问 owner', () => {
  assert.ok(asksNick('- **备选 B**:字面级不拦。\n\n你定了以后,我依次合 S9c、gate-preflight、b1。'))
  assert.ok(asksNick('**等你拍板的两张卡**:推荐都在 night-plan §5:\n- 卡 4\n- 卡 5\n\n我自己起的 run 都写进了交接。\n\nHANDOFF-READY'))
  assert.ok(asksNick('三片收完。要不要接着合 b1?'))
})

test('陈述不算:「等你拍板的:无」· 讲规则的「只有……才请你拍板」· 没有问', () => {
  assert.equal(asksNick('- 等你拍板的:无,三张卡都已拍。\nHANDOFF-READY'), false)
  assert.equal(asksNick('- 只有一种情况会停下来请你拍板:压不下字面级。\n其余照做。'), false)
  assert.equal(asksNick('等你拍板的事不是队列行,所以派发器不碰。\n已合 3 片,闸 PASS。'), false)
  assert.equal(asksNick('三片已合,main = abc,闸 PASS。'), false)
})

test('RELAY: owner / done 是 relay 认可的停法', () => {
  assert.ok(sanctioned('还在等你定。\nRELAY: owner 字面级怎么处理 | 推荐: 只记台账'))
  assert.equal(sanctioned('你定了以后我再合。\nRELAY: continue phase=build'), false)
})

test('叫醒推的一轮停在问句上、之后 20 分钟没动静 → 点名;15 分钟内有下一条 → 不点名', () => {
  const f = file([
    prompt('2026-10-19T05:20:00Z', wake),
    reply('2026-10-19T05:24:00Z', '你定了以后,我依次合。'),
    prompt('2026-10-19T05:44:00Z', wake),
    reply('2026-10-19T05:45:00Z', '要不要接着合?'),
    prompt('2026-10-19T05:50:00Z', wake),
    reply('2026-10-19T05:51:00Z', '已合,闸 PASS。'),
  ])
  const r = scan([f], { since: '2026-10-19T00:00:00Z', until: '2026-10-19T06:40:00Z' })
  assert.deepEqual(r.stalls.map((s) => [s.at, s.idleMin]), [['2026-10-19T05:24:00Z', 20]])
})

test('owner 自己推的一轮反问他不算空转;会话末尾没有下一条时空等算到 --until', () => {
  const f = file([
    prompt('2026-10-19T01:00:00Z', owner),
    reply('2026-10-19T01:01:00Z', '你选哪个?'),
    prompt('2026-10-19T05:00:00Z', wake),
    reply('2026-10-19T05:44:00Z', '等你拍板的两张卡:卡 4、卡 5。\nHANDOFF-READY'),
  ])
  const r = scan([f], { since: '2026-10-19T00:00:00Z', until: '2026-10-19T06:40:00Z' })
  assert.deepEqual(r.stalls.map((s) => [s.at, s.idleMin]), [['2026-10-19T05:44:00Z', 56]])
})

test('早上空等:owner 第一条消息前最后一轮到它的分钟数;RELAY: done 收尾的不算', () => {
  const a = file([prompt('2026-10-19T05:00:00Z', wake), reply('2026-10-19T05:24:00Z', '合了两片。'), prompt('2026-10-19T06:31:00Z', owner)])
  const b = file([prompt('2026-10-19T05:00:00Z', wake), reply('2026-10-19T05:10:00Z', '验收全过。\nRELAY: done')])
  const r = scan([a, b], { since: '2026-10-19T02:00:00Z', until: '2026-10-19T06:40:00Z' })
  assert.equal(r.firstNick, '2026-10-19T06:31:00Z')
  assert.deepEqual(r.morning.map((m) => m.idleMin), [67])
})

test('早上那条 = owner 睡前最后一条之后的第一条(窗口从前一晚开始也一样),不是窗口里最早的一条', () => {
  const f = file([
    prompt('2026-10-18T21:08:00Z', owner),
    reply('2026-10-18T21:09:00Z', '好。'),
    prompt('2026-10-19T05:00:00Z', wake),
    reply('2026-10-19T05:24:00Z', '合了两片。'),
    prompt('2026-10-19T06:31:00Z', owner),
  ])
  const r = scan([f], { since: '2026-10-18T21:00:00Z', until: '2026-10-19T06:40:00Z' })
  assert.equal(r.firstNick, '2026-10-19T06:31:00Z')
  assert.deepEqual(r.morning.map((m) => m.idleMin), [67])
})

test('否定说法不算在问:「不需要你确认」「不用你来定」「要不要锁:不要」', () => {
  assert.equal(asksNick('三片已合。\n不需要你确认,已合。'), false)
  assert.equal(asksNick('三片已合。\n不用你来定,我按推荐合了。'), false)
  assert.equal(asksNick('三片已合。\n测了要不要锁:不要,已合。'), false)
})
