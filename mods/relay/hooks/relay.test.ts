import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ledger, mmdd } from './goal'
import { anchorOf } from './parse'

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

// ctx: what the engine answers that a test changes midway — the context size, the session id (another window), and a
// gate that holds `session.usage` open (a person's prompt caught between recording it and cancelling the clear).
// owner: how the fake `node relay/bin/owner.mjs <sub> …` answers (argv after the script); undefined = the default
// (claim / set / mode exit 0, check exit 4: no record). head / revCount: what `git rev-parse HEAD` / `git rev-list` print.
type OwnerReply = { code: number; out?: string }
type Ctx = {
  tokens: number
  sid: string
  gate: Promise<void> | null
  fork: unknown
  forks: number
  completes: number
  head: string
  revCount: string
  owner: (args: string[]) => OwnerReply | undefined
}
type World = {
  files: Map<string, string>
  submits: string[]
  notes: string[]
  ran: string[][]
  efforts: unknown[]
  contexts: string[]
  toasts: string[]
  ctx: Ctx
  // Every owner.mjs call (argv after the script path) and every path $.fs.write wrote, in order.
  owner: string[][]
  writes: string[]
}
// The pid the fake `sh -c 'echo $PPID'` prints: this session's Claude Code process.
const SELF_PID = '4242'
const ownerDefault = (args: string[]): OwnerReply => (args[0] === 'check' ? { code: 4 } : { code: 0 })

// Everything beneath the plugin: an in-memory disk, a fork that writes `md`, recorded submits and notifications.
function world(on: On, md: string, contextTokens = 1000, store?: Record<string, unknown>, env: Record<string, string> = {}): World & { clock: ReturnType<typeof mock.clock> } {
  const ctx: Ctx = { tokens: contextTokens, sid: 'sid-1', gate: null, fork: null, forks: 0, completes: 0, head: 'abc123', revCount: '0', owner: () => undefined }
  const w: World = { files: new Map([[`${CWD}/CLAUDE.md`, '# repo rules']]), submits: [], notes: [], ran: [], efforts: [], contexts: [], toasts: [], ctx, owner: [], writes: [] }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, store)
  mock.env(on, { HOME: '/h', ...env })
  on('session.cwd', async () => ({ value: CWD }))
  on('session.id', async () => ({ value: ctx.sid }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => {
    if (ctx.gate) await ctx.gate
    return { value: { startedAt: 0, context: { tokens: ctx.tokens }, rateLimits: [] } as never }
  })
  on('fs.read', async (_$, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    w.writes.push(e.path)
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', async (_$, e) => ({ value: w.files.has(e.path) }))
  on('fs.stat', async (_$, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    // 交接文件的 mtime 要比 armedAt(真实 Date.now(),mock 时钟不改它)新。
    return { value: { kind: 'file', size: text.length, mtimeMs: e.path.includes('/.claude/handoffs/') ? Date.now() + 1000 : NOW, isLink: false } as never }
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
    const [cmd, sub, script] = e.argv
    const out = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } as never })
    if (cmd === 'sh' && script === 'echo $PPID') return out(0, `${SELF_PID}\n`)
    if (cmd === 'node' && String(sub).endsWith('/bin/owner.mjs')) {
      const args = e.argv.slice(2)
      w.owner.push(args)
      const r = ctx.owner(args) ?? ownerDefault(args)
      return out(r.code, r.out ?? '')
    }
    if (cmd === 'git' && sub === 'rev-parse') return out(0, `${ctx.head}\n`)
    if (cmd === 'git' && sub === 'rev-list') return out(0, `${ctx.revCount}\n`)
    if (cmd === 'git') return { value: { exitCode: 0, stdout: 'abc123\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } as never }
    if (cmd === 'bash') {
      const fails = script === 'exit 1'
      const stdout = fails ? Array.from({ length: 60 }, (_, i) => `log line ${i + 1}`).join('\n') : 'ok'
      return { value: { exitCode: fails ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } as never }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } as never }
  })
  on('model.fork', async () => {
    ctx.forks++
    return { value: (ctx.fork ?? { isAnswered: true as const, text: md, usage: USAGE }) as never }
  })
  on('model.complete', async () => {
    ctx.completes++
    return { value: { isAnswered: true as const, text: md, usage: USAGE } }
  })
  on('prompt.submit', async (_$, e) => {
    w.submits.push(e.text)
    w.contexts.push(...(e.context ?? []))
    return { text: e.text } as never
  })
  on('ui.notify', async (_$, e) => {
    w.notes.push(e.text)
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } as never }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('classic.SubagentStart', async () => ({}) as never)
  on('classic.Stop', async () => ({}) as never)
  on('turn.step', async function* (_$, e) {
    w.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: e.model } } as never
  })
  return { ...w, clock }
}

const GOAL_PATH = `${CWD}/docs/plan/${mmdd(NOW)}/GOAL.md`
const turn = (n: number, answer: string) => ({ answer, durationMs: 1000, isAborted: false, turnId: `t${n}`, reason: 'answer' as const })
const CMD = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }

// C-4's mode, read the way owner sees it: /relay status leads with it.
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

  // 23.10:慢在 fork 还是退回的 complete 待证伪 —— 每次 /goal 记一行:路径、秒数、输入多大、写出来的质量。
  const GLOG = '/h/.claude/handoffs/handoff.log'
  test('每次 /goal 在 handoff.log 记一行:走 fork、用了几秒、prompt 多少字、上下文多大、模板提示与「(待补:」各几处、写到哪', async ($, on) => {
    const w = world(on, goalMd(['true']), 180_000)
    await startGoal($, w)
    const line = (w.files.get(GLOG) ?? '').split('\n').find(l => l.includes(' goal ')) ?? ''
    expect(line).toMatch(new RegExp(`sid-1 goal fork \\d+s prompt \\d+ chars ctx 180k hints \\d+ todo \\d+ ${GOAL_PATH}$`))
  })

  test('刚 /clear 完没有可 fork 的会话:记 complete', async ($, on) => {
    const w = world(on, goalMd(['true']))
    w.ctx.fork = { isAnswered: false, reason: 'nothing-to-fork' }
    await startGoal($, w)
    expect(w.files.get(GLOG) ?? '').toMatch(/ goal complete \d+s prompt \d+ chars ctx 1k /)
  })

  test('模型没写出来:也记一行 goal failed,带路径和秒数', async ($, on) => {
    const w = world(on, goalMd(['true']))
    w.ctx.fork = { isAnswered: false, reason: 'empty-reply', usage: USAGE }
    await startGoal($, w)
    expect(w.files.get(GLOG) ?? '').toMatch(/ goal failed fork \d+s /)
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
    expect(w.files.get(GOAL_PATH)?.includes('## 待 owner')).toBe(false)
  })
})

describe('relay owner (INV-4)', () => {
  test('GWT-5: owner on the only item: parked, then stops (nothing else to do) and the notice carries the question', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '这一步改的是终点本身。\nRELAY: owner 桌面端还要不要做?'))
    await w.clock.settle()
    expect((await modeOf($))).toBe('waiting-owner')
    expect(w.submits.length).toBe(1)
    expect(w.notes[0]?.includes('桌面端还要不要做?')).toBe(true)
  })
})

// 19.10:lead 停在「你定了以后」上,工厂空转到早上。owner 改成挂单续跑,只有剩下的活全在等 owner 才停。
describe('relay 待 owner (19.10)', () => {
  const items = (md: string, list: readonly string[]) => md.replace('- [ ] 修 header', list.map(i => `- [ ] ${i}`).join('\n'))

  test('① owner 不停:问题连推荐挂进「待 owner」,挡住的项打 ⏸,续跑下一项,不通知', async ($, on) => {
    const w = world(on, items(goalMd(['true']), ['合 S9c', '合 T3']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '分级口径是业务取舍。\nRELAY: owner 字面级条目拦不拦合并 | 推荐: 行为级才拦,字面级只记台账'))
    await w.clock.settle()
    const md = w.files.get(GOAL_PATH) ?? ''
    expect(md).toContain('## 待 owner\n- [ ] #1 字面级条目拦不拦合并 · 推荐:行为级才拦,字面级只记台账 · 挡住:合 S9c')
    expect(md).toContain('- [ ] 合 S9c ⏸#1')
    expect((await modeOf($))).toBe('running')
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]).toContain('接着做下一项:合 T3')
    expect(w.notes.length).toBe(0)
  })

  test('② 剩下的项全都挂在「待 owner」上才停,通知里是汇总:每件带推荐', async ($, on) => {
    const w = world(on, items(goalMd(['true']), ['合 S9c', '合 T3']))
    await startGoal($, w)
    await $.turn.complete(turn(1, 'x\nRELAY: owner 字面级拦不拦 | 推荐: 只记台账'))
    await w.clock.settle()
    await $.turn.complete(turn(2, 'y\nRELAY: owner P3 锁序改不改 | 推荐: 采纳,拿不到锁立刻 409'))
    await w.clock.settle()
    expect((await modeOf($))).toBe('waiting-owner')
    expect(w.submits.length).toBe(2)
    expect(w.notes.length).toBe(1)
    const note = w.notes[0] ?? ''
    expect(note).toContain('要你定的 2 件')
    expect(note).toContain('#1 字面级拦不拦\n   推荐:只记台账')
    expect(note).toContain('#2 P3 锁序改不改\n   推荐:采纳,拿不到锁立刻 409')
  })

  test('② 不空转:最后一项上停在问句(没写 RELAY),一次提醒后挂单并停,不再催', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, 'A. 先拦行为级\nB. 全拦'))
    await w.clock.settle()
    expect(w.submits.length).toBe(2)
    await $.turn.complete(turn(2, 'A. 先拦行为级\nB. 全拦\nRELAY: continue phase=build'))
    await w.clock.settle()
    expect((await modeOf($))).toBe('waiting-owner')
    expect(w.submits.length).toBe(2)
    expect(w.files.get(GOAL_PATH)).toContain('- [ ] 修 header ⏸#1')
    await w.clock.settle()
    expect(w.submits.length).toBe(2)
  })

  test('② 不空转:还有别的项时,同一个已挂单的问题反复问,每次只挡住当前项,项挡完就停', async ($, on) => {
    const w = world(on, items(goalMd(['true']), ['A', 'B', 'C']))
    await startGoal($, w)
    for (let i = 1; i <= 3; i++) {
      await $.turn.complete(turn(i, `z\nRELAY: owner 同一件事 | 推荐: 甲`))
      await w.clock.settle()
    }
    expect((await modeOf($))).toBe('waiting-owner')
    expect(w.submits.length).toBe(3)
    const md = w.files.get(GOAL_PATH) ?? ''
    expect(md.match(/#1 同一件事/g)?.length).toBe(1)
    expect(md).toContain('- [ ] C ⏸#1')
    expect(w.notes[0]).toContain('要你定的 1 件')
  })

  test('③ 验收全过时,汇总里带上没答的「待 owner」', async ($, on) => {
    const w = world(on, items(goalMd(['true']), ['合 S9c', '合 T3']))
    await startGoal($, w)
    await $.turn.complete(turn(1, 'x\nRELAY: owner 字面级拦不拦 | 推荐: 只记台账'))
    await w.clock.settle()
    await $.turn.complete(turn(2, 'T3 合了。\nRELAY: done'))
    await w.clock.settle()
    expect((await modeOf($))).toBe('done')
    expect(w.notes.length).toBe(1)
    expect(w.notes[0]).toContain('验收全过')
    expect(w.notes[0]).toContain('#1 字面级拦不拦\n   推荐:只记台账')
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
    await w.clock.advance(3_000) // 判「wait 不成立」前有 3 s 宽限(Stop 的 background_tasks 可能晚到)
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

// 12.10:独占量测跑在后台 shell 里,relay 只认 omd-lite / 子 agent,每轮都回「wait 不成立」、刷屏。
// Stop 钩子带的 background_tasks(shell / monitor)也算在等;交接的 clear 不被它们挡。
describe('relay wait on background shells / monitors (12.10)', () => {
  const stop = (tasks: Array<{ type: string; status: string; description: string }>) =>
    ({ stop_hook_active: false, background_tasks: tasks.map((t, i) => ({ id: `b${i}`, ...t })) }) as never

  test('a running background shell holds phase=wait: heartbeat, no「wait 不成立」', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.classic.Stop(stop([{ type: 'shell', status: 'running', description: '发版档性能闸' }]))
    await $.turn.complete(turn(1, '量测在后台 shell 里跑。\nRELAY: continue phase=wait'))
    await w.clock.settle()
    expect(w.submits.length).toBe(1)
    await w.clock.advance(25 * 60_000)
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]?.includes('心跳')).toBe(true)
  })

  test('the Stop that lists the shell landing just after turn.complete still holds the wait (grace)', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '刚起了后台量测。\nRELAY: continue phase=wait'))
    await $.classic.Stop(stop([{ type: 'monitor', status: 'running', description: '量测进度' }]))
    await w.clock.settle()
    expect(w.submits.length).toBe(1)
  })

  test('only finished / non-shell tasks → still「wait 不成立」', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.classic.Stop(stop([{ type: 'shell', status: 'completed', description: '旧命令' }, { type: 'subagent', status: 'running', description: 'x' }]))
    await $.turn.complete(turn(1, '等。\nRELAY: continue phase=wait'))
    await w.clock.settle()
    await w.clock.advance(3_000) // 判「wait 不成立」前有 3 s 宽限(Stop 的 background_tasks 可能晚到)
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]?.includes('wait 不成立')).toBe(true)
  })
})

