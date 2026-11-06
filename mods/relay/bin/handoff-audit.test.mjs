import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { audit, flags } from './handoff-audit.mjs'

// ⑥ 的三个可选项一律显式传:测试不读宿主的真实目录。
const noEnv = () => ({ boots: [], sessionsDir: mkdtempSync(join(tmpdir(), 'hsess-')), procRoot: mkdtempSync(join(tmpdir(), 'hproc-')) })
const judge = (d, opts = {}) => audit([d], { ...noEnv(), ...opts })

const owner = { kind: 'human' }
const relay = { kind: 'plugin', name: 'relay' }
const wake = { kind: 'task-notification' }
const prompt = (t, origin, text) => ({ type: 'user', timestamp: t, origin, message: { content: text } })
let mid = 0
const reply = (t, text, cacheRead = 1000) => ({
  type: 'assistant',
  timestamp: t,
  message: { id: `m${++mid}`, content: [{ type: 'text', text }], usage: { input_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
})
const tool = (t, cacheRead) => ({
  type: 'assistant',
  timestamp: t,
  message: { id: `m${++mid}`, content: [{ type: 'tool_use', id: `toolu_${++mid}`, name: 'Bash', input: {} }], usage: { input_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
})
const send = (t, path) => ({
  type: 'assistant',
  timestamp: t,
  message: { id: `m${++mid}`, content: [{ type: 'tool_use', name: 'SendUserFile', input: { files: [path] } }] },
})
const refusal = (t, c = 'reasoning_extraction') => ({ type: 'system', subtype: 'model_refusal_no_fallback', timestamp: t, apiRefusalCategory: c })
const note = (t, path, k = 420) => ({ type: 'attachment', timestamp: t, attachment: { content: `[relay] 上下文已到 ${k}k。写交接到 ${path}(覆盖写)` } })
const resume = (t, path, extra = '') => prompt(t, relay, `[relay] 上一段上下文已自动清空。先读交接 ${path};${extra}`)
const compact = (t) => ({ type: 'system', subtype: 'compact_boundary', timestamp: t })

function dir(sessions) {
  const d = mkdtempSync(join(tmpdir(), 'haudit-'))
  for (const [id, records] of Object.entries(sessions))
    writeFileSync(join(d, `${id}-0000-0000-0000-000000000000.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return d
}

const H = '/h/.claude/handoffs/r-aaaaaaaa.md'

test('每个 session:超过 400k 的请求数、超过 550k 的请求数、峰值、compact_boundary 次数', () => {
  const d = dir({
    aaaaaaaa: [
      prompt('2026-10-23T08:00:00Z', owner, '问一句'),
      tool('2026-10-23T08:00:10Z', 390_000),
      tool('2026-10-23T08:00:20Z', 420_000),
      reply('2026-10-23T08:00:30Z', '答', 560_000),
      compact('2026-10-23T08:01:00Z'),
    ],
  })
  const r = judge(d)
  const s = r.sessions.find((x) => x.session === 'aaaaaaaa')
  assert.equal(s.over400, 2)
  assert.equal(s.over550, 1)
  assert.equal(s.peak, 560_000)
  assert.equal(s.compacts, 1)
  assert.equal(r.compacts, 1)
})

test('轮中冲高:一轮从 400k 以下开始、轮内超过 550k,单独计数', () => {
  const d = dir({
    aaaaaaaa: [
      prompt('2026-10-23T08:00:00Z', owner, '跑一大串工具'),
      tool('2026-10-23T08:00:10Z', 380_000),
      tool('2026-10-23T08:00:20Z', 480_000),
      reply('2026-10-23T08:00:30Z', '完', 600_000),
      prompt('2026-10-23T08:05:00Z', owner, '下一句'),
      reply('2026-10-23T08:05:10Z', '好', 410_000),
    ],
  })
  const r = judge(d)
  assert.equal(r.surges.length, 1)
  assert.equal(r.surges[0].from, 380_000)
  assert.equal(r.surges[0].peak, 600_000)
})

test('GOAL 期间 armed → 新会话续接:cleared,算分钟;第一轮 SendUserFile 发旁车、之后 3 次工具调用 → delivered、continued', () => {
  const d = dir({
    aaaaaaaa: [
      prompt('2026-10-23T08:00:00Z', relay, '[relay] GOAL 已写好并激活:/r/docs/plan/10.23/GOAL.md'),
      prompt('2026-10-23T08:10:00Z', owner, '那张表的口径改成按月'),
      reply('2026-10-23T08:12:00Z', '改好了,按月汇总,提交 abc123。', 300_000),
      prompt('2026-10-23T08:20:00Z', wake, '<task-notification>done</task-notification>'),
      note('2026-10-23T08:20:00Z', H),
      reply('2026-10-23T08:21:00Z', '交接写好。\nHANDOFF-READY', 425_000),
    ],
    bbbbbbbb: [
      resume('2026-10-23T08:22:00Z', H, 'GOAL /r/docs/plan/10.23/GOAL.md'),
      send('2026-10-23T08:22:10Z', '/h/.claude/handoffs/r-aaaaaaaa.last.md'),
      tool('2026-10-23T08:22:20Z', 10_000),
      tool('2026-10-23T08:22:25Z', 10_000),
      reply('2026-10-23T08:22:30Z', '旁车发了,接着做。'),
    ],
  })
  const r = judge(d)
  assert.equal(r.handoffs.length, 1)
  const h = r.handoffs[0]
  assert.equal(h.goal, true)
  assert.equal(h.outcome, 'cleared')
  assert.equal(h.minutes, 2)
  assert.equal(h.delivered, true)
  assert.equal(h.continued, true)
})

test('续接后第一轮没发旁车、之后被拦停 → 不算 delivered,不算 continued', () => {
  const d = dir({
    aaaaaaaa: [
      prompt('2026-10-23T08:10:00Z', owner, '那张表的口径改成按月'),
      reply('2026-10-23T08:12:00Z', '改好了,按月汇总,提交 abc123。', 420_000),
      prompt('2026-10-23T08:13:00Z', relay, `[relay] 上下文已到 420k。写交接到 ${H}(覆盖写)`),
      reply('2026-10-23T08:14:00Z', '写好。\nHANDOFF-READY', 425_000),
    ],
    bbbbbbbb: [resume('2026-10-23T08:15:00Z', H), tool('2026-10-23T08:15:10Z', 1), tool('2026-10-23T08:15:11Z', 1), tool('2026-10-23T08:15:12Z', 1), refusal('2026-10-23T08:15:20Z')],
  })
  const h = judge(d).handoffs[0]
  assert.equal(h.goal, false)
  assert.equal(h.outcome, 'cleared')
  assert.equal(h.delivered, false)
  assert.equal(h.continued, false)
  assert.equal(h.refused, true)
})

test('armed 之后 owner 说话、没有 clear → cancelled;armed 之后 40 分钟没 clear、owner 也没说话 → stuck', () => {
  const H2 = '/h/.claude/handoffs/r-cccccccc.md'
  const d = dir({
    aaaaaaaa: [
      prompt('2026-10-23T08:00:00Z', relay, '[relay] 按 GOAL 继续:/r/GOAL.md'),
      note('2026-10-23T08:00:00Z', H),
      prompt('2026-10-23T08:03:00Z', owner, '等一下'),
      reply('2026-10-23T08:03:30Z', '好'),
    ],
    cccccccc: [
      prompt('2026-10-23T08:00:00Z', relay, '[relay] 按 GOAL 继续:/r/GOAL.md'),
      note('2026-10-23T08:00:00Z', H2),
      reply('2026-10-23T08:01:00Z', 'HANDOFF-READY'),
      prompt('2026-10-23T08:40:00Z', wake, '<task-notification>x</task-notification>'),
      reply('2026-10-23T08:40:10Z', '收到'),
    ],
  })
  const r = judge(d, { until: '2026-10-23T09:00:00Z' })
  const by = Object.fromEntries(r.handoffs.map((h) => [h.session, h.outcome]))
  assert.deepEqual(by, { aaaaaaaa: 'cancelled', cccccccc: 'stuck' })
  assert.equal(r.goal.stuck, 1)
  assert.equal(r.goal.rate, 0)
})

test('READY 之后挂了 2 小时、owner 才说话:算 stuck(卡到他说话为止),不算他说话取消', () => {
  const d = dir({
    aaaaaaaa: [
      prompt('2026-10-23T08:00:00Z', relay, '[relay] 按 GOAL 继续:/r/GOAL.md'),
      note('2026-10-23T08:00:00Z', H),
      reply('2026-10-23T08:01:30Z', 'HANDOFF-READY'),
      prompt('2026-10-23T10:05:00Z', owner, '怎么还没清'),
      reply('2026-10-23T10:05:30Z', '卡住了'),
    ],
  })
  const h = judge(d).handoffs[0]
  assert.equal(h.outcome, 'stuck')
  assert.equal(h.minutes, 125)
})

test('只算有 owner 发过消息的会话(mcode / 子任务的会话不进总数)', () => {
  const d = dir({ aaaaaaaa: [prompt('2026-10-23T08:00:00Z', wake, 'x'), reply('2026-10-23T08:00:10Z', 'y', 900_000)] })
  assert.equal(judge(d).sessions.length, 0)
})

test('0.5.0 起的续接措辞(先贴 <clear前原文>,再「然后读交接 <path>」)也认作 cleared', () => {
  const d = dir({
    aaaaaaaa: [
      prompt('2026-10-23T08:10:00Z', owner, '按月还是按周?'),
      reply('2026-10-23T08:11:00Z', '按月。', 420_000),
      prompt('2026-10-23T08:11:31Z', relay, `[relay] 上下文已到 420k。写交接到 ${H}(覆盖写)`),
      reply('2026-10-23T08:12:30Z', '写好。\nHANDOFF-READY', 425_000),
    ],
    bbbbbbbb: [
      prompt('2026-10-23T08:13:00Z', relay, `[relay] 上一段上下文已自动清空。开工第一件事:把下面 <clear前原文> 块原样贴给 owner。\n<clear前原文>\n按月还是按周?\n按月。\n</clear前原文>\n然后读交接 ${H};与 git log 冲突时以后者为准。`),
      reply('2026-10-23T08:13:20Z', '## owner 最后一条消息\n按月还是按周?\n## 之后的回答\n按月。'),
    ],
  })
  const h = judge(d).handoffs[0]
  assert.equal(h.outcome, 'cleared')
})

test('⑥ 拦停按类别和仓目录计,时间窗外的不算', () => {
  const d = dir({
    aaaaaaaa: [refusal('2026-10-23T08:00:00Z'), refusal('2026-10-23T09:00:00Z', 'cyber'), refusal('2026-10-10T09:00:00Z')],
  })
  const f = join(d, 'aaaaaaaa-0000-0000-0000-000000000000.jsonl')
  const r = flags([f], '2026-10-20')
  assert.deepEqual(r.by, { reasoning_extraction: 1, cyber: 1 })
  assert.equal(r.where[`reasoning_extraction ${d.split('/').at(-1)}`], 1)
})

test('越过阈值那一轮:轮内 >400k 的请求数记成 crossTail(轮末才交接挡不住的那段)', () => {
  const d = dir({
    aaaaaaaa: [
      prompt('2026-10-23T08:00:00Z', owner, '跑一串'),
      tool('2026-10-23T08:00:10Z', 390_000),
      tool('2026-10-23T08:00:20Z', 401_000),
      tool('2026-10-23T08:00:30Z', 405_000),
      reply('2026-10-23T08:00:40Z', '完', 410_000),
      prompt('2026-10-23T08:05:00Z', owner, '再来'),
      reply('2026-10-23T08:05:10Z', '好', 415_000),
    ],
  })
  const r = judge(d)
  assert.equal(r.sessions[0].crossTail, 3)
  assert.deepEqual(r.crossTail, { sessions: 1, median: 3, p90: 3, max: 3, over20: 0 })
})

test('only:只量给定的会话(handoff.log 里 start relay 新版的那些);续接会话照样能在全部文件里找到', () => {
  const d = dir({
    aaaaaaaa: [prompt('2026-10-23T08:00:00Z', owner, '旧版窗口'), reply('2026-10-23T08:00:10Z', 'x', 900_000)],
    bbbbbbbb: [
      prompt('2026-10-23T08:10:00Z', owner, '按月?'),
      reply('2026-10-23T08:11:00Z', '按月。', 420_000),
      prompt('2026-10-23T08:11:31Z', relay, `[relay] 上下文已到 420k。写交接到 ${H}(覆盖写)`),
      reply('2026-10-23T08:12:00Z', 'HANDOFF-READY', 421_000),
    ],
    cccccccc: [
      resume('2026-10-23T08:13:00Z', H),
      send('2026-10-23T08:13:05Z', '/h/.claude/handoffs/r-aaaaaaaa.last.md'),
      tool('2026-10-23T08:13:06Z', 1),
      tool('2026-10-23T08:13:07Z', 1),
      reply('2026-10-23T08:13:10Z', '接着做。'),
    ],
  })
  const r = judge(d, { only: new Set(['bbbbbbbb', 'cccccccc']) })
  assert.deepEqual(r.sessions.map((s) => s.session).sort(), ['bbbbbbbb', 'cccccccc'])
  assert.equal(r.handoffs.length, 1)
  assert.equal(r.handoffs[0].outcome, 'cleared')
  assert.equal(r.verdict.pass, true)
})

// /goal:落盘时刻取 relay 写的 handoff.log `goal` 行(会话记录里没有),其余从会话记录读。
const G = '/r/docs/plan/10.23/GOAL.md'
const goalCmd = (t, args) => ({ type: 'system', subtype: 'local_command', timestamp: t, content: `<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>${args}</command-args>` })
const write = (t, path) => ({ type: 'assistant', timestamp: t, message: { id: `m${++mid}`, content: [{ type: 'tool_use', name: 'Write', input: { file_path: path, content: 'x' } }] } })
const kickNote = (t) => ({ type: 'attachment', timestamp: t, attachment: { content: `[relay] GOAL 已写好并激活:${G}。先读它` } })

test('/goal:落盘秒数(/goal → handoff.log goal 行)、落盘到 lead 收到激活的秒数、lead 自己 Write 覆盖次数、质量', () => {
  const d = dir({
    aaaaaaaa: [
      prompt('2026-10-23T08:00:00Z', owner, '先聊'),
      goalCmd('2026-10-23T08:00:10Z', '周一全所上线'),
      tool('2026-10-23T08:00:30Z', 50_000),
      kickNote('2026-10-23T08:01:20Z'),
      write('2026-10-23T08:05:00Z', G),
    ],
  })
  const log = `2026-10-23T08:01:10.000Z aaaaaaaa goal fork 58s prompt 9000 chars ctx 50k hints 0 todo 1 ${G}\n`
  const r = judge(d, { log })
  assert.equal(r.goals.length, 1)
  const g = r.goals[0]
  assert.equal(g.via, 'fork')
  assert.equal(g.writeSec, 60)
  assert.equal(g.deliverSec, 10)
  assert.equal(g.overwrites, 1)
  assert.equal(g.clean, false)
  assert.equal(r.verdict.goal.writeP90, 60)
  assert.equal(r.verdict.goal.slowDeliver, 0)
  assert.equal(r.verdict.goal.overwrites, 1)
  assert.equal(r.verdict.goal.unclean, 1)
  assert.equal(r.verdict.pass, false)
})

test('/goal:收不到激活(落盘后会话里一直没有 note 也没有开工 prompt)记成 deliverSec null,算慢', () => {
  const d = dir({ aaaaaaaa: [prompt('2026-10-23T08:00:00Z', owner, 'x'), goalCmd('2026-10-23T08:00:10Z', '目标')] })
  const log = `2026-10-23T08:00:40.000Z aaaaaaaa goal complete 30s prompt 9000 chars ctx 0k hints 0 todo 0 ${G}\n`
  const r = judge(d, { log })
  assert.equal(r.goals[0].deliverSec, null)
  assert.equal(r.verdict.goal.slowDeliver, 1)
})

test('没有 /goal 的窗口:/goal 四个数不挡判决', () => {
  const d = dir({ aaaaaaaa: [prompt('2026-10-23T08:00:00Z', owner, 'x'), reply('2026-10-23T08:00:10Z', 'y')] })
  assert.equal(judge(d, { log: '' }).verdict.pass, true)
})

// ⑦ 孤儿 GOAL:一条 GOAL 线断了以后多久没人接上。
const P = '/r/docs/plan/10.13/GOAL.md'
const P2 = '/r/docs/plan/10.13/GOAL-2.md'
const cont = (t, path = P) => prompt(t, relay, `[relay] 按 GOAL 继续:${path}(phase=build;当前项:第 4 块)。每次醒来:…末行照写 RELAY 行。`)
const activate = (t, path = P) => prompt(t, relay, `[relay] GOAL 已写好并激活:${path}。先读它,从「清单」最上面未勾项开工。`)
// relay 自己清空之后的自动清空 prompt:正文里带「激活中的 GOAL:<P>」
const autoClear = (t, path = P) => prompt(t, relay, `[relay] 上一段上下文已自动清空。先读交接 ${H}\n激活中的 GOAL:${path}(phase=build)。relay 已在新 session 接上自动续跑。`)
// 旁车点名了前一个会话(aaaaaaaa)的交接文件 —— 说明清空那一刻进程还活着
const autoClearLast = (t, path = P) => prompt(t, relay, `[relay] 上一段上下文已自动清空。开工第一件事:把下面 <clear前原文> 块原样贴给 owner。\n贴完用 SendUserFile 把 /h/.claude/handoffs/r-aaaaaaaa.last.md 发给 owner。\n激活中的 GOAL:${path}(phase=wait)。`)
// relay 自己停了:最后一条 [relay] prompt 是这种提醒
const relayHalted = (t, path = P) => prompt(t, relay, `[relay] 上一轮没有以 RELAY 行收尾,或停在了问句 / 选项上。整理、总结、问要不要继续都不是停机条件:按 GOAL ${path} 直接做下一步;只有终点本身要 owner 改才写 RELAY: owner <问题>。`)
// 心跳:正文里带 GOAL 路径,但不是裁定 1 的三种形状之一
const heartbeat = (t, path = P) => prompt(t, relay, `[relay] 心跳:已等 25 分钟。查在等的 run / 子 agent:结束了就收结果,按 GOAL ${path} 推进。`)
const clearCmd = (t) => prompt(t, owner, '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>')
const relayStop = (t) => ({ type: 'system', subtype: 'local_command', timestamp: t, content: '<command-name>/relay</command-name>\n<command-message>relay</command-message>\n<command-args>stop</command-args>' })
const nickMsg = (t, text) => prompt(t, owner, text)
// 会话尾巴上的记账记录:queue-operation、cost-state 这些不代表会话还在说话
const tail = (t) => ({ type: 'queue-operation', operation: 'dequeue', timestamp: t, sessionId: 'x' })

// ~/.claude/sessions 的 <pid>.json 和 /proc/<pid>/stat:造一个属主进程。
function owner({ sessionId, status = 'busy', procStart = '8918298', alive = false, btime = null } = {}) {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'hsess-'))
  const procRoot = mkdtempSync(join(tmpdir(), 'hproc-'))
  if (sessionId) {
    writeFileSync(join(sessionsDir, '4242.json'), JSON.stringify({ pid: 4242, sessionId, status, procStart }))
    if (alive) {
      mkdirSync(join(procRoot, '4242'), { recursive: true })
      const fields = new Array(50).fill('0')
      fields[0] = 'S'
      fields[19] = String(procStart) // 第 22 列 starttime
      writeFileSync(join(procRoot, '4242', 'stat'), `4242 (claude) ${fields.join(' ')}\n`)
    }
  }
  if (btime) writeFileSync(join(procRoot, 'stat'), `btime ${btime}\n`)
  return { sessionsDir, procRoot }
}

test('⑦ 孤儿:断了以后没人接上 —— 条数、最长秒数、WSL 空档、证据类别、恢复时刻', () => {
  const d = dir({
    bbbbbbbb: [cont('2026-10-13T18:30:00Z'), reply('2026-10-13T18:31:00Z', '在推'), tool('2026-10-13T18:46:39Z', 1000)],
  })
  const { sessionsDir, procRoot } = owner()
  const r = audit([d], {
    until: '2026-10-14T23:59:59Z',
    boots: [
      ['2026-10-13T18:00:00Z', '2026-10-13T18:46:46Z'],
      ['2026-10-13T18:47:16Z', '2026-10-14T00:00:00Z'],
    ],
    sessionsDir,
    procRoot,
  })
  assert.equal(r.orphans.length, 1)
  const o = r.orphans[0]
  assert.equal(o.goal, P)
  assert.ok(o.session.startsWith('bbbbbbbb'))
  assert.equal(o.disconnectedAt, '2026-10-13T18:46:39Z')
  assert.equal(o.resumedAt, null)
  assert.equal(o.durationS, 105200)
  assert.equal(o.wslDownS, 30)
  assert.equal(o.countedS, 105170)
  assert.ok(o.evidence.includes('boot-end'))
  assert.ok(o.evidence.includes('dangling-tool-use'))
  assert.equal(o.kind, 'orphan')
  assert.equal(r.verdict.orphans, 1)
  assert.equal(r.verdict.orphanBlind, 0)
  assert.equal(r.verdict.orphanFalse, 0)
  assert.equal(r.verdict.orphanMaxS, 105170)
  assert.equal(r.verdict.pass, false)
})

test('⑦ wslDownS:只算掐断它的那次关机,之后的关机不加;有 boot 数据但后面没有空档记 0', () => {
  const d = dir({
    bbbbbbbb: [cont('2026-10-13T18:30:00Z'), tool('2026-10-13T18:46:39Z', 1000)],
  })
  const { sessionsDir, procRoot } = owner()
  const boots = [
    ['2026-10-13T18:00:00Z', '2026-10-13T18:46:46Z'],
    ['2026-10-13T18:47:16Z', '2026-10-14T00:00:00Z'],
    ['2026-10-14T00:01:00Z', '2026-10-14T23:59:59Z'],
  ]
  const two = audit([d], { until: '2026-10-14T23:59:59Z', boots, sessionsDir, procRoot }).orphans[0]
  assert.equal(two.wslDownS, 30)
  assert.equal(two.countedS, two.durationS - 30)
  const none = audit([d], { until: '2026-10-14T23:59:59Z', boots: [['2026-10-13T18:00:00Z', '2026-10-15T00:00:00Z']], sessionsDir, procRoot }).orphans[0]
  assert.equal(none.wslDownS, 0)
})

test('⑦ 反例:relay 自己 /clear 续上的(下一个会话第一条是自动清空),3 分钟内又收到按 GOAL 继续 → 不算孤儿', () => {
  const d = dir({
    aaaaaaaa: [cont('2026-10-14T02:00:00Z'), reply('2026-10-14T02:10:00Z', '在推'), clearCmd('2026-10-14T02:20:00Z')],
    bbbbbbbb: [autoClear('2026-10-14T02:20:01Z'), cont('2026-10-14T02:23:00Z'), reply('2026-10-14T02:30:00Z', '做完了。\nRELAY: done')],
  })
  const { sessionsDir, procRoot } = owner()
  const r = audit([d], { until: '2026-10-14T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r.orphans, [])
  assert.equal(r.verdict.orphans, 0)
  assert.equal(r.verdict.pass, true)
})

test('⑦ 反例:最后一条 assistant 文本以 RELAY: done 收尾,之后 10 小时没有记录 → 不算孤儿', () => {
  const d = dir({ cccccccc: [cont('2026-10-11T20:50:39Z'), reply('2026-10-11T21:30:00Z', '验收全过。\nRELAY: done')] })
  // done 之后 owner 又说了一句、会话停在半截:done 这条仍然算数
  const after = dir({ cccccccc: [cont('2026-10-11T20:50:39Z'), reply('2026-10-11T21:30:00Z', '验收全过。\nRELAY: done'), nickMsg('2026-10-11T21:31:00Z', '好')] })
  const { sessionsDir, procRoot } = owner()
  const r = audit([d], { until: '2026-10-12T08:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r.orphans, [])
  const r2 = audit([after], { until: '2026-10-12T08:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r2.orphans, [])
})

test('⑦ 反例:owner 敲 /goal clear 或者 /relay stop 之后没有记录 → 不算孤儿', () => {
  const cleared = dir({ aaaaaaaa: [cont('2026-10-23T08:00:00Z'), tool('2026-10-23T08:10:00Z', 1000), goalCmd('2026-10-23T08:20:00Z', 'clear')] })
  const stopped = dir({ aaaaaaaa: [cont('2026-10-23T08:00:00Z'), tool('2026-10-23T08:10:00Z', 1000), relayStop('2026-10-23T08:20:00Z')] })
  const { sessionsDir, procRoot } = owner()
  assert.deepEqual(audit([cleared], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot }).orphans, [])
  assert.deepEqual(audit([stopped], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot }).orphans, [])
})

test('⑦ 反例:/goal clear 或 /relay stop 之后 assistant 又回了话 → 照样不算孤儿', () => {
  const cleared = dir({ aaaaaaaa: [cont('2026-10-23T08:00:00Z'), tool('2026-10-23T08:10:00Z', 1000), goalCmd('2026-10-23T08:20:00Z', 'clear'), reply('2026-10-23T08:21:00Z', 'GOAL 已清掉')] })
  const stopped = dir({ aaaaaaaa: [cont('2026-10-23T08:00:00Z'), tool('2026-10-23T08:10:00Z', 1000), relayStop('2026-10-23T08:20:00Z'), reply('2026-10-23T08:21:00Z', '已停')] })
  const { sessionsDir, procRoot } = owner()
  assert.deepEqual(audit([cleared], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot }).orphans, [])
  assert.deepEqual(audit([stopped], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot }).orphans, [])
})

test('⑦ /goal clear 之后 relay 又按 GOAL 继续了 → 那次 clear 不算停', () => {
  const d = dir({ aaaaaaaa: [goalCmd('2026-10-23T07:50:00Z', 'clear'), cont('2026-10-23T08:00:00Z'), tool('2026-10-23T08:10:00Z', 1000)] })
  const { sessionsDir, procRoot } = owner()
  assert.equal(audit([d], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot }).orphans.length, 1)
})

test('⑦ 还活着的会话不算孤儿:sessions 目录里有它的 pid 文件,/proc 里那个 pid 的 starttime 对得上', () => {
  const d = dir({ aaaaaaaa: [cont('2026-10-23T08:00:00Z'), tool('2026-10-23T08:10:00Z', 1000)] })
  const { sessionsDir, procRoot } = owner({ sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', alive: true })
  const r = audit([d], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r.orphans, [])
})

test('⑦ 35 分钟边界:34 分钟接上不算孤儿,36 分钟接上算,恢复时刻是那条 prompt 的时刻', () => {
  const near = dir({
    aaaaaaaa: [cont('2026-10-23T08:00:00Z'), tool('2026-10-23T08:05:00Z', 1000)],
    bbbbbbbb: [cont('2026-10-23T08:34:00Z'), reply('2026-10-23T08:40:00Z', '接着推')],
  })
  const far = dir({
    aaaaaaaa: [cont('2026-10-23T08:00:00Z'), tool('2026-10-23T08:05:00Z', 1000)],
    bbbbbbbb: [cont('2026-10-23T08:41:00Z'), reply('2026-10-23T08:47:00Z', '接着推')],
  })
  const { sessionsDir, procRoot } = owner()
  const r1 = audit([near], { until: '2026-10-23T08:45:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r1.orphans, [])
  const r2 = audit([far], { until: '2026-10-23T08:50:00Z', boots: [], sessionsDir, procRoot })
  assert.equal(r2.orphans.length, 1)
  assert.equal(r2.orphans[0].disconnectedAt, '2026-10-23T08:05:00Z')
  assert.equal(r2.orphans[0].resumedAt, '2026-10-23T08:41:00Z')
  assert.equal(r2.orphans[0].durationS, 36 * 60)
})

test('⑦ kind:三类证据都占不上、没有 pid 文件是盲区,有 pid 文件(pid 不在了、status 是 idle)是误报', () => {
  // 断开在 owner 那句话上:这一轮没人接,但没有 boot、没有 pid 文件、没有悬着的 tool_use
  const blind = dir({ aaaaaaaa: [cont('2026-10-23T08:00:00Z'), reply('2026-10-23T08:05:00Z', '在推'), nickMsg('2026-10-23T08:10:00Z', '接着推')] })
  const { sessionsDir, procRoot } = owner()
  const r = audit([blind], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.equal(r.orphans.length, 1)
  assert.deepEqual(r.orphans[0].evidence, [])
  assert.equal(r.orphans[0].kind, 'blind')
  assert.equal(r.verdict.orphans, 0)
  assert.equal(r.verdict.orphanBlind, 1)
  assert.equal(r.verdict.orphanFalse, 0)
  // pid 文件还在(pid 已经不在、status 不是 busy)→ 误报
  const withPid = dir({ aaaaaaaa: [cont('2026-10-23T08:00:00Z'), reply('2026-10-23T08:05:00Z', '在推'), nickMsg('2026-10-23T08:10:00Z', '接着推')] })
  const own = owner({ sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', status: 'idle' })
  const r2 = audit([withPid], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir: own.sessionsDir, procRoot: own.procRoot })
  assert.equal(r2.orphans.length, 1)
  assert.deepEqual(r2.orphans[0].evidence, [])
  assert.equal(r2.orphans[0].kind, 'false')
  assert.equal(r2.verdict.orphans, 0)
  assert.equal(r2.verdict.orphanBlind, 0)
  assert.equal(r2.verdict.orphanFalse, 1)
  assert.equal(r2.verdict.pass, false)
})

test('⑦ 裁定 2:不许用「最后一轮说完了、没有证据」把孤儿滤掉 —— 答完一轮就停的会话照样进 orphans', () => {
  // 裁定 2:没有证据的孤儿照样进 orphans,计进 orphanBlind。误报只能靠把上面几条判对来消掉,不能藏起来。
  const d = dir({ aaaaaaaa: [cont('2026-10-23T08:00:00Z'), reply('2026-10-23T08:10:00Z', '交接已写好。\nHANDOFF-READY'), tail('2026-10-23T08:10:30Z')] })
  const { sessionsDir, procRoot } = owner()
  const r = audit([d], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.equal(r.orphans.length, 1)
  assert.deepEqual(r.orphans[0].evidence, [])
  assert.equal(r.orphans[0].kind, 'blind')
  assert.equal(r.verdict.orphanBlind, 1)
  assert.equal(r.verdict.orphanFalse, 0)
})

test('⑦ 证据:pid 文件还在、status 是 busy,而那个 pid 已经不在 → busy-pidfile', () => {
  const d = dir({ aaaaaaaa: [cont('2026-10-23T08:00:00Z'), reply('2026-10-23T08:05:00Z', '在推'), nickMsg('2026-10-23T08:10:00Z', '接着推')] })
  const { sessionsDir, procRoot } = owner({ sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', status: 'busy' })
  const r = audit([d], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r.orphans[0].evidence, ['busy-pidfile'])
  assert.equal(r.orphans[0].kind, 'orphan')
  assert.equal(r.verdict.orphans, 1)
  assert.equal(r.verdict.orphanFalse, 0)
})

test('⑦ 命令行:--boots 给的 boot 区间读进来,人读输出有一行以「⑦ 孤儿 GOAL」开头', () => {
  const d = dir({ bbbbbbbb: [cont('2026-10-13T18:30:00Z'), tool('2026-10-13T18:46:39Z', 1000)] })
  const boots = join(d, 'boots.json')
  const boot = (index, first, last) => `${JSON.stringify({ index, boot_id: `b${index}`, first_entry: Date.parse(first) * 1000, last_entry: Date.parse(last) * 1000 })}\n`
  writeFileSync(boots, boot(0, '2026-10-13T18:00:00Z', '2026-10-13T18:46:46Z') + boot(1, '2026-10-13T18:47:16Z', '2026-10-14T00:00:00Z'))
  const bin = fileURLToPath(new URL('./handoff-audit.mjs', import.meta.url))
  const r = spawnSync('node', [bin, '--until', '2026-10-14T23:59:59Z', '--boots', boots, d], { encoding: 'utf8' })
  const line = r.stdout.split('\n').find((l) => l.startsWith('⑦ 孤儿 GOAL'))
  assert.ok(line, `stdout 里没有 ⑦ 孤儿 GOAL 那一行:${r.stdout}`)
  assert.match(line, /1 条/)
  assert.match(line, /盲区 0 条/)
  assert.match(line, /误报 0 条/)
  assert.match(line, /最长 105170 秒/)
  const one = r.stdout.split('\n').find((l) => l.trim().startsWith('bbbbbbbb'))
  assert.match(one, /orphan/)
  assert.match(one, /WSL 空档 30 秒/)
  assert.equal(r.status, 1)
})

// 裁定 1:只有三种 [relay] 记录说明 <P> 这份 GOAL 在跑 —— 按 GOAL 继续 / GOAL 已写好并激活 / 自动清空里的「激活中的 GOAL」。

test('⑦ done 看最后一个 RELAY 行(照 fe98e485 的形状):done 之后还有几轮 owner 和 assistant 的对话、都没有 RELAY 行 → 不是孤儿', () => {
  const d = dir({
    cccccccc: [
      cont('2026-10-11T21:00:00Z'),
      reply('2026-10-11T21:30:00Z', '验收全过。\nRELAY: done'),
      nickMsg('2026-10-11T23:00:00Z', '还有一件事'),
      reply('2026-10-11T23:05:00Z', '说完了'),
      nickMsg('2026-10-12T06:20:00Z', '嗯'),
      reply('2026-10-12T06:27:00Z', '好'),
    ],
  })
  const { sessionsDir, procRoot } = owner()
  const r = audit([d], { until: '2026-10-12T08:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r.orphans, [])
  // 停在 owner 的话上(没人接)也一样:最后一个 RELAY 行是 done 就不算断
  const stopped = dir({
    cccccccc: [
      cont('2026-10-11T21:00:00Z'),
      reply('2026-10-11T21:30:00Z', '验收全过。\nRELAY: done'),
      nickMsg('2026-10-11T23:00:00Z', '还有一件事'),
      reply('2026-10-11T23:05:00Z', '说完了'),
      nickMsg('2026-10-12T06:20:00Z', '嗯'),
    ],
  })
  const r2 = audit([stopped], { until: '2026-10-12T08:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r2.orphans, [])
})

test('⑦ 裁定 1:三种 [relay] 记录说明 GOAL 在跑 —— 按 GOAL 继续 / GOAL 已写好并激活 / 自动清空里的「激活中的 GOAL」', () => {
  // 三种形状各自把会话送上一条线:断了以后没人接上 → 都是孤儿
  const contLine = dir({ aaaaaaaa: [cont('2026-10-23T08:00:00Z'), reply('2026-10-23T08:05:00Z', '在推')] })
  const actLine = dir({ aaaaaaaa: [activate('2026-10-23T08:00:00Z'), reply('2026-10-23T08:05:00Z', '在推')] })
  const clrLine = dir({ aaaaaaaa: [autoClear('2026-10-23T08:00:00Z'), reply('2026-10-23T08:05:00Z', '在推')] })
  const { sessionsDir, procRoot } = owner()
  for (const d of [contLine, actLine, clrLine]) {
    const r = audit([d], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
    assert.equal(r.orphans.length, 1, '这一条 GOAL 线上应该有一个孤儿')
    assert.equal(r.orphans[0].goal, P)
  }
})

test('⑦ 裁定 1:续接 prompt 只认「激活中的 GOAL」—— 正文里别处的 GOAL 路径不算', () => {
  // 自动清空的正文会把仓里最新的 GOAL.md 列出来,不管有没有 GOAL 在跑;只认「激活中的 GOAL」那一句
  const d = dir({
    aaaaaaaa: [
      prompt('2026-10-23T08:00:00Z', relay, '[relay] 上一段上下文已自动清空。先读交接 /h/.claude/handoffs/r-aaaaaaaa.md,再读目标文件 /r/docs/plan/10.20/GOAL.md;与 git log 冲突时以后者为准。'),
      reply('2026-10-23T08:05:00Z', '在推'),
    ],
  })
  const { sessionsDir, procRoot } = owner()
  const r = audit([d], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r.orphans, [])
  assert.equal(r.verdict.orphans, 0)
  // 心跳正文里的 GOAL 路径同样不算:它不是裁定 1 的三种形状
  const beat = dir({ aaaaaaaa: [heartbeat('2026-10-23T08:00:00Z'), reply('2026-10-23T08:05:00Z', '在推')] })
  const r2 = audit([beat], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r2.orphans, [])
})

test('⑦ relay 自己清空后接上(照 01d4eade → a408cb6a 的形状):A 不是孤儿', () => {
  const d = dir({
    aaaaaaaa: [activate('2026-10-23T06:00:00Z'), reply('2026-10-23T06:20:00Z', '等结果。\nRELAY: continue phase=wait')],
    bbbbbbbb: [autoClearLast('2026-10-23T06:20:01Z'), reply('2026-10-23T06:30:00Z', '推完了。\nRELAY: done')],
  })
  const { sessionsDir, procRoot } = owner()
  const r = audit([d], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r.orphans, [])
  // 同一个形状,但接上的会话没有「激活中的 GOAL」 → GOAL 已经不在跑了,A 也不算断
  const noGoal = dir({
    aaaaaaaa: [activate('2026-10-23T06:00:00Z'), reply('2026-10-23T06:20:00Z', '等结果。\nRELAY: continue phase=wait')],
    bbbbbbbb: [prompt('2026-10-23T06:20:01Z', relay, '[relay] 上一段上下文已自动清空。开工第一件事:把下面 <clear前原文> 块原样贴给 owner。\n贴完用 SendUserFile 把 /h/.claude/handoffs/r-aaaaaaaa.last.md 发给 owner。'), reply('2026-10-23T06:30:00Z', '推完了。\nRELAY: done')],
  })
  const r2 = audit([noGoal], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r2.orphans, [])
})

test('⑦ relay 自己停了:最后一条 [relay] prompt 是「上一轮没有以 RELAY 行收尾」,之后的回答里没有 RELAY 行 → 不是孤儿', () => {
  const d = dir({
    aaaaaaaa: [cont('2026-10-23T08:00:00Z'), reply('2026-10-23T08:05:00Z', '在推'), relayHalted('2026-10-23T08:10:00Z'), reply('2026-10-23T08:12:00Z', '没有 RELAY 行的一句话')],
  })
  const { sessionsDir, procRoot } = owner()
  const r = audit([d], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r.orphans, [])
})

test('⑦ owner 自己 /clear 在下一个会话开头:那个 /clear 是 owner 敲的,这条线就不算断', () => {
  // 下一个会话开头是 owner 的 /clear,后面没有 [relay] prompt → 这条线不算断
  const cleared = dir({
    aaaaaaaa: [cont('2026-10-23T08:00:00Z'), reply('2026-10-23T08:10:00Z', '在推')],
    bbbbbbbb: [clearCmd('2026-10-23T08:11:00Z'), reply('2026-10-23T08:12:00Z', '新会话接着说')],
  })
  const { sessionsDir, procRoot } = owner()
  const r1 = audit([cleared], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r1.orphans, [])
  // 反过来:下一个会话的 /clear 后面 3 秒就有 [relay] 按 GOAL 继续:<P> → 那是 relay 自己清的,A 照常按恢复时刻算
  const continued = dir({
    aaaaaaaa: [cont('2026-10-23T08:00:00Z'), reply('2026-10-23T08:10:00Z', '在推')],
    bbbbbbbb: [clearCmd('2026-10-23T08:11:00Z'), cont('2026-10-23T08:11:03Z'), reply('2026-10-23T08:11:30Z', '接着推。\nRELAY: done')],
  })
  const r2 = audit([continued], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r2.orphans, [])
  // 同一形状,但 A 的断开在 40 分钟前 → A 按恢复时刻算,是孤儿(恢复时刻就是那条 prompt 的时刻)
  const late = dir({
    aaaaaaaa: [cont('2026-10-23T08:00:00Z'), reply('2026-10-23T08:05:00Z', '在推')],
    bbbbbbbb: [clearCmd('2026-10-23T08:45:01Z'), cont('2026-10-23T08:45:04Z'), reply('2026-10-23T08:45:30Z', '接着推。\nRELAY: done')],
  })
  const r3 = audit([late], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.equal(r3.orphans.length, 1)
  assert.ok(r3.orphans[0].session.startsWith('aaaaaaaa'))
  assert.equal(r3.orphans[0].resumedAt, '2026-10-23T08:45:04Z')
})

test('⑦ 被别的 GOAL 顶掉(照 3abdeeef 的形状):A 不进 orphans', () => {
  const d = dir({
    aaaaaaaa: [cont('2026-10-23T08:00:00Z'), reply('2026-10-23T08:10:00Z', '在推')],
    bbbbbbbb: [cont('2026-10-23T08:30:00Z', P2), reply('2026-10-23T08:31:00Z', '新 GOAL 开工。\nRELAY: done')],
  })
  const { sessionsDir, procRoot } = owner()
  const r = audit([d], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r.orphans, [])
})

test('⑦ 进程还活着、换了会话(照 a408cb6a → 57f4119e 的形状):A 不是孤儿', () => {
  const d = dir({
    aaaaaaaa: [cont('2026-10-23T08:00:00Z'), reply('2026-10-23T08:10:00Z', '在推')],
    bbbbbbbb: [nickMsg('2026-10-23T08:20:00Z', '接着推'), reply('2026-10-23T08:21:00Z', '好')],
  })
  // 属主进程 4242 还活着:btime + procStart 换算出的启动时刻早于 A 的最后一条记录,
  // 它现在挂着的会话(bbbbbbbb)在同一目录、开始时刻晚于 A 的最后一条记录
  const { sessionsDir, procRoot } = owner({
    sessionId: 'bbbbbbbb-0000-0000-0000-000000000000',
    procStart: '1000',
    alive: true,
    btime: 1792337915,
  })
  const r = audit([d], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.deepEqual(r.orphans, [])
})

test('⑦ 同一会话不重复:一个会话在两条线上都断了,orphans 里同一个 sessionId 只出现一次', () => {
  const d = dir({
    aaaaaaaa: [cont('2026-10-23T08:00:00Z', P), cont('2026-10-23T08:01:00Z', P2), tool('2026-10-23T08:10:00Z', 1000)],
  })
  const { sessionsDir, procRoot } = owner()
  const r = audit([d], { until: '2026-10-23T12:00:00Z', boots: [], sessionsDir, procRoot })
  assert.equal(r.orphans.length, 1)
  assert.equal(new Set(r.orphans.map((o) => o.session)).size, r.orphans.length)
  assert.equal(r.verdict.orphans, 1)
})

// 切片 7:判官读 owner.log 的 `mode` 行(D-12 的格式:空格分隔,路径里的空格写成 %20)。
const GWT_P = '/r/docs/plan/10.12/GOAL.md'
const GWT_UNTIL = '2026-10-12T16:27:07Z' // 断开 10 小时之后
// 照 6f1ba5c1 的形状:会话在 GOAL 线上,最后一条 assistant 文本以 RELAY: continue phase=wait 收尾,之后安静结束
const contWait = (t, path = GWT_P) => prompt(t, relay, `[relay] 按 GOAL 继续:${path}(phase=wait;当前项:第 4 块)。每次醒来:…末行照写 RELAY 行。`)
const gwt14 = (path = GWT_P) =>
  dir({ aaaaaaaa: [contWait('2026-10-12T06:00:00Z', path), reply('2026-10-12T06:27:07Z', '等结果。\nRELAY: continue phase=wait')] })
// mode 行:<ISO> mode <cwd> <goalPath> <sid8> <pid> <procStart> <from>-><to> <why>[ <旧 sid8>]
const modeLine = ({ at = '2026-10-12T06:26:00.000Z', goal = GWT_P, sid = 'aaaaaaaa', pid = '4242', procStart = '8918298', from = 'waiting-owner', to = 'running', why = 'continue' } = {}) =>
  [at, 'mode', '/r', goal, sid, pid, procStart, `${from}->${to}`, why].join(' ')
const ownerLogFile = (lines) => {
  const f = join(mkdtempSync(join(tmpdir(), 'howner-')), 'owner.log')
  writeFileSync(f, lines.join('\n') + '\n')
  return f
}
// fixture 的 procRoot:可以有一个属主 pid(第 22 列给不给得上由用例决定);sessions 目录里没有 pid 文件
function gwt14Env({ alive = false, procStart = '8918298' } = {}) {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'hsess-'))
  const procRoot = mkdtempSync(join(tmpdir(), 'hproc-'))
  if (alive) {
    mkdirSync(join(procRoot, '4242'), { recursive: true })
    const fields = new Array(50).fill('0')
    fields[0] = 'S'
    fields[19] = String(procStart) // 第 22 列 starttime
    writeFileSync(join(procRoot, '4242', 'stat'), `4242 (claude) ${fields.join(' ')}\n`)
  }
  return { sessionsDir, procRoot }
}
const judgeGwt = (d, ownerLog, env = gwt14Env()) => audit([d], { until: GWT_UNTIL, boots: [], ...env, ownerLog })

test('⑦ GWT-14 照 6f1ba5c1 的形状:没有 owner.log 的 mode 行 → 照旧是盲区;有 mode 行 → 不再落进盲区(护栏)', () => {
  const d = gwt14()
  const { sessionsDir, procRoot } = gwt14Env()
  // 没有 owner.log:三类证据都占不上、没有 pid 文件 → 盲区(和切片 1 一样)
  const bare = audit([d], { until: GWT_UNTIL, boots: [], sessionsDir, procRoot })
  assert.equal(bare.orphans.length, 1)
  assert.deepEqual(bare.orphans[0].evidence, [])
  assert.equal(bare.orphans[0].kind, 'blind')
  assert.equal(bare.verdict.orphanBlind, 1)
  // owner.log 文件不在 → 当空文件,不报错,读数不变
  const missing = audit([d], { until: GWT_UNTIL, boots: [], sessionsDir, procRoot, ownerLog: join(tmpdir(), 'howner-no-such.log') })
  assert.equal(missing.orphans[0].kind, 'blind')
  // 同一份 fixture,加上 mode 行 → 不再是盲区(护栏:分类确实是 mode 行带来的)
  const withMode = judgeGwt(d, ownerLogFile([modeLine()]))
  assert.notEqual(withMode.orphans[0].kind, 'blind')
})

test('⑦ GWT-14 有 mode 行、新 mode 是 running:属主进程不在了 → kind: orphan,evidence 加 owner-dead', () => {
  const d = gwt14()
  const r = judgeGwt(d, ownerLogFile([modeLine({ to: 'running' })])) // procRoot 里没有那个 pid
  assert.equal(r.orphans.length, 1)
  assert.equal(r.orphans[0].kind, 'orphan')
  assert.ok(r.orphans[0].evidence.includes('owner-dead'))
  assert.equal(r.verdict.orphans, 1)
  assert.equal(r.verdict.orphanBlind, 0)
  assert.equal(r.verdict.orphanFalse, 0)
})

test('⑦ GWT-14 有 mode 行、新 mode 是 running:属主进程还活着(第 22 列对得上)→ kind: false,evidence 加 owner-alive', () => {
  const d = gwt14()
  const r = judgeGwt(d, ownerLogFile([modeLine({ to: 'running' })]), gwt14Env({ alive: true }))
  assert.equal(r.orphans.length, 1)
  assert.equal(r.orphans[0].kind, 'false')
  assert.ok(r.orphans[0].evidence.includes('owner-alive'))
  assert.equal(r.verdict.orphans, 0)
  assert.equal(r.verdict.orphanBlind, 0)
  assert.equal(r.verdict.orphanFalse, 1)
})

test('⑦ GWT-14 新 mode 是 waiting-owner:属主死了 → orphan,属主活着 → false', () => {
  const d = gwt14()
  const dead = judgeGwt(d, ownerLogFile([modeLine({ to: 'waiting-owner' })]))
  assert.equal(dead.orphans[0].kind, 'orphan')
  assert.ok(dead.orphans[0].evidence.includes('owner-dead'))
  const alive = judgeGwt(d, ownerLogFile([modeLine({ to: 'waiting-owner' })]), gwt14Env({ alive: true }))
  assert.equal(alive.orphans[0].kind, 'false')
  assert.ok(alive.orphans[0].evidence.includes('owner-alive'))
})

test('⑦ GWT-14 新 mode 是 idle:relay 自己停了 → 这条不进 orphans', () => {
  const d = gwt14()
  const r = judgeGwt(d, ownerLogFile([modeLine({ to: 'idle' })]), gwt14Env({ alive: true }))
  assert.deepEqual(r.orphans, [])
  assert.equal(r.verdict.orphans, 0)
  assert.equal(r.verdict.orphanBlind, 0)
  assert.equal(r.verdict.orphanFalse, 0)
  // done 同样是不进 orphans
  const done = judgeGwt(d, ownerLogFile([modeLine({ to: 'done' })]), gwt14Env({ alive: true }))
  assert.deepEqual(done.orphans, [])
})

test('⑦ GWT-14 只认同一个会话、同一份 GOAL:sid8 是别的会话或者 goalPath 是别的 GOAL → 照旧 blind', () => {
  const d = gwt14()
  const { sessionsDir, procRoot } = gwt14Env()
  // 对照:同一份 GOAL、同一个 sid8 的 mode 行 → 认得出来
  const own = audit([d], { until: GWT_UNTIL, boots: [], sessionsDir, procRoot, ownerLog: ownerLogFile([modeLine()]) })
  assert.notEqual(own.orphans[0].kind, 'blind')
  const otherSid = audit([d], { until: GWT_UNTIL, boots: [], sessionsDir, procRoot, ownerLog: ownerLogFile([modeLine({ sid: 'bbbbbbbb' })]) })
  assert.equal(otherSid.orphans[0].kind, 'blind')
  const otherGoal = audit([d], { until: GWT_UNTIL, boots: [], sessionsDir, procRoot, ownerLog: ownerLogFile([modeLine({ goal: P2 })]) })
  assert.equal(otherGoal.orphans[0].kind, 'blind')
})

test('⑦ GWT-14 时刻:mode 行的时刻不晚于断开时刻加 120 秒 —— 晚 121 秒不算,晚 119 秒算', () => {
  const d = gwt14()
  const { sessionsDir, procRoot } = gwt14Env()
  const late = audit([d], { until: GWT_UNTIL, boots: [], sessionsDir, procRoot, ownerLog: ownerLogFile([modeLine({ at: '2026-10-12T06:29:08.000Z' })]) })
  assert.equal(late.orphans[0].kind, 'blind')
  const ok = audit([d], { until: GWT_UNTIL, boots: [], sessionsDir, procRoot, ownerLog: ownerLogFile([modeLine({ at: '2026-10-12T06:29:06.000Z' })]) })
  assert.equal(ok.orphans[0].kind, 'orphan')
})

test('⑦ GWT-14 取文件里最后一行:同一个 <P> 和 sid8,先 running->idle 再 idle->running → 按最后那一行判', () => {
  const d = gwt14()
  const r = judgeGwt(d, ownerLogFile([
    modeLine({ at: '2026-10-12T06:20:00.000Z', from: 'running', to: 'idle' }),
    modeLine({ at: '2026-10-12T06:25:00.000Z', from: 'idle', to: 'running' }),
  ]))
  assert.equal(r.orphans.length, 1)
  assert.equal(r.orphans[0].kind, 'orphan') // 按最后那一行(running):属主不在了
  assert.ok(r.orphans[0].evidence.includes('owner-dead'))
})

test('⑦ GWT-14 坏行跳过:列数不对的行、第 2 列不是 mode 的行都不影响结果', () => {
  const d = gwt14()
  const r = judgeGwt(d, ownerLogFile([
    modeLine({ to: 'running' }),
    '2026-10-12T06:26:30.000Z mode /r /r/docs/plan/10.12/GOAL.md aaaaaaaa 4242 8918298 idle->idle', // 8 列
    '2026-10-12T06:26:40.000Z claim /r /r/docs/plan/10.12/GOAL.md aaaaaaaa 4242 8918298 idle->idle continue', // 第 2 列不是 mode
  ]))
  assert.equal(r.orphans.length, 1)
  assert.equal(r.orphans[0].kind, 'orphan')
  assert.ok(r.orphans[0].evidence.includes('owner-dead'))
})

test('⑦ GWT-14 mode 行带第 10 列(旧 sid8):认得出来,按最后那一行判', () => {
  const d = gwt14()
  const r = judgeGwt(d, ownerLogFile([
    modeLine({ to: 'running' }),
    `${modeLine({ to: 'idle' })} aaaaaaaa`, // 第 10 列是旧 sid8
  ]))
  assert.deepEqual(r.orphans, []) // 最后那一行是 idle → relay 自己停了
})

test('⑦ GWT-14 路径带空格:owner.log 里的 goalPath 把空格写成 %20,判官还原后照样匹配上', () => {
  // 会话记录里的 GOAL 路径和 owner.log 里的是同一条路径的两种写法(空格在 owner.log 里写成 %20)
  const p = '/r/my%20repo/docs/plan/10.23/GOAL.md'
  const d = gwt14(p)
  const r = judgeGwt(d, ownerLogFile([modeLine({ goal: p, to: 'running' })]))
  assert.equal(r.orphans.length, 1)
  assert.equal(r.orphans[0].kind, 'orphan')
  assert.ok(r.orphans[0].evidence.includes('owner-dead'))
  // 还原以后是另一份 GOAL 的路径 → 不匹配,照旧 blind
  const other = judgeGwt(d, ownerLogFile([modeLine({ goal: '/r/my%20other/docs/plan/10.23/GOAL.md', to: 'running' })]))
  assert.equal(other.orphans[0].kind, 'blind')
})

test('⑦ orphans: false 时整段跳过:orphans 是空数组,verdict 三个计数是 0,不影响 pass', () => {
  const d = dir({ bbbbbbbb: [cont('2026-10-13T18:30:00Z'), tool('2026-10-13T18:46:39Z', 1000)] })
  const { sessionsDir, procRoot } = owner()
  const r = audit([d], { until: '2026-10-14T23:59:59Z', boots: [], sessionsDir, procRoot, orphans: false })
  assert.deepEqual(r.orphans, [])
  assert.equal(r.verdict.orphans, 0)
  assert.equal(r.verdict.orphanBlind, 0)
  assert.equal(r.verdict.orphanFalse, 0)
})

test('⑦ 给了 --sessions(only)时,只有范围里的会话会被记成断开;范围外的会话照样拿来判恢复', () => {
  const d = dir({ bbbbbbbb: [cont('2026-10-13T18:30:00Z'), tool('2026-10-13T18:46:39Z', 1000)] })
  const { sessionsDir, procRoot } = owner()
  const base = { until: '2026-10-14T23:59:59Z', boots: [], sessionsDir, procRoot }
  assert.deepEqual(audit([d], { ...base, only: new Set(['aaaaaaaa']) }).orphans, [])
  assert.equal(audit([d], { ...base, only: new Set(['bbbbbbbb']) }).orphans.length, 1)
})
