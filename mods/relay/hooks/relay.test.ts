import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ledger, mmdd } from './goal'

const CWD = '/r'
const NOW = Date.UTC(2026, 9, 10, 9, 0)
const LINE = '多端适配,性能优先'
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 4321 }

const goalMd = (accept: readonly string[]): string =>
  [
    `# GOAL: ${LINE}`,
    '## 原话',
    `> ${LINE}`,
    '## 终点状态',
    '手机和桌面都能用',
    '## 验收',
    ...accept.map(c => `- \`${c}\` → exit 0`),
    '## 清单',
    '- [ ] 修 header',
    '## 抢占规则',
    '- p95 > 300 ms',
    '## 停机条件',
    'done / owner / stuck',
    '## 不许停的情况',
    '整理完不是停机条件',
    '## effort',
    '- plan=xhigh',
    '- build=medium',
    '## 改道账',
  ].join('\n')

type World = { files: Map<string, string>; submits: string[]; notes: string[]; ran: string[][]; efforts: unknown[] }

// Everything beneath the plugin: an in-memory disk, a fork that writes `md`, recorded submits and notifications.
function world(on: On, md: string): World & { clock: ReturnType<typeof mock.clock> } {
  const w: World = { files: new Map([[`${CWD}/CLAUDE.md`, '# repo rules']]), submits: [], notes: [], ran: [], efforts: [] }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  on('session.cwd', async () => ({ value: CWD }))
  on('session.id', async () => ({ value: 'sid-1' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 1000 }, rateLimits: [] } as never }))
  on('fs.read', async (_$, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', async (_$, e) => ({ value: w.files.has(e.path) }))
  on('fs.stat', async (_$, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: text.length, mtimeMs: NOW, isLink: false } as never }
  })
  on('fs.list', async (_$, e) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of w.files.keys()) {
      if (!p.startsWith(`${e.path}/`)) continue
      const [head, ...rest] = p.slice(e.path.length + 1).split('/')
      if (head) names.set(head, rest.length ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: NOW })) as never }
  })
  on('process.run', async (_$, e) => {
    w.ran.push([...e.argv])
    const [cmd, , script] = e.argv
    if (cmd === 'git') return { value: { exitCode: 0, stdout: 'abc123\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } as never }
    if (cmd === 'bash') {
      const fails = script === 'exit 1'
      const stdout = fails ? Array.from({ length: 60 }, (_, i) => `log line ${i + 1}`).join('\n') : 'ok'
      return { value: { exitCode: fails ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } as never }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } as never }
  })
  on('model.fork', async () => ({ value: { isAnswered: true as const, text: md, usage: USAGE } }))
  on('prompt.submit', async (_$, e) => {
    w.submits.push(e.text)
    return { text: e.text } as never
  })
  on('ui.notify', async (_$, e) => {
    w.notes.push(e.text)
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } as never }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('classic.SubagentStart', async () => ({}) as never)
  on('turn.step', async function* (_$, e) {
    w.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: e.model } } as never
  })
  return { ...w, clock }
}

const GOAL_PATH = `${CWD}/docs/plan/${mmdd(NOW)}/GOAL.md`
const turn = (n: number, answer: string) => ({ answer, durationMs: 1000, isAborted: false, turnId: `t${n}`, reason: 'answer' as const })
const CMD = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }

// C-4's mode, read the way the user sees it: /relay status leads with it.
async function modeOf($: Engine): Promise<string> {
  const r = await $.command.run({ command: 'relay', args: 'status', ...CMD })
  return r.text?.match(/^relay:([a-z-]+)/)?.[1] ?? ''
}

async function startGoal($: Engine, w: ReturnType<typeof world>): Promise<void> {
  await $.command.run({ command: 'goal', args: LINE, ...CMD })
  await w.clock.settle()
  await w.clock.settle()
}

describe('relay /goal (INV-13)', () => {
  test('GWT-16: /goal writes GOAL.md with 验收 and 停机条件, activates, and submits one kickoff naming the path', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    const written = w.files.get(GOAL_PATH)
    expect(written).toBeDefined()
    expect(written?.includes('## 验收')).toBe(true)
    expect(written?.includes('## 停机条件')).toBe(true)
    expect((await modeOf($))).toBe('running')
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]?.includes(GOAL_PATH)).toBe(true)
  })

  test('an existing GOAL.md is not overwritten: -2 suffix', async ($, on) => {
    const w = world(on, goalMd(['true']))
    w.files.set(GOAL_PATH, 'old')
    await startGoal($, w)
    expect(w.files.get(GOAL_PATH)).toBe('old')
    expect(w.files.has(GOAL_PATH.replace('GOAL.md', 'GOAL-2.md'))).toBe(true)
  })
})