// 10.11:SubagentStart 记了、SubagentStop 没来(被杀 / 压缩前结束)的 id 永远留在账上,交接卡了 4 小时。
// 引擎自己的 $.agent.list() 是真源,账只在读不到它时兜底。
describe('relay live agents (engine list over the ledger)', () => {
  const agentList = (on: On, rows: Array<{ id: string; status: string }>) =>
    on('agent.list', async () => ({ value: rows.map(r => ({ ...r, type: 'general-purpose' })) as never }))

  test('a ledger id the engine reports completed does not hold phase=wait', async ($, on) => {
    const w = world(on, goalMd(['true']))
    agentList(on, [{ id: 'a1', status: 'completed' }])
    await startGoal($, w)
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await $.turn.complete(turn(1, '等子 agent。\nRELAY: continue phase=wait'))
    await w.clock.settle()
    await w.clock.advance(3_000) // 判「wait 不成立」前有 3 s 宽限(Stop 的 background_tasks 可能晚到)
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]?.includes('wait 不成立')).toBe(true)
  })

  test('an agent the engine reports running holds phase=wait even with no SubagentStart seen', async ($, on) => {
    const w = world(on, goalMd(['true']))
    agentList(on, [{ id: 'a2', status: 'running' }])
    await startGoal($, w)
    await $.turn.complete(turn(1, '等子 agent。\nRELAY: continue phase=wait'))
    await w.clock.settle()
    expect(w.submits.length).toBe(1)
  })

  test('a subagent the engine reports waiting (result delivered, leftover background work) does not hold phase=wait', async ($, on) => {
    const w = world(on, goalMd(['true']))
    agentList(on, [{ id: 'a4', status: 'waiting' }])
    await startGoal($, w)
    await $.turn.complete(turn(1, '等子 agent。\nRELAY: continue phase=wait'))
    await w.clock.settle()
    await w.clock.advance(3_000) // 判「wait 不成立」前有 3 s 宽限(Stop 的 background_tasks 可能晚到)
    expect(w.submits[1]?.includes('wait 不成立')).toBe(true)
  })

  test('/relay status shows the handoff phase and the live subagent count', async ($, on) => {
    const w = world(on, goalMd(['true']))
    agentList(on, [{ id: 'a2', status: 'running' }, { id: 'a3', status: 'failed' }])
    await startGoal($, w)
    const r = await $.command.run({ command: 'relay', args: 'status', ...CMD })
    expect(r.text).toContain('交接 idle')
    expect(r.text).toContain('在跑子 agent 1')
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

// G-5 / G-9 (S10): relay reads `$.delegate`, not the run dirs. /ops is cross-session (allRuns), the handoff is this session's (runs).
// A hooks module is compiled on its own, so a stub cannot close over the test's data: each scenario's runs are literals in its register.
const mineAndOthers = {
  name: 'delegate',
  register(on: On) {
    on('engine.create', async (_, e, next) => ({
      ...(await next(e)),
      delegate: {
        runs: async () => [{ label: 'mine-1', state: 'running' }],
        allRuns: async () => [
          { label: 'mine-1', state: 'running' },
          { label: 'theirs-9', state: 'running' },
          { label: 'theirs-done', state: 'pass' },
        ],
      },
    }) as never)
  },
}
const onlyOthers = {
  name: 'delegate',
  register(on: On) {
    on('engine.create', async (_, e, next) => ({
      ...(await next(e)),
      delegate: { runs: async () => [], allRuns: async () => [{ label: 'theirs-9', state: 'running' }] },
    }) as never)
  },
}
const redispatched = {
  name: 'delegate',
  register(on: On) {
    on('engine.create', async (_, e, next) => ({
      ...(await next(e)),
      delegate: {
        runs: async () => [
          { label: 'a', state: 'fail', failureClass: 'provider' },
          { label: 'a-p2', state: 'running', round: 1, maxRounds: 4 },
          { label: 'b-p2', state: 'fail', failureClass: 'provider' },
          { label: 'c', state: 'fail', failureClass: 'provider' },
          { label: 'd', state: 'pass' },
        ],
        allRuns: async () => [],
      },
    }) as never)
  },
}
// 交接 note 的原文:非 GOAL 会话里由 /relay go 单独提交(方案 A),note 就是那条 prompt 的正文。
const handoffContext = async ($: Engine, w: ReturnType<typeof world>): Promise<string> => {
  await $.prompt.submit({ text: '继续', origin: { kind: 'composer' } } as never)
  await $.command.run({ command: 'relay', args: 'go', ...CMD })
  await w.clock.settle()
  return [...w.submits, ...w.contexts].join('\n')
}

const HANDOFF = '/h/.claude/handoffs/r-sid-1.md'
// 把交接推到 ready(自动交接只在 GOAL 期间):owner 一条人话 → GOAL 开跑,600k 上下文下 relay 的开工 prompt → armed(auto);
// 交接文件写好、首行是 owner 那条的锚点;答 HANDOFF-READY。
async function ready($: Engine, on: On, agentRows: Array<{ id: string; type: string; status: string }> = [], started = false) {
  const w = world(on, goalMd(['true']), 600_000)
  if (started) on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  if (agentRows.length) on('agent.list', async () => ({ value: agentRows as never }))
  const cleared: number[] = []
  on('command.run', async (_$, e, next) => {
    if (e.command === 'clear') {
      cleared.push(Date.now())
      return { text: '' } as never
    }
    return next(e)
  })
  if (started) await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.prompt.submit({ text: '继续', origin: { kind: 'composer' } } as never)
  await startGoal($, w)
  w.files.set(HANDOFF, `relay-anchor: ${anchorOf('继续')}\n# handoff`)
  await $.turn.complete(turn(1, '写好了。\nHANDOFF-READY'))
  return { w, cleared }
}
// clear 走完后,新 session 收到的那条续跑 prompt。
const resumePromptOf = (w: World): string => w.submits[w.submits.length - 1] ?? ''

describe('relay reads $.delegate (S10, G-5 / G-9)', () => {
  test('/ops lists another session\'s running run (allRuns); the handoff note does not (runs)', { plugins: [mineAndOthers] }, async ($, on) => {
    const w = world(on, goalMd(['true']), 600_000)
    const ops = await $.command.run({ command: 'ops', args: '', ...CMD })
    expect(ops.text).toContain('在跑的 run(所有 session,2)')
    expect(ops.text).toContain('mine-1')
    expect(ops.text).toContain('theirs-9')
    expect(ops.text).not.toContain('theirs-done')
    const ctx = await handoffContext($, w)
    expect(ctx).toContain('HANDOFF-READY')
    expect(ctx).toContain('mine-1 · running')
    expect(ctx).not.toContain('theirs-9')
  })

  test('the handoff note carries the redispatch state: a -p2 that took over, a second failure, a run with none', { plugins: [redispatched] }, async ($, on) => {
    const w = world(on, goalMd(['true']), 600_000)
    const ctx = await handoffContext($, w)
    expect(ctx).toContain('a · fail · provider  → 已自动重派为 a-p2(running)')
    expect(ctx).toContain('a-p2 · running · 第 1/4 轮')
    expect(ctx).toContain('b-p2 · fail · provider  → 自动重派的结果,同一 label 不再自动重派')
    expect(ctx).toContain('c · fail · provider  → provider 失败,没有 -p2 重派')
    expect(ctx.indexOf('a-p2 · running')).toBeLessThan(ctx.indexOf('a · fail'))
  })

  test('no delegate: /ops and the handoff say so; nothing reads ~/.omd-lite/runs', async ($, on) => {
    const w = world(on, goalMd(['true']), 600_000)
    w.files.set('/h/.omd-lite/runs/x/meta.json', JSON.stringify({ claude_session: 'sid-1' }))
    const ops = await $.command.run({ command: 'ops', args: '', ...CMD })
    expect(ops.text).toContain('读不到(delegate 没装或没启用)')
    expect(ops.text).not.toContain('x')
    expect(await handoffContext($, w)).toContain('读不到(delegate 没装或没启用)')
  })

  test('phase=wait counts this session\'s running runs from delegate (not other sessions\')', { plugins: [mineAndOthers] }, async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '等 run。\nRELAY: continue phase=wait'))
    await w.clock.settle()
    expect(w.submits.length).toBe(1)
    await w.clock.advance(25 * 60_000)
    expect(w.submits[1]?.includes('心跳')).toBe(true)
  })

  test('phase=wait with only another session\'s run running is still「wait 不成立」', { plugins: [onlyOthers] }, async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '等 run。\nRELAY: continue phase=wait'))
    await w.clock.settle()
    await w.clock.advance(3_000)
    expect(w.submits[1]?.includes('wait 不成立')).toBe(true)
  })
})