describe('relay done (INV-2)', () => {
  test('GWT-2: a failing acceptance line keeps running and submits the command and its output tail', async ($, on) => {
    const w = world(on, goalMd(['true', 'exit 1']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '全部做完。\nRELAY: done'))
    await w.clock.settle()
    expect((await modeOf($))).toBe('running')
    expect(w.submits.length).toBe(2)
    const sent = w.submits[1] ?? ''
    expect(sent.includes('`exit 1`')).toBe(true)
    expect(sent.includes('log line 60')).toBe(true)
    expect(sent.includes('log line 10\n')).toBe(false)
    expect(w.notes.length).toBe(0)
  })

  test('GWT-3: all acceptance lines pass: stops, notifies, no further submit', async ($, on) => {
    const w = world(on, goalMd(['true', 'test 1 -eq 1']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '全部做完。\nRELAY: done'))
    await w.clock.settle()
    expect((await modeOf($))).toBe('done')
    expect(w.submits.length).toBe(1)
    expect(w.notes.length).toBe(1)
    expect(w.ran.filter(a => a[0] === 'bash').map(a => a[2])).toEqual(['true', 'test 1 -eq 1'])
  })
})

describe('relay violations (INV-3)', () => {
  test('GWT-4: two answers without RELAY: one nudge, then stop and notify', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '整理了一下进度。'))
    await w.clock.settle()
    expect(w.submits.length).toBe(2)
    expect((await modeOf($))).toBe('running')
    await $.turn.complete(turn(2, '阶段总结如上,要不要继续?'))
    await w.clock.settle()
    expect(w.submits.length).toBe(2)
    expect((await modeOf($))).toBe('waiting-owner')
    expect(w.notes.length).toBe(1)
  })
})

describe('relay owner (INV-4)', () => {
  test('GWT-5: owner stops, notifies with the question, never submits', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '这一步改的是终点本身。\nRELAY: owner 桌面端还要不要做?'))
    await w.clock.settle()
    expect((await modeOf($))).toBe('waiting-owner')
    expect(w.submits.length).toBe(1)
    expect(w.notes[0]?.includes('桌面端还要不要做?')).toBe(true)
  })
})

describe('relay replan (INV-5)', () => {
  test('GWT-6: replan appends one ledger line and submits the next turn', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    const before = ledger(w.files.get(GOAL_PATH) ?? '').length
    await $.turn.complete(turn(1, '发现 p95 回归到 420 ms。\nRELAY: replan 延迟回归 -> 修 p95'))
    await w.clock.settle()
    const after = ledger(w.files.get(GOAL_PATH) ?? '')
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1]?.includes('触发 延迟回归 · → 修 p95')).toBe(true)
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]?.includes('修 p95')).toBe(true)
    expect((await modeOf($))).toBe('running')
  })
})

describe('relay wait (INV-12)', () => {
  test('GWT-14: phase=wait with no runs and no subagents submits「wait 不成立」', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '已派出去了。\nRELAY: continue phase=wait'))
    await w.clock.settle()
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]?.includes('wait 不成立')).toBe(true)
  })

  test('phase=wait with a running subagent arms the heartbeat instead', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await $.turn.complete(turn(1, '等子 agent。\nRELAY: continue phase=wait'))
    await w.clock.settle()
    expect(w.submits.length).toBe(1)
    await w.clock.advance(25 * 60_000)
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]?.includes('心跳')).toBe(true)
  })
})

describe('relay continue', () => {
  test('continue submits 按 GOAL 继续; subagent turns are ignored', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete({ ...turn(1, 'sub'), agentId: 'a9' })
    await w.clock.settle()
    expect(w.submits.length).toBe(1)
    await $.turn.complete(turn(2, 'header 修好,提交 abc。\nRELAY: continue phase=build'))
    await w.clock.settle()
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]?.includes('按 GOAL 继续')).toBe(true)
  })
})

describe('relay effort (INV-9)', () => {
  test('GWT-11: after RELAY: continue phase=build the next turn.step asks for medium', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '计划好了。\nRELAY: continue phase=build'))
    await w.clock.settle()
    const step = $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })
    for await (const _ of step) {
      // drain
    }
    await step.result
    expect(w.efforts[w.efforts.length - 1]).toBe('medium')
  })
})