// 13.10:HANDOFF-READY 之后,Monitor / 后台任务通知每分钟起一轮 turn,turnRunning 反复为真,clear 一直等不到安静。
// 只有人敲的字起的轮(及子 agent 在跑)才算「不安静」;task-notification 起的轮不算。
describe('relay handoff clear vs. background-event turns (13.10)', () => {
  const monitorTurn = async ($: Engine, n: number) => {
    await $.prompt.submit({ text: 'Monitor 事件', origin: { kind: 'task-notification' } } as never)
    await $.turn.start({ turnId: `m${n}` } as never)
  }

  test('① a turn started by a task-notification after HANDOFF-READY does not hold the clear', async ($, on) => {
    const { w, cleared } = await ready($, on)
    await monitorTurn($, 1)
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(1)
  })

  test('② a turn started by the person after HANDOFF-READY still cancels / holds the clear', async ($, on) => {
    const { w, cleared } = await ready($, on)
    await $.prompt.submit({ text: '等一下', origin: { kind: 'composer' } } as never)
    await $.turn.start({ turnId: 'u1' } as never)
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(0)
  })

  // 30.10:owner 在倒计时里说话 → 取消;之后模型照写 HANDOFF-READY,什么都不发生,模型误以为是末行冲突。
  test('②b HANDOFF-READY after the countdown was cancelled says so and names /relay go', async ($, on) => {
    const { w, cleared } = await ready($, on)
    await $.prompt.submit({ text: '等一下', origin: { kind: 'composer' } } as never)
    await $.turn.start({ turnId: 'u1' } as never)
    await $.turn.complete(turn(2, '交接写好了。\nHANDOFF-READY\nRELAY: continue phase=chore'))
    await w.clock.settle()
    expect(cleared.length).toBe(0)
    expect(w.toasts.some(t => t.includes('已取消') && t.includes('/relay go'))).toBe(true)
  })

  test('③ a running subagent still holds the clear, even when only task-notification turns run', async ($, on) => {
    const { w, cleared } = await ready($, on, [{ id: 'a9', type: 'general-purpose', status: 'running' }])
    await monitorTurn($, 1)
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(0)
  })
})

// F 稿 ④(10.24):board 第 2 行画交接倒计时,读 `$.relay.handoff()`;按钮跑 /relay cancel 与 /relay now。
const peek = {
  name: 'peek',
  register(on: On) {
    on('command.run', { command: 'peekrelay' }, async $ => ({ text: JSON.stringify(await ($ as unknown as { relay: { handoff: () => Promise<unknown> } }).relay.handoff()) }))
  },
}
const noun = ($: Engine) => ({ handoff: async () => JSON.parse((await $.command.run({ command: 'peekrelay', args: '', ...CMD })).text) as { phase: string; clearAt: number; stage: string } })
describe('relay handoff noun + cancel / now (F ④)', () => {
  test('ready: handoff() carries phase and the clear time 30 s out', { plugins: [peek] }, async ($, on) => {
    const t0 = Date.now()
    const { w } = await ready($, on, [], true)
    await w.clock.settle()
    const h = await noun($).handoff()
    expect(h.phase).toBe('ready')
    expect(h.clearAt - t0).toBeGreaterThanOrEqual(29_000)
    expect(h.clearAt - t0).toBeLessThanOrEqual(31_000)
  })
  test('/relay cancel: back to idle, no clear', { plugins: [peek] }, async ($, on) => {
    const { w, cleared } = await ready($, on, [], true)
    await w.clock.settle()
    expect((await noun($).handoff()).phase).toBe('ready')
    await $.command.run({ command: 'relay', args: 'cancel', ...CMD })
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(0)
    expect((await noun($).handoff()).phase).toBe('idle')
  })
  test('/relay now: clears without waiting out the 30 s', async ($, on) => {
    const { w, cleared } = await ready($, on, [], true)
    await $.command.run({ command: 'relay', args: 'now', ...CMD })
    await w.clock.advance(1000)
    await w.clock.settle()
    expect(cleared.length).toBe(1)
  })
})

// S6: relay 的 /clear 交接改读 continuity 的 checkpoint(17.10:旧 omd writer 的 provider 表里没有 minimax-cp,
// 近 7 天 37 份 checkpoint 里 18 份首行是 DEGRADED)。continuity 的 latest/flush 走 `$.continuity`。
// A hooks module is compiled on its own, so a stub cannot close over the test's data:每个场景把答案写成替身
// 自己 body 里的字面量,并把 relay 传进来的 session id 编进路径,让新 session 收到的 prompt 反证它读的是本 session。
const contOk = {
  name: 'continuity',
  register(on: On) {
    on('engine.create', async (_, e, next) => ({
      ...(await next(e)),
      continuity: {
        latest: async (sessionId: string) => ({ path: `/new/ck.md#${sessionId}`, degraded: false }),
        // ok 只在 relay 传的是本 session id 时才为真:补存失败的 toast 不出现即证明这一点。
        flush: async (sessionId: string) => ({ ok: sessionId === 'sid-1', path: '/new/ck.md' }),
        // 缓存 v2 切片 3:自动交接改走 flushStart(flush 已不被调用)。startedAt 0:checkpoint 一在就算写完。
        flushStart: async (sessionId: string) => ({ ok: sessionId === 'sid-1', path: '/new/ck.md', startedAt: 0 }),
      },
    }) as never)
  },
}
const contDegraded = {
  name: 'continuity',
  register(on: On) {
    on('engine.create', async (_, e, next) => ({
      ...(await next(e)),
      continuity: {
        latest: async (sessionId: string) => ({ path: `/new/ck.md#${sessionId}`, degraded: true }),
        flush: async () => ({ ok: true, path: '/new/ck.md' }),
      },
    }) as never)
  },
}

describe('relay reads $.continuity (S6)', () => {
  const writerRuns = (w: World): string[][] => w.ran.filter(a => a.join(' ').includes('session-writer'))

  test('the clear handoff flushes and reads the checkpoint through continuity, not the old omd writer', { plugins: [contOk] }, async ($, on) => {
    const { w, cleared } = await ready($, on)
    w.files.set('/new/ck.md', '# checkpoint')
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(1)
    const p = resumePromptOf(w)
    expect(p).toContain('continuity checkpoint /new/ck.md#sid-1')
    expect(p).not.toContain('.omd/projects')
    expect(p).not.toContain('降级版')
    expect(w.toasts.filter(t => t.includes('补存没成功'))).toEqual([])
    expect(writerRuns(w)).toEqual([])
  })

  test('a degraded checkpoint reaches the new session marked「只信交接」', { plugins: [contDegraded] }, async ($, on) => {
    const { w, cleared } = await ready($, on)
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(1)
    const p = resumePromptOf(w)
    expect(p).toContain('continuity checkpoint /new/ck.md#sid-1')
    expect(p).toContain('(这份是降级版,只信交接,别拿它当事实)')
  })

  test('no continuity installed: the handoff still completes, the prompt just has no checkpoint', async ($, on) => {
    const { w, cleared } = await ready($, on)
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(1)
    expect(resumePromptOf(w)).not.toContain('checkpoint')
    expect(w.toasts.filter(t => t.includes('补存没成功')).length).toBe(1)
    expect(writerRuns(w)).toEqual([])
  })
})

// 20.10:夜里的 lead 多半没开 GOAL,19.10 的两次空等都是这样。没有 GOAL 时 relay 也接住「不是 owner 推的一轮停在问 owner 上」。
describe('relay 没有 GOAL 时的空等兜底 (20.10)', () => {
  const PENDING = '/h/.claude/relay/待owner-r.md'
  const wake = async ($: Engine, w: ReturnType<typeof world>, n: number, answer: string) => {
    await $.prompt.submit({ text: `${n} 个 run 结束`, origin: { kind: 'task-notification' } } as never)
    await $.turn.complete(turn(n, answer))
    await w.clock.settle()
  }

  test('叫醒推的一轮停在「你定了以后」上:提醒一次,不挂单,不通知', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await wake($, w, 1, '备选 B:字面级不拦。\n\n你定了以后,我依次合 S9c、gate-preflight、b1。')
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]).toContain('RELAY: owner')
    expect(w.submits[1]).toContain(PENDING)
    expect(w.files.has(PENDING)).toBe(false)
    expect(w.notes.length).toBe(0)
  })

  test('提醒后还停在问句上:不再催,问句挂进待 owner 汇总并通知', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await wake($, w, 1, '要不要接着合 b1?')
    await wake($, w, 2, '还是要你定:要不要接着合 b1?')
    expect(w.submits.length).toBe(3)
    expect(w.files.get(PENDING)).toContain('- [ ] #1 还是要你定:要不要接着合 b1? · 推荐:(没写推荐)')
    expect(w.notes.length).toBe(1)
    expect(w.notes[0]).toContain(PENDING)
  })

  test('RELAY: owner 带推荐:挂进待 owner 汇总,通知里有推荐,不提交', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await wake($, w, 1, '其余三片已合。\nRELAY: owner 字面级条目拦不拦合并 | 推荐: 行为级才拦,字面级只记台账')
    expect(w.submits.length).toBe(1)
    expect(w.files.get(PENDING)).toContain('## 待 owner\n- [ ] #1 字面级条目拦不拦合并 · 推荐:行为级才拦,字面级只记台账')
    expect(w.notes[0]).toContain('#1 字面级条目拦不拦合并\n   推荐:行为级才拦,字面级只记台账')
  })

  test('owner 自己敲的一轮反问他:不管', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await $.prompt.submit({ text: '看看这个', origin: { kind: 'composer' } } as never)
    await $.turn.complete(turn(1, '你选哪个?'))
    await w.clock.settle()
    expect(w.submits.length).toBe(1)
    expect(w.notes.length).toBe(0)
  })

  test('陈述收尾不管;一次正常收尾后,下一次问句重新从提醒开始', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await wake($, w, 1, '要不要接着合 b1?')
    await wake($, w, 2, '三片已合,main = abc,闸 PASS。')
    await wake($, w, 3, '要不要接着合 b2?')
    expect(w.submits.length).toBe(5)
    expect(w.files.has(PENDING)).toBe(false)
  })
})

// 11.01 契约 D-14 / GWT-10:单会话(环境有 TICKET_ID)里空等兜底不写待 owner 文件,提醒改成 `ticket report`。
describe('relay 单会话的空等兜底 (D-14)', () => {
  const PENDING = '/h/.claude/relay/待owner-r.md'
  const wake = async ($: Engine, w: ReturnType<typeof world>, n: number, answer: string) => {
    await $.prompt.submit({ text: `${n} 个 run 结束`, origin: { kind: 'task-notification' } } as never)
    await $.turn.complete(turn(n, answer))
    await w.clock.settle()
  }
  const inTicket = (on: On) => world(on, goalMd(['true']), 1000, undefined, { TICKET_ID: 'T1' })

  test('GWT-10 停在问 owner 的句子上:不写待 owner 文件,提醒含 ticket report', async ($, on) => {
    const w = inTicket(on)
    await wake($, w, 1, '备选 B:字面级不拦。\n\n你定了以后,我依次合 S9c、gate-preflight、b1。')
    expect(w.files.has(PENDING)).toBe(false)
    expect(w.writes.some(p => p.includes('待owner-'))).toBe(false)
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]).toContain('ticket report T1 --status needs-lead')
    expect(w.submits[1]).toContain('needs-owner')
    expect(w.submits[1]).not.toContain(PENDING)
    expect(w.notes.length).toBe(0)
  })

  test('RELAY: owner 行也不挂进待 owner 文件,改提醒 ticket report', async ($, on) => {
    const w = inTicket(on)
    await wake($, w, 1, '其余三片已合。\nRELAY: owner 字面级条目拦不拦合并 | 推荐: 行为级才拦')
    expect(w.files.has(PENDING)).toBe(false)
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]).toContain('ticket report T1')
    expect(w.notes.length).toBe(0)
  })

  test('提醒过一次还在问:不再提醒,也不写文件、不通知;提醒后正常收尾,下一次问句重新提醒', async ($, on) => {
    const w = inTicket(on)
    await wake($, w, 1, '要不要接着合 b1?')
    await wake($, w, 2, '三片已合,main = abc,闸 PASS。')
    await wake($, w, 3, '要不要接着合 b2?')
    expect(w.submits.length).toBe(5)
    expect(w.submits[4]).toContain('ticket report T1')
    await wake($, w, 4, '还是要你定:要不要接着合 b2?')
    await wake($, w, 5, '还是要你定:要不要接着合 b2?')
    expect(w.submits.length).toBe(7)
    expect(w.files.has(PENDING)).toBe(false)
    expect(w.notes.length).toBe(0)
  })

  test('没有 TICKET_ID 时照旧提醒 RELAY: owner 并指向待 owner 文件', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await wake($, w, 1, '要不要接着合 b1?')
    expect(w.submits[1]).toContain(PENDING)
    expect(w.submits[1]).not.toContain('ticket report')
  })
})

// 20.10 Opus 复审 A1–A4 与计数停法的回归。
describe('relay 待 owner 复审回归 (20.10)', () => {
  const PENDING = '/h/.claude/relay/待owner-r.md'
  const items = (md: string, list: readonly string[]) => md.replace('- [ ] 修 header', list.map(i => `- [ ] ${i}`).join('\n'))
  const wake = async ($: Engine, w: ReturnType<typeof world>, n: number, answer: string) => {
    await $.prompt.submit({ text: `${n} 个 run 结束`, origin: { kind: 'task-notification' } } as never)
    await $.turn.complete(turn(n, answer))
    await w.clock.settle()
  }

  test('A1 没有 GOAL:挂进文件之后,同一夜再被叫醒还在问,不再提醒也不再通知;owner 敲字后重新开始', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await wake($, w, 1, '要不要接着合 b1?')
    await wake($, w, 2, '还是要你定:要不要接着合 b1?')
    await wake($, w, 3, '还是要你定:要不要接着合 b1?')
    await wake($, w, 4, '还是要你定:要不要接着合 b1?')
    expect(w.submits.length).toBe(5)
    expect(w.notes.length).toBe(1)
    await $.prompt.submit({ text: '先合', origin: { kind: 'composer' } } as never)
    await $.turn.complete(turn(5, '合了。'))
    await w.clock.settle()
    await wake($, w, 6, '要不要接着合 b2?')
    expect(w.submits.length).toBe(8)
    expect(w.submits[7]).toContain('RELAY: owner')
  })

  test('A2 owner 把待 owner #1 勾掉后,被它挡住的项回到清单', async ($, on) => {
    const w = world(on, items(goalMd(['true']), ['合 S9c', '合 T3']))
    await startGoal($, w)
    await $.turn.complete(turn(1, 'x\nRELAY: owner 字面级拦不拦 | 推荐: 只记台账'))
    await w.clock.settle()
    const md = (w.files.get(GOAL_PATH) ?? '').replace('- [ ] #1 字面级拦不拦', '- [x] #1 字面级拦不拦')
    w.files.set(GOAL_PATH, md)
    await $.turn.complete(turn(2, 'T3 合了。\nRELAY: continue phase=build'))
    await w.clock.settle()
    expect(w.submits[w.submits.length - 1]).toContain('当前项:合 S9c')
  })

  test('A2 owner 回复时,提示 lead 把答了的待 owner 项勾掉', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, 'x\nRELAY: owner 字面级拦不拦 | 推荐: 只记台账'))
    await w.clock.settle()
    expect((await modeOf($))).toBe('waiting-owner')
    await $.prompt.submit({ text: '按推荐', origin: { kind: 'composer' } } as never)
    expect(w.contexts.some(c => c.includes('待 owner') && c.includes('[x]'))).toBe(true)
  })

  test('A3 GOAL 停在等 owner 时,叫醒推的一轮还在问:兜底不接管,不另记文件,不多通知', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, 'x\nRELAY: owner 字面级拦不拦 | 推荐: 只记台账'))
    await w.clock.settle()
    const before = { s: w.submits.length, n: w.notes.length }
    await wake($, w, 2, '#1 还在等你定。')
    expect(w.submits.length).toBe(before.s + 1)
    expect(w.notes.length).toBe(before.n)
    expect(w.files.has(PENDING)).toBe(false)
  })

  test('A4 问题里带「 · 」:读回来是整句,同一问题不挂第二次', async ($, on) => {
    const w = world(on, items(goalMd(['true']), ['A', 'B', 'C']))
    await startGoal($, w)
    await $.turn.complete(turn(1, 'x\nRELAY: owner 字面级拦不拦 · 行为级呢 | 推荐: 只拦行为级'))
    await w.clock.settle()
    await $.turn.complete(turn(2, 'x\nRELAY: owner 字面级拦不拦 · 行为级呢 | 推荐: 只拦行为级'))
    await w.clock.settle()
    const md = w.files.get(GOAL_PATH) ?? ''
    expect(md.match(/#\d+ 字面级拦不拦/g)?.length).toBe(1)
    expect(md).toContain('行为级呢')
    expect(md).not.toContain('#2 ')
  })

  test('同一个已挂单的问题在 4 项清单上反复问:每次挡住当前项,挡完才停,不提前停', async ($, on) => {
    const w = world(on, items(goalMd(['true']), ['A', 'B', 'C', 'D']))
    await startGoal($, w)
    for (let i = 1; i <= 3; i++) {
      await $.turn.complete(turn(i, 'z\nRELAY: owner 同一件事 | 推荐: 甲'))
      await w.clock.settle()
    }
    expect((await modeOf($))).toBe('running')
    expect(w.submits[w.submits.length - 1]).toContain('接着做下一项:D')
    await $.turn.complete(turn(4, 'z\nRELAY: owner 同一件事 | 推荐: 甲'))
    await w.clock.settle()
    expect((await modeOf($))).toBe('waiting-owner')
  })
})

describe('relay 待 owner 复核回归 C1–C3 (20.10)', () => {
  const PENDING = '/h/.claude/relay/待owner-r.md'
  const wake = async ($: Engine, w: ReturnType<typeof world>, n: number, answer: string) => {
    await $.prompt.submit({ text: `${n} 个 run 结束`, origin: { kind: 'task-notification' } } as never)
    await $.turn.complete(turn(n, answer))
    await w.clock.settle()
  }

  test('C1 清单标题带后缀:照样挡住当前项,续跑下一项', async ($, on) => {
    const w = world(on, goalMd(['true']).replace('## 清单\n- [ ] 修 header', '## 清单(先原型后实装)\n- [ ] A\n- [ ] B'))
    await startGoal($, w)
    await $.turn.complete(turn(1, 'x\nRELAY: owner 字面级拦不拦 | 推荐: 只记台账'))
    await w.clock.settle()
    expect((await modeOf($))).toBe('running')
    expect(w.files.get(GOAL_PATH)).toContain('- [ ] A ⏸#1')
    expect(w.submits[w.submits.length - 1]).toContain('接着做下一项:B')
  })

  test('C2 没有 GOAL:已挂过一件之后,同一夜冒出的新问题照样进文件', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await wake($, w, 1, '要不要接着合 b1?')
    await wake($, w, 2, '还是要你定:要不要接着合 b1?')
    await wake($, w, 3, '还在等你定:P3 锁序改不改?')
    expect(w.submits.length).toBe(4)
    expect(w.files.get(PENDING)).toContain('#2 还在等你定:P3 锁序改不改?')
    expect(w.notes.length).toBe(2)
  })

  test('C3 清单里两项同名:挡住第一项后续跑第二项,不误停', async ($, on) => {
    const w = world(on, goalMd(['true']).replace('- [ ] 修 header', '- [ ] 跑闸\n- [ ] 跑闸\n- [ ] C'))
    await startGoal($, w)
    await $.turn.complete(turn(1, 'x\nRELAY: owner 字面级拦不拦 | 推荐: 只记台账'))
    await w.clock.settle()
    expect((await modeOf($))).toBe('running')
  })
})

// 方案 A(21.10):只在 GOAL / 定时任务期间自动交接并 clear;平时到阈值只提醒,/relay go 手动交接。
// 插件自己记 owner 最后一条原文和之后他没回应的回答,clear 前写旁车 <交接>.last.md,续接 prompt 内联它;
// 交接首行是 owner 最后一条的锚点,clear 前用当时的最后一条重算,对不上不 clear。
describe('relay 交接方案 A (21.10)', () => {
  const LAST = '/h/.claude/handoffs/r-sid-1.last.md'
  const clearSpy = (on: On): number[] => {
    const cleared: number[] = []
    on('command.run', async (_$, e, next) => {
      if (e.command === 'clear') {
        cleared.push(Date.now())
        return { text: '' } as never
      }
      return next(e)
    })
    return cleared
  }
  const say = async ($: Engine, text: string, turnId?: string) =>
    $.prompt.submit({ text, origin: { kind: 'composer' }, ...(turnId ? { turnId } : {}) } as never)
  const status = async ($: Engine): Promise<string> => (await $.command.run({ command: 'relay', args: 'status', ...CMD })).text ?? ''
  const phaseOf = async ($: Engine): Promise<string> => (await $.command.run({ command: 'ops', args: '', ...CMD })).text?.match(/交接阈值 \d+k\(([a-z]+)\)/)?.[1] ?? ''

  const AT400 = { options: { thresholdTokens: 400_000 } }
  // 23.10:owner 在场也自动清。他问一句、答完时 420k、30 秒没动静 → relay 自己提交交接一轮 → HANDOFF-READY 即 clear;
  // 他那句和之后的回答写进旁车文件,续接 prompt 只让新会话把文件发给他,原文不进 prompt。
  test('① 没有 GOAL:owner 问一句,答完 420k,30 秒没动静 → 交接、clear,续接 prompt 只带旁车路径', AT400, async ($, on) => {
    const w = world(on, goalMd(['true']))
    const cleared = clearSpy(on)
    await say($, 'otherapp 的工时表按月还是按周汇总?')
    w.ctx.tokens = 420_000
    await $.turn.complete(turn(1, '按月:会计口径按自然月结,周汇总只在团队负载页用。'))
    await w.clock.settle()
    const before = w.submits.length
    await w.clock.advance(29_000)
    await w.clock.settle()
    expect(w.submits.length).toBe(before)
    await w.clock.advance(2_000)
    await w.clock.settle()
    const anchor = anchorOf('otherapp 的工时表按月还是按周汇总?')
    expect(w.submits.length).toBe(before + 1)
    expect(w.submits[before]).toContain('HANDOFF-READY')
    expect(w.submits[before]).toContain(`relay-anchor: ${anchor}`)
    w.files.set(HANDOFF, `relay-anchor: ${anchor}\n# handoff`)
    await $.turn.complete(turn(2, '交接写好了。\nHANDOFF-READY'))
    await w.clock.settle()
    expect(cleared.length).toBe(1)
    const p = resumePromptOf(w)
    expect(p).not.toContain('按月:会计口径按自然月结,周汇总只在团队负载页用。')
    expect(p).not.toContain('原样贴')
    expect(p.indexOf(`SendUserFile 把 ${LAST}`)).toBeGreaterThanOrEqual(0)
    expect(p.indexOf('SendUserFile')).toBeLessThan(p.indexOf('读交接'))
    // 他不在屏幕前:推一次,让新会话把旁车发给他。
    expect(w.notes.some(t => t.includes('已自动清空'))).toBe(true)
  })

  test('①b 没有 GOAL:答完 420k,30 秒内 owner 又说话 → 不交接;他那一轮答完再等 30 秒才交接', AT400, async ($, on) => {
    const w = world(on, goalMd(['true']))
    clearSpy(on)
    await say($, '先看一下 header')
    w.ctx.tokens = 420_000
    await $.turn.complete(turn(1, 'header 看过了。'))
    await w.clock.advance(10_000)
    await say($, '再看 footer')
    const before = w.submits.length
    await w.clock.advance(25_000)
    await w.clock.settle()
    expect(w.submits.length).toBe(before)
    await $.turn.complete(turn(2, 'footer 也看过了。'))
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(w.submits.length).toBe(before + 1)
    expect(w.submits[before]).toContain(`relay-anchor: ${anchorOf('再看 footer')}`)
  })

  test('①c 未回应的回答一条不丢:owner 一句之后跑了 5 轮,旁车逐字带全部 5 条,续接 prompt 一条不带', AT400, async ($, on) => {
    const w = world(on, goalMd(['true']))
    clearSpy(on)
    await say($, '把五个屏都过一遍')
    for (let i = 1; i <= 5; i++) {
      if (i > 1) await $.prompt.submit({ text: '回执', origin: { kind: 'task-notification' } } as never)
      if (i === 5) w.ctx.tokens = 420_000
      await $.turn.complete(turn(i, `第 ${i} 屏:看过,没有问题。`))
    }
    await w.clock.advance(31_000)
    await w.clock.settle()
    w.files.set(HANDOFF, `relay-anchor: ${anchorOf('把五个屏都过一遍')}\n# handoff`)
    await $.turn.complete(turn(6, '交接写好了。\nHANDOFF-READY'))
    await w.clock.settle()
    const p = resumePromptOf(w)
    const last = w.files.get(LAST) ?? ''
    for (let i = 1; i <= 5; i++) expect(last).toContain(`第 ${i} 屏:看过,没有问题。`)
    for (let i = 1; i <= 5; i++) expect(p).not.toContain(`第 ${i} 屏:看过,没有问题。`)
  })

  test('② GOAL 在跑:owner 自己发的 600k 一轮不注入;下一条 relay 续跑注入,note 带 owner 那条的锚点', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    w.ctx.tokens = 600_000
    await say($, '先把 header 的间距改了')
    expect([...w.contexts, ...w.submits].join('\n')).not.toContain('HANDOFF-READY')
    await $.turn.complete(turn(1, '改了。\nRELAY: continue phase=build'))
    await w.clock.settle()
    // note 跟在续跑 prompt 正文后面(submit 时已 armed);真引擎里 relay 自己的 prompt.submit 钩子也看得到这条,见 ②b。
    const ctx = w.submits[w.submits.length - 1] ?? ''
    expect(ctx).toContain('按 GOAL 继续')
    expect(ctx).toContain('HANDOFF-READY')
    expect(ctx).toContain(`relay-anchor: ${anchorOf('先把 header 的间距改了')}`)
    expect(ctx).not.toContain('先把这条消息处理完')
  })

  test('②b 真引擎里 relay 自己的续跑 prompt 也进它自己的 prompt.submit 钩子(21.10 真机实测):不再追加第二份 note', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    w.ctx.tokens = 600_000
    await say($, '先把 header 的间距改了')
    await $.turn.complete(turn(1, '改了。\nRELAY: continue phase=build'))
    await w.clock.settle()
    const sent = w.submits[w.submits.length - 1] ?? ''
    expect(sent).toContain('HANDOFF-READY')
    const before = w.contexts.length
    await $.prompt.submit({ text: sent, origin: { kind: 'plugin', name: 'relay', asUser: true } } as never)
    expect(w.contexts.slice(before).join('\n')).not.toContain('HANDOFF-READY')
    expect(await phaseOf($)).toBe('armed')
  })

  test('③ auto armed 期间 owner 排队插话,交接里是旧锚点:不 clear,相位回 idle', async ($, on) => {
    const w = world(on, goalMd(['true']))
    const cleared = clearSpy(on)
    await startGoal($, w)
    w.ctx.tokens = 600_000
    await say($, '先把 header 的间距改了')
    await $.turn.complete(turn(1, '改了。\nRELAY: continue phase=build'))
    await w.clock.settle()
    await say($, '等等,footer 也要改', 't2')
    w.files.set(HANDOFF, `relay-anchor: ${anchorOf('先把 header 的间距改了')}\n# handoff`)
    await $.turn.complete(turn(2, '交接写好了。\nHANDOFF-READY'))
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(0)
    expect(await phaseOf($)).toBe('idle')
    expect(w.toasts.some(t => t.includes('不 clear'))).toBe(true)
    // 挡在 HANDOFF-READY 那一刻,没进 ready、没排 clear。
    expect(w.toasts.some(t => t.includes('秒后自动 /clear'))).toBe(false)
  })

  test('④ ready 之后、clear 之前 owner 的最后一条变了(取消还没落下):clear 前重算锚点挡住', async ($, on) => {
    const { w, cleared } = await ready($, on)
    let release = (): void => undefined
    w.ctx.gate = new Promise<void>(r => {
      release = r
    })
    // 人话先记下、取消卡在读上下文大小上:clear 前的锚点重算是这时唯一的闸。
    const pending = say($, '别清,我还在看')
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(0)
    w.ctx.gate = null
    release()
    await pending
  })

  test('⑤ /relay go:交接 prompt 单独提交;对的锚点 + HANDOFF-READY 立即 clear;旁车与续接 prompt 逐字带 owner 最后一条与未回应的回答', async ($, on) => {
    const w = world(on, goalMd(['true']), 600_000)
    const cleared = clearSpy(on)
    await say($, 'figma 原版怎么看所有屏?')
    await $.turn.complete(turn(1, '回答一:在 Pages 面板里逐页看。'))
    await $.prompt.submit({ text: '回执', origin: { kind: 'task-notification' } } as never)
    await $.turn.complete(turn(2, '回答二:三路调研的产物在 /tmp/pen-a.md。'))
    await w.clock.settle()
    const before = w.submits.length
    await $.command.run({ command: 'relay', args: 'go', ...CMD })
    await w.clock.settle()
    const anchor = anchorOf('figma 原版怎么看所有屏?')
    expect(w.submits.length).toBe(before + 1)
    expect(w.submits[before]).toContain(`relay-anchor: ${anchor}`)
    w.files.set(HANDOFF, `relay-anchor: ${anchor}\n# handoff`)
    await $.turn.complete(turn(3, '交接写好了。\nHANDOFF-READY'))
    await w.clock.settle()
    expect(cleared.length).toBe(1)
    const last = w.files.get(LAST) ?? ''
    expect(last).toContain('figma 原版怎么看所有屏?')
    expect(last).toContain('回答一:在 Pages 面板里逐页看。')
    expect(last).toContain('回答二:三路调研的产物在 /tmp/pen-a.md。')
    expect(last).not.toContain('交接写好了')
    const p = resumePromptOf(w)
    expect(p).not.toContain('回答一:在 Pages 面板里逐页看。')
    expect(p.indexOf(`SendUserFile 把 ${LAST}`)).toBeGreaterThanOrEqual(0)
    expect(p.indexOf('SendUserFile')).toBeLessThan(p.indexOf('读交接'))
    expect(p.indexOf('SendUserFile')).toBeLessThan(p.indexOf('等用户拍板'))
    // ⑥ 的手动半边:owner 就在屏幕前,不推手机。
    expect(w.notes.some(t => t.includes('已自动清空'))).toBe(false)
  })

  test('⑤b /relay go 交接首行锚点不对:带 owner 原话回推重写一次;第二次还不对就停下通知,不 clear', async ($, on) => {
    const w = world(on, goalMd(['true']), 600_000)
    const cleared = clearSpy(on)
    await say($, '把 pencil 的屏都列出来')
    await $.command.run({ command: 'relay', args: 'go', ...CMD })
    await w.clock.settle()
    w.files.set(HANDOFF, 'relay-anchor: 000000000000\n# handoff')
    const before = w.submits.length
    await $.turn.complete(turn(1, '交接写好了。\nHANDOFF-READY'))
    await w.clock.settle()
    expect(w.submits.length).toBe(before + 1)
    expect(w.submits[before]).toContain('把 pencil 的屏都列出来')
    expect(w.submits[before]).toContain(`relay-anchor: ${anchorOf('把 pencil 的屏都列出来')}`)
    await $.turn.complete(turn(2, '重写了。\nHANDOFF-READY'))
    await w.clock.settle()
    expect(w.submits.length).toBe(before + 1)
    expect(cleared.length).toBe(0)
    expect(w.notes.some(t => t.includes('仍没接上'))).toBe(true)
    expect(await phaseOf($)).toBe('idle')
  })

  test('⑥ 自动 clear:$.ui.notify 推一次,带旁车路径;续接 prompt 让新会话用 SendUserFile 发它', async ($, on) => {
    const { w, cleared } = await ready($, on)
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(1)
    expect(w.notes.some(t => t.includes('已自动清空') && t.includes(LAST))).toBe(true)
    expect(w.files.get(LAST)).toContain('继续')
    expect(resumePromptOf(w)).toContain(`SendUserFile 把 ${LAST}`)
  })

  test('⑥b GOAL 在等 clear 的 30 秒里停了:不 clear,降为 due 并通知', async ($, on) => {
    const { w, cleared } = await ready($, on)
    await $.command.run({ command: 'relay', args: 'stop', ...CMD })
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(0)
    expect(await phaseOf($)).toBe('due')
    expect(w.notes.some(t => t.includes('/relay go'))).toBe(true)
  })

  test('⑥c /relay go 的交接写到一半 owner 又说话:取消,不 clear', async ($, on) => {
    const w = world(on, goalMd(['true']), 600_000)
    const cleared = clearSpy(on)
    await say($, '把 pencil 的屏都列出来')
    await $.command.run({ command: 'relay', args: 'go', ...CMD })
    await w.clock.settle()
    await say($, '算了先别清', 't9')
    w.files.set(HANDOFF, `relay-anchor: ${anchorOf('把 pencil 的屏都列出来')}\n# handoff`)
    await $.turn.complete(turn(1, '交接写好了。\nHANDOFF-READY'))
    await w.clock.settle()
    expect(cleared.length).toBe(0)
    // 23.10:取消后这一轮答完,仍在 600k,重新等 30 秒安静再交接(不再等上下文多长 100k)。
    expect(await phaseOf($)).toBe('due')
  })

  test('⑦ 子 agent 在跑时 /relay go:note 带它的 id 和任务原文;HANDOFF-READY 也不 clear', async ($, on) => {
    const w = world(on, goalMd(['true']), 600_000)
    const cleared = clearSpy(on)
    on('agent.list', async () => ({ value: [{ id: 'a9', type: 'Explore', description: '查 pencil', status: 'running' }] as never }))
    on('session.messages', async () => ({
      value: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'tu1', tool: 'Agent', input: { description: '查 pencil', prompt: '去查 pencil 画板的全部屏,列出名字' }, agentId: 'a9' }] }] as never,
    }))
    await say($, '把 pencil 的屏都列出来')
    await $.command.run({ command: 'relay', args: 'go', ...CMD })
    await w.clock.settle()
    const note = w.submits[w.submits.length - 1] ?? ''
    expect(note).toContain('a9')
    expect(note).toContain('去查 pencil 画板的全部屏,列出名字')
    w.files.set(HANDOFF, `relay-anchor: ${anchorOf('把 pencil 的屏都列出来')}\n# handoff`)
    await $.turn.complete(turn(1, '交接写好了。\nHANDOFF-READY'))
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(0)
  })

  test('⑧ 多窗口:goal 记录属于另一个 session,不算 auto —— 600k 不注入,只提醒', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    w.ctx.sid = 'sid-2'
    w.ctx.tokens = 600_000
    await $.prompt.submit({ text: '回执', origin: { kind: 'task-notification' } } as never)
    expect(w.contexts.join('\n')).not.toContain('HANDOFF-READY')
    await $.turn.complete(turn(1, '收到。'))
    await w.clock.settle()
    expect(await phaseOf($)).toBe('due')
    expect(await status($)).toContain('交接 due')
  })
})

// 23.10:bcda069e(20.10)READY 时子 agent 全已完成,挡住 clear 的是 owner 经 cue 发的消息 —— relay 不认它是 owner,
// 既不取消也不换锚点,只当「有一轮在跑」一直等。被挡住、放弃都要进 handoff.log。
describe('relay 交接的账 (23.10)', () => {
  const LOG = '/h/.claude/handoffs/handoff.log'
  test('每个 session 开头记一行 start 带 relay 版本:判官只量真跑在新版上的会话', async ($, on) => {
    const w = world(on, goalMd(['true']))
    on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    expect(w.files.get(LOG) ?? '').toMatch(/sid-1 start relay \d+\.\d+\.\d+$/m)
  })

  test('owner 经 cue 发的消息(asUser)在 ready 时取消 clear,并记进 handoff.log', async ($, on) => {
    const { w, cleared } = await ready($, on)
    await $.prompt.submit({ text: '契约我认,合入后按它派片', origin: { kind: 'plugin', name: 'cue', asUser: true } } as never)
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(0)
    expect(w.files.get(LOG) ?? '').toContain('cancelled at ready: owner spoke')
  })

  test('子 agent 挡住 clear:handoff.log 记一行 held(带 id);等满 30 分钟记 gave up(带 id)', async ($, on) => {
    const { w, cleared } = await ready($, on, [{ id: 'a9', type: 'general-purpose', status: 'running' }])
    await w.clock.advance(31_000)
    await w.clock.settle()
    const held = (w.files.get(LOG) ?? '').split('\n').filter(l => l.includes(' held: '))
    expect(held.length).toBe(1)
    expect(held[0]).toContain('a9(running)')
    await w.clock.advance(31 * 60_000)
    await w.clock.settle()
    expect(cleared.length).toBe(0)
    const log = w.files.get(LOG) ?? ''
    expect(log.split('\n').filter(l => l.includes(' held: ')).length).toBe(1)
    expect(log).toMatch(/gave up .*a9\(running\)/)
  })
})

// 23.10 otherapp:/goal 02:08 写 GOAL,cue 02:08:48 起了一轮 /grill;GOAL 约 02:15 写好,开工 prompt 却排到 02:21 这轮结束才发,
// lead 不知道 relay 已写好,02:20 自己又 Write 了一份 GOAL.md。$.prompt.submit 只在空闲时跑:写好时有一轮在跑,
// 激活 note 就跟在这一轮下一次工具调用的结果后面,不再排一条。
describe('relay /goal 写好时有一轮在跑 (23.10)', () => {
  const tools = (on: On): void => {
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  }
  test('激活 note 跟在这一轮下一次工具调用后面,带「别自己写 GOAL.md」;这轮结束不再另发开工 prompt', async ($, on) => {
    const w = world(on, goalMd(['true']))
    tools(on)
    await $.turn.start({ text: '/grill 周日切换', turnId: 't1' } as never)
    await startGoal($, w)
    expect(w.submits.length).toBe(0)
    const r = (await $.tool.call({ tool: 'Bash', command: 'git log -1' } as never)) as { context?: readonly string[] }
    const note = (r.context ?? []).join('\n')
    expect(note).toContain('GOAL 已写好并激活')
    expect(note).toContain(GOAL_PATH)
    expect(note).toContain('不要自己再写')
    const again = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { context?: readonly string[] }
    expect((again.context ?? []).join('\n')).not.toContain('GOAL 已写好并激活')
    await $.turn.complete(turn(1, '审问完了。\nRELAY: continue phase=plan'))
    await w.clock.settle()
    expect(w.submits.some(s => s.includes('GOAL 已写好并激活'))).toBe(false)
  })

  test('这一轮到结束都没再调工具:结束后照旧发开工 prompt', async ($, on) => {
    const w = world(on, goalMd(['true']))
    tools(on)
    await $.turn.start({ text: '随便聊聊', turnId: 't1' } as never)
    await startGoal($, w)
    await $.turn.complete(turn(1, '好的。'))
    await w.clock.settle()
    expect(w.submits.filter(s => s.includes('GOAL 已写好并激活')).length).toBe(1)
  })

  test('没有一轮在跑:照旧直接发开工 prompt', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    expect(w.submits.filter(s => s.includes('GOAL 已写好并激活')).length).toBe(1)
  })
})

// 缓存 v2 切片 3(D-4/D-5/D-7、INV-3/INV-5):冷交接与自动交接都经 `$.continuity.flushStart` 起后台 writer、
// 轮询 checkpoint 的 mtime,不再走 10 秒就被掐断的 flush noun(发现 1、发现 4)。替身经 `$.ui.toast` 报自己被调过。
const contStart = {
  name: 'continuity',
  register(on: On) {
    const n = { flush: 0, flushStart: [] as string[] }
    on('engine.create', async (_, e, next) => ({
      ...(await next(e)),
      continuity: {
        // 计数编进 checkpoint 路径:续跑 prompt 里会带出来,测试从那里读。
        latest: async (sessionId: string) => ({ path: `/new/ck.md#${sessionId}#flush=${n.flush}#flushStart=${n.flushStart.join(',')}`, degraded: false }),
        flush: async () => {
          n.flush++
          return { ok: true, path: '/new/ck.md' }
        },
        flushStart: async (sessionId: string) => {
          n.flushStart.push(sessionId)
          return { ok: true, path: '/new/ck.md', startedAt: 0 }
        },
      },
    }) as never)
  },
}
// 替身的调用计数,从续跑 prompt 里的 checkpoint 路径读出。
const stubCalls = (w: World): string => resumePromptOf(w).match(/#flush=\d+#flushStart=[^\s)]*/)?.[0] ?? ''
// writer 起了但 checkpoint 一直没更新:mtime(NOW)永远不晚于 startedAt。
const contStuck = {
  name: 'continuity',
  register(on: On) {
    on('engine.create', async (_, e, next) => ({
      ...(await next(e)),
      continuity: {
        latest: async (sessionId: string) => ({ path: `/new/ck.md#${sessionId}`, degraded: false }),
        flush: async () => ({ ok: true, path: '/new/ck.md' }),
        flushStart: async () => ({ ok: true, path: '/new/ck.md', startedAt: 9e15 }),
      },
    }) as never)
  },
}
const contRefuse = {
  name: 'continuity',
  register(on: On) {
    on('engine.create', async (_, e, next) => ({
      ...(await next(e)),
      continuity: {
        latest: async (sessionId: string) => ({ path: `/new/ck.md#${sessionId}`, degraded: false }),
        flush: async () => ({ ok: true, path: '/new/ck.md' }),
        flushStart: async () => ({ ok: false, path: '', startedAt: 0 }),
      },
    }) as never)
  },
}

describe('relay 冷交接与自动交接走 flushStart (缓存 v2 切片 3)', () => {
  const LOG = '/h/.claude/handoffs/handoff.log'
  const PLAN = '/h/.claude/mods-state/plan-sid-1.json'
  const cold = (on: On) => {
    const w = world(on, goalMd(['true']))
    const cleared: number[] = []
    on('command.run', async (_$, e, next) => {
      if (e.command === 'clear') {
        cleared.push(Date.now())
        return { text: '' } as never
      }
      return next(e)
    })
    w.files.set('/new/ck.md', '# checkpoint\nCHECKPOINT-BODY 第二段')
    w.files.set(PLAN, '{"title":"PLAN-BODY","steps":[]}')
    return { w, cleared }
  }

  // master 上红:没有 coldhandoff 分支,/relay coldhandoff 落到 status,不调 flushStart 也不 clear。
  test('GWT-6: 冷了点一键交接,fork / complete 0 次,flushStart 1 次', { plugins: [contStart] }, async ($, on) => {
    const { w, cleared } = cold(on)
    await $.command.run({ command: 'relay', args: 'coldhandoff', ...CMD })
    await w.clock.settle()
    await w.clock.advance(20_000)
    await w.clock.settle()
    expect([w.ctx.forks, w.ctx.completes]).toEqual([0, 0])
    expect(stubCalls(w)).toBe('#flush=0#flushStart=sid-1')
    expect(cleared.length).toBe(1)
  })

  // master 上红:没有 coldhandoff,没有超时 toast。
  test('GWT-7: checkpoint mtime 一直不变,10 分钟后不 /clear,出 toast', { plugins: [contStuck] }, async ($, on) => {
    const { w, cleared } = cold(on)
    await $.command.run({ command: 'relay', args: 'coldhandoff', ...CMD })
    await w.clock.settle()
    await w.clock.advance(9 * 60_000)
    await w.clock.settle()
    expect(w.toasts.some(t => t.includes('不 /clear'))).toBe(false)
    await w.clock.advance(2 * 60_000)
    await w.clock.settle()
    expect(cleared.length).toBe(0)
    expect(w.toasts.some(t => t.includes('不 /clear'))).toBe(true)
    expect(w.files.get(LOG) ?? '').toContain('cold not cleared')
  })

  // master 上红:交接文件不存在。
  test('GWT-8: checkpoint 写完,交接文件含 checkpoint 全文、计划文件、git log 段,然后 /clear', { plugins: [contStart] }, async ($, on) => {
    const { w, cleared } = cold(on)
    await $.command.run({ command: 'relay', args: 'coldhandoff', ...CMD })
    await w.clock.settle()
    await w.clock.advance(20_000)
    await w.clock.settle()
    const md = w.files.get(HANDOFF) ?? ''
    expect(md).toContain('# checkpoint\nCHECKPOINT-BODY 第二段')
    expect(md).toContain('{"title":"PLAN-BODY","steps":[]}')
    expect(md).toContain('git log --oneline -10')
    expect(md).toContain('abc123')
    expect(md).toContain('git status --short')
    expect(w.ran.some(a => a[0] === 'git' && a.includes('log') && a.includes('--oneline'))).toBe(true)
    expect(cleared.length).toBe(1)
    expect(w.files.get(LOG) ?? '').toContain('cleared cold')
    expect(w.files.get(LOG) ?? '').toContain('checkpoint=flushed')
  })

  // master 上红:自动交接走 flush noun,flush 计 1、flushStart 没调。
  test('GWT-10: 自动交接用 flushStart,写完后 handoff.log 记 checkpoint=flushed', { plugins: [contStart] }, async ($, on) => {
    const { w, cleared } = await ready($, on)
    w.files.set('/new/ck.md', '# checkpoint')
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(1)
    expect(stubCalls(w)).toBe('#flush=0#flushStart=sid-1')
    expect(w.files.get(LOG) ?? '').toMatch(/cleared auto .* checkpoint=flushed/)
  })

  test('flushStart 返回 ok=false:自动交接照旧 clear,记 checkpoint=old', { plugins: [contRefuse] }, async ($, on) => {
    const { w, cleared } = await ready($, on)
    await w.clock.advance(31_000)
    await w.clock.settle()
    expect(cleared.length).toBe(1)
    expect(w.files.get(LOG) ?? '').toMatch(/cleared auto .* checkpoint=old/)
  })
})

// 10.23 孤儿 GOAL(契约 docs/plan/2026-10-23-relay-orphan-goal.md,切片 4):认领、fencing、resume 拒 done、复活续跑、
// waiting-owner 复活那一轮只重新挂单、owner.log 的 mode 行、复活推送。owner.mjs 走假的 $.process.run。
describe('relay 属主 (孤儿 GOAL 切片 4)', () => {
  const argOf = (args: readonly string[], key: string): string | undefined => {
    const i = args.indexOf(key)
    return i < 0 ? undefined : args[i + 1]
  }
  const calls = (w: World, sub: string): string[][] => w.owner.filter(a => a[0] === sub)
  const modeLines = (w: World): string[][] => calls(w, 'mode')
  const whys = (w: World): string[] => modeLines(w).map(a => argOf(a, '--why') ?? '')
  const goalWrites = (w: World): number => w.writes.filter(p => p === GOAL_PATH).length
  const say = async ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)

  // A waiting-owner GOAL: two items blocked on 待 owner #2 / #3, one still open.
  const WAITING = goalMd(['true'])
    .replace('- [ ] 修 header', '- [ ] 修 header ⏸#2\n- [ ] 合 T3 ⏸#3')
    .concat('\n## 待 owner\n- [ ] #2 桌面端还要不要做 · 推荐:先不做 · 挡住:修 header\n- [ ] #3 T3 要不要拆 · 推荐:不拆 · 挡住:合 T3\n')
  const DEAD_AT = NOW - 2 * 3_600_000
  const saved = (mode: string, sessionId = 'sid-1') => ({
    [`goal:${CWD}`]: {
      mode,
      goal: {
        path: GOAL_PATH,
        title: LINE,
        phase: 'build',
        item: '修 header',
        turns: 3,
        nudges: 0,
        stuckKey: '',
        stuckHead: '',
        stuckCount: 0,
        waitGen: 0,
        efforts: {},
        startedAt: NOW - 3 * 3_600_000,
        sessionId,
        lastEvent: '续跑',
        cwd: CWD,
      },
    },
  })
  const record = (mode: string, pid: number, alive: boolean): OwnerReply => ({
    code: 0,
    out: JSON.stringify({
      record: { cwd: CWD, path: GOAL_PATH, mode, sessionId: 'sid-1', pid, procStart: '777', claimedAt: DEAD_AT - 60_000, lastTurnAt: DEAD_AT, revives: [] },
      alive,
    }),
  })
  // The process restarted under the same session id (`claude --resume <sid>`): session.start with the GOAL in the store.
  async function revived(
    $: Engine,
    on: On,
    mode: 'running' | 'waiting-owner',
    owner: (args: string[]) => OwnerReply | undefined = () => undefined,
  ): Promise<ReturnType<typeof world>> {
    const w = world(on, goalMd(['true']), 1000, saved(mode))
    w.files.set(GOAL_PATH, mode === 'waiting-owner' ? WAITING : goalMd(['true']))
    w.ctx.owner = args => owner(args) ?? (args[0] === 'check' ? record(mode, 1111, false) : undefined)
    on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    await w.clock.settle()
    return w
  }

  test('GWT-3:store 里 mode 是 done,/relay resume 回含 /goal 的提示,不 submit、不改 mode、不认领', async ($, on) => {
    const w = world(on, goalMd(['true', 'test 1 -eq 1']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '全部做完。\nRELAY: done'))
    await w.clock.settle()
    expect(await modeOf($)).toBe('done')
    const claims = calls(w, 'claim').length
    const r = await $.command.run({ command: 'relay', args: 'resume', ...CMD })
    await w.clock.settle()
    expect(r.text).toContain('/goal')
    expect(w.submits.length).toBe(1)
    expect(await modeOf($)).toBe('done')
    expect(calls(w, 'claim').length).toBe(claims)
  })

  test('GWT-4:属主活着,/relay resume 被拒(含 force)不 submit;/relay resume force 带 --force 认领,submit 1 次', async ($, on) => {
    const w = world(on, goalMd(['true']), 1000, saved('running', 'sid-0'))
    w.files.set(GOAL_PATH, goalMd(['true']))
    w.ctx.owner = args => (args[0] === 'claim' && !args.includes('--force') ? { code: 3, out: 'owner-alive sid-0xxx 9999\n' } : undefined)
    const r = await $.command.run({ command: 'relay', args: 'resume', ...CMD })
    await w.clock.settle()
    expect(r.text).toContain('force')
    expect(w.submits.length).toBe(0)
    const f = await $.command.run({ command: 'relay', args: 'resume force', ...CMD })
    await w.clock.settle()
    const claims = calls(w, 'claim')
    expect(claims.length).toBe(2)
    expect(claims[1]).toContain('--force')
    expect(argOf(claims[1] ?? [], '--pid')).toBe(SELF_PID)
    expect(f.text).not.toContain('force')
    expect(w.submits.length).toBe(1)
    expect(await modeOf($)).toBe('running')
  })

  test('/goal 激活认领:claim 带 cwd、GOAL 路径、sid、自己的 pid;属主活着时不发开工 prompt,提示里有 force', async ($, on) => {
    const w = world(on, goalMd(['true']))
    w.ctx.owner = args => (args[0] === 'claim' ? { code: 3, out: 'owner-alive sid-0xxx 9999\n' } : undefined)
    await startGoal($, w)
    const c = calls(w, 'claim')[0] ?? []
    expect(argOf(c, '--cwd')).toBe(CWD)
    expect(argOf(c, '--path')).toBe(GOAL_PATH)
    expect(argOf(c, '--sid')).toBe('sid-1')
    expect(argOf(c, '--pid')).toBe(SELF_PID)
    expect(c).not.toContain('--force')
    expect(w.submits.length).toBe(0)
    expect([...w.notes, ...w.toasts].some(t => t.includes('force'))).toBe(true)
  })

  test('GWT-5:running 复活 → claim --revive,恰好 submit 一次续跑(已复活),mode running,mode 行原因 revive', async ($, on) => {
    const w = await revived($, on, 'running')
    const c = calls(w, 'claim')
    expect(c.length).toBe(1)
    expect(c[0]).toContain('--revive')
    expect(argOf(c[0] ?? [], '--pid')).toBe(SELF_PID)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]?.startsWith('[relay] 按 GOAL 继续:')).toBe(true)
    expect(w.submits[0]).toContain('已复活')
    expect(await modeOf($)).toBe('running')
    const line = modeLines(w).find(a => argOf(a, '--why') === 'revive') ?? []
    expect(argOf(line, '--to')).toBe('running')
    expect(argOf(line, '--pid')).toBe(SELF_PID)
  })

  test('GWT-5b:属主是另一个活着的 pid → 不 submit,toast 和 notify 各一次', async ($, on) => {
    const w = await revived($, on, 'running', args => (args[0] === 'check' ? record('running', 9999, true) : undefined))
    expect(w.submits.length).toBe(0)
    expect(calls(w, 'claim').length).toBe(0)
    expect(w.toasts.length).toBe(1)
    expect(w.notes.length).toBe(1)
  })

  test('复活上限:claim --revive 退 5 → 不 submit,notify 一次', async ($, on) => {
    const w = await revived($, on, 'running', args => (args[0] === 'claim' ? { code: 5, out: 'revive-capped\n' } : undefined))
    expect(calls(w, 'claim')[0]).toContain('--revive')
    expect(w.submits.length).toBe(0)
    expect(w.notes.length).toBe(1)
  })

  test('推送:running 复活 → 认领后 notify 含「复活」和断开、复活两个 HH:MM;第一轮答完 notify 含「推进」和提交数', async ($, on) => {
    const w = await revived($, on, 'running')
    expect(w.notes.length).toBe(1)
    expect(w.notes[0]).toContain('复活')
    expect(w.notes[0]).toContain(LINE)
    expect(w.notes[0]).toMatch(/\d\d:\d\d[\s\S]*\d\d:\d\d/)
    w.ctx.revCount = '3'
    await $.turn.complete(turn(1, '修好了 header。\nRELAY: continue phase=build'))
    await w.clock.settle()
    expect(w.notes.length).toBe(2)
    expect(w.notes[1]).toContain('推进')
    expect(w.notes[1]).toContain('3')
    expect(w.ran.some(a => a[0] === 'git' && a[1] === 'rev-list' && a.includes('abc123..HEAD'))).toBe(true)
  })

  // GWT-5w:owner 23.10「否则复活等于替我把挂起的岔口拍了板」。复活那一轮只重新挂单,由这里的断言核对,不靠执行体自己说。
  const OWNER_LAST = '清单里剩下的项都挂在待 owner 上。\nRELAY: owner #2 桌面端还要不要做 | 推荐: 先不做'

  test('GWT-5w 照规矩的一轮:submit 一次(只重新挂单 · 不提交 · RELAY: owner);轮末 HEAD 与 ⏸ 行都没变、末行 RELAY: owner → 不写 GOAL、不再 submit、停在 waiting-owner、没有越界通知', async ($, on) => {
    const w = await revived($, on, 'waiting-owner')
    expect(calls(w, 'claim')[0]).toContain('--revive')
    expect(w.submits.length).toBe(1)
    const sent = w.submits[0] ?? ''
    expect(sent.startsWith('[relay] 按 GOAL 继续:')).toBe(true)
    expect(sent).toContain('只重新挂单')
    expect(sent).toContain('不提交')
    expect(sent).toContain('RELAY: owner')
    expect(await modeOf($)).toBe('waiting-owner')
    // 推送只有一条:仍在等你,带原来的 #n。
    expect(w.notes.length).toBe(1)
    expect(w.notes[0]).toContain('仍在等你')
    expect(w.notes[0]).toContain('#2')
    await $.turn.complete(turn(1, OWNER_LAST))
    await w.clock.settle()
    await w.clock.advance(60 * 60_000)
    expect(goalWrites(w)).toBe(0)
    expect(w.submits.length).toBe(1)
    expect(await modeOf($)).toBe('waiting-owner')
    expect(w.notes.some(t => t.includes('越界'))).toBe(false)
    expect(w.notes.length).toBe(1)
  })

  const crossed = async (w: ReturnType<typeof world>, $: Engine, what: string) => {
    expect(goalWrites(w)).toBe(0)
    expect(w.submits.length).toBe(1)
    expect(await modeOf($)).toBe('waiting-owner')
    const hits = w.notes.filter(t => t.includes('复活那一轮越界'))
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain(what)
  }

  test('GWT-5w 越界①:末行是 RELAY: continue phase=x → 不再 submit,停在 waiting-owner,notify 一条「复活那一轮越界」', async ($, on) => {
    const w = await revived($, on, 'waiting-owner')
    await $.turn.complete(turn(1, '顺手做了点别的。\nRELAY: continue phase=x'))
    await w.clock.settle()
    await w.clock.advance(60 * 60_000)
    await crossed(w, $, 'RELAY: owner')
  })

  test('GWT-5w 越界②:轮末 git rev-parse HEAD 变了 → 同上', async ($, on) => {
    const w = await revived($, on, 'waiting-owner')
    w.ctx.head = 'def456'
    await $.turn.complete(turn(1, OWNER_LAST))
    await w.clock.settle()
    await w.clock.advance(60 * 60_000)
    await crossed(w, $, 'HEAD')
  })

  test('GWT-5w 越界③:轮末 GOAL 里一行 ⏸ 被改了一个字(行数不变)→ 同上', async ($, on) => {
    const w = await revived($, on, 'waiting-owner')
    w.files.set(GOAL_PATH, WAITING.replace('- [ ] 修 header ⏸#2', '- [ ] 修 footer ⏸#2'))
    await $.turn.complete(turn(1, OWNER_LAST))
    await w.clock.settle()
    await w.clock.advance(60 * 60_000)
    await crossed(w, $, '⏸')
  })

  // GWT-6:被接管的旧属主在下一次发 prompt 前被挡住。续跑、心跳、提醒三种各试一次。
  const fenced = async (w: ReturnType<typeof world>, $: Engine) => {
    expect(w.submits.length).toBe(1)
    expect(await modeOf($)).toBe('idle')
    expect(w.notes.length).toBe(1)
    const set = calls(w, 'set')
    expect(argOf(set[set.length - 1] ?? [], '--pid')).toBe(SELF_PID)
    expect(whys(w)).toContain('fence')
  }

  test('GWT-6 fencing ①续跑:set 退 3 → 不 submit,mode idle,notify 一次', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    expect(calls(w, 'set').length).toBe(1)
    w.ctx.owner = args => (args[0] === 'set' ? { code: 3 } : undefined)
    await $.turn.complete(turn(1, '改了。\nRELAY: continue phase=build'))
    await w.clock.settle()
    await fenced(w, $)
  })

  test('GWT-6 fencing ②心跳:set 退 3 → 不 submit,mode idle,notify 一次', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
    await $.turn.complete(turn(1, '等子 agent。\nRELAY: continue phase=wait'))
    await w.clock.settle()
    w.ctx.owner = args => (args[0] === 'set' ? { code: 3 } : undefined)
    await w.clock.advance(25 * 60_000)
    await w.clock.settle()
    await fenced(w, $)
  })

  test('GWT-6 fencing ③提醒:set 退 3 → 不 submit,mode idle,notify 一次', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    w.ctx.owner = args => (args[0] === 'set' ? { code: 3 } : undefined)
    await $.turn.complete(turn(1, '整理了一下进度。'))
    await w.clock.settle()
    await fenced(w, $)
  })

  test('GWT-12:running 连着两轮没有 RELAY 行,relay 停下 → mode 行 running→waiting-owner,原因 no-relay-line-twice', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '整理了一下进度。'))
    await w.clock.settle()
    await $.turn.complete(turn(2, '阶段总结如上。'))
    await w.clock.settle()
    const line = modeLines(w).find(a => argOf(a, '--why') === 'no-relay-line-twice') ?? []
    expect(argOf(line, '--from')).toBe('running')
    expect(argOf(line, '--to')).toBe('waiting-owner')
    expect(argOf(line, '--path')).toBe(GOAL_PATH)
    expect(argOf(line, '--pid')).toBe(SELF_PID)
  })

  test('GWT-13:relay 自己 /clear 以后新会话开始 → mode 行 relay-clear,--old-sid 是旧会话,--from 等于 --to', async ($, on) => {
    const w = world(on, goalMd(['true']), 600_000)
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
    on('command.run', async (_$, e, next) => {
      if (e.command === 'clear') {
        w.ctx.sid = 'sid-2'
        return { text: '' } as never
      }
      return next(e)
    })
    await say($, '继续')
    await startGoal($, w)
    w.files.set(HANDOFF, `relay-anchor: ${anchorOf('继续')}\n# handoff`)
    await $.turn.complete(turn(1, '写好了。\nHANDOFF-READY'))
    await w.clock.advance(31_000)
    await w.clock.settle()
    const line = modeLines(w).find(a => argOf(a, '--why') === 'relay-clear') ?? []
    expect(argOf(line, '--old-sid')).toBe('sid-1')
    expect(argOf(line, '--sid')).toBe('sid-2')
    expect(argOf(line, '--from')).toBe('running')
    expect(argOf(line, '--to')).toBe('running')
  })

  test('每次改 mode 都有一行:/goal 激活 → goal', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    expect(whys(w)).toEqual(['goal'])
    expect(argOf(modeLines(w)[0] ?? [], '--to')).toBe('running')
  })

  test('每次改 mode 都有一行:验收通过 → done-accepted', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.turn.complete(turn(1, '全部做完。\nRELAY: done'))
    await w.clock.settle()
    expect(whys(w)).toContain('done-accepted')
  })

  test('每次改 mode 都有一行:/relay stop → relay-stop', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.command.run({ command: 'relay', args: 'stop', ...CMD })
    await w.clock.settle()
    expect(whys(w)).toContain('relay-stop')
  })

  test('每次改 mode 都有一行:/goal clear → goal-clear', async ($, on) => {
    const w = world(on, goalMd(['true']))
    await startGoal($, w)
    await $.command.run({ command: 'goal', args: 'clear', ...CMD })
    await w.clock.settle()
    expect(whys(w)).toContain('goal-clear')
  })

  test('每次改 mode 都有一行:owner 自己 /clear → owner-clear', async ($, on) => {
    const w = world(on, goalMd(['true']))
    on('session.end', async () => ({ sessionId: 'sid-1' }) as never)
    await startGoal($, w)
    await $.session.end({ reason: 'clear' } as never)
    await w.clock.settle()
    expect(whys(w)).toContain('owner-clear')
    expect(await modeOf($)).toBe('idle')
  })

  test('mode 行写不进(owner.mjs mode 退 1):toast 一行,续跑照旧', async ($, on) => {
    const w = world(on, goalMd(['true']))
    w.ctx.owner = args => (args[0] === 'mode' ? { code: 1 } : undefined)
    await startGoal($, w)
    expect(w.submits.length).toBe(1)
    expect(w.toasts.some(t => t.includes('owner.log'))).toBe(true)
  })
})
