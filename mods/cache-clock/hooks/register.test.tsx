import { expect, mock, test } from 'claude-code/testing'

import { STOP_BRIEFS, stopBrief } from './register'

type On = Parameters<Parameters<typeof test>[2]>[1]

// 共用桩:182k 上下文,ttl.py 报 5m,主模型 opus 5.5。
function stub(on: On, opts: { files?: Record<string, string>; store?: Record<string, unknown>; toasts?: string[]; ttl?: string } = {}) {
  const files = opts.files ?? {}
  const store = opts.store ?? {}
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('turn.start', async () => ({}) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', async () => ({ value: 'sid' }) as never)
  on('session.usage', async () => ({ value: { context: { tokens: 182_000, window: 1_000_000 } } }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: `${opts.ttl ?? '5m'}\n`, stderr: '' } }) as never)
  on('fs.exists', async ($, e) => ({ value: (e as { path: string }).path in files }) as never)
  on('fs.read', async ($, e) => ({ value: files[(e as { path: string }).path] ?? '' }) as never)
  on('fs.write', async ($, e) => {
    const { path, text } = e as { path: string; text: string }
    files[path] = text
    return { value: undefined } as never
  })
  on('store.get', async ($, e) => ({ value: store[(e as { key: string }).key] }) as never)
  on('store.set', async ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store[key] = value
    return { value: undefined } as never
  })
  on('ui.toast', async ($, e) => {
    opts.toasts?.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('turn.complete', async () => ({ text: '' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>REST</Text>
  })
  return { clock, files, store }
}

const start = { source: 'startup', cwd: '/home/test/repo', isInteractive: true } as const
const props = (cols = 120) => ({ isWorking: false, hasSurvey: false, maxRows: 10, bodyColumns: cols }) as never
const reply = async ($: Parameters<Parameters<typeof test>[2]>[0]) => {
  await $.turn.complete({ answer: '', usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`倒数、报价、变冷后给交接按钮并填入 /relay go (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const toasts: string[] = []
    const { clock, store } = stub(on, { toasts })
    const fills: string[] = []
    on('prompt.fill', async ($, e) => {
      fills.push((e as { text: string }).text)
      return { isFilled: true } as never
    })
    await $.session.start({ ...start, surface } as never)

    let v = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ key: 'hide' }), '首次回复前不画').toBeUndefined()

    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    await clock.advance(30_000)
    v = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ text: /缓存热/ }), '热').toBeDefined()
    expect(await v.find({ text: /4:30/ }), '5 分钟缓存过 30 秒剩 4:30').toBeDefined()
    expect(await v.find({ text: /5 分钟缓存\(据上次回复\)/ }), '说出时长出处').toBeDefined()
    expect(await v.find({ key: 'handoff' }), '热时没有交接').toBeUndefined()

    await clock.advance(5 * 60_000)
    v = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ text: /缓存已冷/ }), '5 分钟后变冷').toBeDefined()
    expect(await v.find({ text: /182k tokens/ }), '182k tokens').toBeDefined()
    await v.press({ key: 'handoff' })
    expect(fills, '交接填入 /relay go,不自动发送').toEqual(['/relay go'])

    await v.press({ key: 'hide' })
    v = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ key: 'hide' }), '已隐藏').toBeUndefined()
    expect(await v.find({ text: 'REST' }), '别的横条照画').toBeDefined()
    expect(store.hidden, '隐藏存进 store,跨会话').toBe(true)
    expect(toasts.join(' '), 'toast 说怎么找回').toContain('/cacheclock')

    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    v = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ text: /缓存热/ }), '新回复不把它带回来').toBeUndefined()
    const said = JSON.stringify(await $.command.run({ command: 'cacheclock', args: '' } as never))
    expect(said, '/cacheclock 再显示').toContain('缓存钟已显示')
    v = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ text: /缓存热/ }), '显示回来').toBeDefined()
  })
}

test('有模型价时标出现在回复与冷了重写的美元价', { timeoutMs: 30000 }, async ($, on) => {
  const { clock } = stub(on, { ttl: '1h' })
  await $.session.start({ ...start, surface: 'terminal' } as never)
  await reply($)
  await clock.settle()
  await clock.advance(1000)
  const v = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: props(160) })
  // opus-5:读 $0.5/M,1h 写 $10/M;182k → $0.09 / $1.82
  expect(await v.find({ text: /≈\$0\.09/ }), '读价').toBeDefined()
  expect(await v.find({ text: /≈\$1\.82/ }), '写价').toBeDefined()
  expect(await v.find({ text: /1 小时缓存/ }), '1h').toBeDefined()
})

test('冷了拦一次人发的消息并报价,再发放行;后台与插件来的不拦', { timeoutMs: 30000 }, async ($, on) => {
  const { clock } = stub(on, { ttl: '1h' })
  on('prompt.submit', async ($, e) => ({ text: (e as { text: string }).text }) as never)
  await $.session.start({ ...start, surface: 'terminal' } as never)
  await reply($)
  await clock.settle()
  await clock.advance(61 * 60_000)

  const auto = await $.prompt.submit({ text: '继续', origin: { kind: 'auto-continuation' } } as never)
  expect(JSON.stringify(auto), '后台续跑不拦').not.toContain('drop')
  const first = await $.prompt.submit({ text: '给我个回顾', origin: { kind: 'composer' } } as never)
  expect(JSON.stringify(first), '第一次拦').toContain('drop')
  expect(JSON.stringify(first), '报价').toContain('≈$1.82')
  expect(JSON.stringify(first), '指向 relay').toContain('/relay go')
  const second = await $.prompt.submit({ text: '给我个回顾', origin: { kind: 'composer' } } as never)
  expect(JSON.stringify(second), '再发放行').not.toContain('drop')

  await $.command.run({ command: 'cacheclock', args: 'guard off' } as never)
  await reply($)
  await clock.settle()
  await clock.advance(61 * 60_000)
  const off = await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as never)
  expect(JSON.stringify(off), 'guard off 不拦').not.toContain('drop')
  const status = JSON.stringify(await $.command.run({ command: 'cacheclock', args: 'status' } as never))
  expect(status, 'status 有拦截模式').toContain('拦截:关')
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`保温:按钮开,变冷前 ping,人发消息就停 (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const toasts: string[] = []
    const forks: string[] = []
    const { clock, files } = stub(on, { toasts })
    on('model.fork', async ($, e) => {
      forks.push((e as { prompt: string }).prompt)
      return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 182_000, cache_creation_input_tokens: 0 } } } as never
    })
    on('prompt.submit', async ($, e) => ({ text: (e as { text: string }).text }) as never)
    await $.session.start({ ...start, surface } as never)
    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    await clock.advance(1000)

    let v = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ text: /保温每次 ping/ }), '提示行').toBeDefined()
    expect(forks.length, '不按按钮不发 ping').toBe(0)
    await v.press({ key: 'keepwarm' })
    v = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ text: /保温中 · 首次 ping 在 4:14 后/ }), '开了,变冷前 45 秒').toBeDefined()

    await clock.advance(4 * 60_000)
    expect(forks.length, '剩 59 秒还不 ping').toBe(0)
    await clock.advance(16_000)
    await clock.settle()
    expect(forks.length, '变冷前一次 ping').toBe(1)
    expect(forks[0], '小 prompt').toBe('Reply with the single word: ok')
    v = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ text: /保温中 · 第 1 次 ping · 下次在 4:1\d 后 · 上次 ping 读了 182k 缓存 tokens/ }), 'ping 之后').toBeDefined()
    expect(await v.find({ text: /缓存热/ }), '钟重新满了').toBeDefined()
    const logPath = Object.keys(files).find(k => k.endsWith('/.claude/mods-logs/cache-clock.log')) ?? ''
    expect(files[logPath] ?? '', 'ping 记日志').toContain('ping 1: cache read 182000, cache write 0, error none')

    await $.prompt.submit({ text: '/keepwarm', origin: { kind: 'composer' } } as never)
    await clock.settle()
    v = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ text: /保温中/ }), '自己的命令不停').toBeDefined()
    await $.prompt.submit({ text: '回来了', origin: { kind: 'composer' } } as never)
    await clock.settle()
    v = await $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ text: /保温中/ }), '人发消息就停').toBeUndefined()
    expect(toasts.join(' '), 'toast 说原因').toContain('你发了消息')
    await clock.advance(10 * 60_000)
    expect(forks.length, '停了不再 ping').toBe(1)
  })
}

test('保温窗口到点自停;/keepwarm 90m 自定窗口;无回复时不开', { timeoutMs: 60000 }, async ($, on) => {
  const toasts: string[] = []
  let forks = 0
  const { clock } = stub(on, { toasts })
  on('model.fork', async () => {
    forks += 1
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } } as never
  })
  await $.session.start({ ...start, surface: 'terminal' } as never)
  const early = JSON.stringify(await $.command.run({ command: 'keepwarm', args: '' } as never))
  expect(early, '首次回复前不开').toContain('还没有可保温的')
  await $.turn.complete({ answer: '' } as never)
  await clock.settle()
  const bad = JSON.stringify(await $.command.run({ command: 'keepwarm', args: 'abc' } as never))
  expect(bad, '坏参数').toContain('接时长')
  const said = JSON.stringify(await $.command.run({ command: 'keepwarm', args: '20m' } as never))
  expect(said, '20 分钟窗口').toContain('20 分钟')
  for (let i = 0; i < 25 * 60; i += 10) await clock.advance(10_000)
  await clock.settle()
  expect(toasts.join(' '), '窗口到点').toContain('窗口到了')
  const n = forks
  expect(n > 0, '窗口内 ping 过').toBe(true)
  await clock.advance(30 * 60_000)
  expect(forks, '停后不再 ping').toBe(n)
})

const e0 = [{ role: 'user', text: '摘要', toolUses: [] }]
test('压缩后钟作废,等下一次回复', { timeoutMs: 30000 }, async ($, on) => {
  const { clock } = stub(on)
  on('session.compact', async () => ({ messages: e0 }) as never)
  await $.session.start({ ...start, surface: 'terminal' } as never)
  await $.turn.complete({ answer: '' } as never)
  await clock.settle()
  let v = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: props() })
  expect(await v.find({ text: /缓存热/ }), '有钟').toBeDefined()
  await $.session.compact({ trigger: 'manual', messages: e0 } as never)
  await clock.settle()
  v = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: props() })
  expect(await v.find({ text: /缓存/ }), '压缩后不画').toBeUndefined()
})

// 片 7(D-14):别的 mod 读 $.cacheClock.state();board 开着时让出输入框上方。
const reader = {
  name: 'reader',
  register(on: On) {
    on('command.run', { command: 'peekclock' }, async $ => ({ text: JSON.stringify(await $.cacheClock!.state()) }))
  },
}

test('$.cacheClock.state() 回复后给出 lastEnd / ttlMs,没保温时 warm 为 null', { timeoutMs: 30000, plugins: [reader] }, async ($, on) => {
  const { clock } = stub(on)
  await $.session.start({ ...start, surface: 'terminal' } as never)
  await $.turn.complete({ answer: '' } as never)
  await clock.settle()
  const out = await $.command.run({ command: 'peekclock', args: '' } as never)
  const s = JSON.parse(String((out as { text?: string }).text)) as { lastEnd: number; ttlMs: number; warm: unknown }
  expect(s.lastEnd, '上次回复结束时刻').toBe(1_000_000)
  expect(s.ttlMs, '5 分钟缓存').toBe(5 * 60_000)
  expect(s.warm, '没保温').toBe(null)
})

for (const board of [true, false]) {
  test(`board ${board ? '开着时缓存钟不画自己的横条' : '没开时缓存钟照旧画'}`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock } = stub(on)
    on('settings.read', async () => ({ value: { enabledPlugins: { 'board@lead-harness': board } } }) as never)
    await $.session.start({ ...start, surface: 'terminal' } as never)
    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    const v = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: props() })
    if (board) expect(await v.find({ text: /缓存/ }), 'board 开着不画').toBeUndefined()
    else expect(await v.find({ text: /缓存热/ }), 'board 没开照画').toBeDefined()
    expect(await v.find({ text: 'REST' }), '别的横条照画').toBeDefined()
  })
}

// 缓存 v2 切片 2(D-1/D-2/D-3):停手 = 主对话没一轮在跑、无在跑子 agent、delegate 无 running;读不到按在干活。
// delegate 替身是独立插件,不能闭包测试数据,每种情形写成字面量。
const idleRuns = {
  name: 'delegate',
  register(on: On) {
    on('engine.create', async (_, e, next) => ({ ...(await next(e)), delegate: { runs: async () => [{ label: 'old', state: 'pass' }] } }) as never)
  },
}
const runningRuns = {
  name: 'delegate',
  register(on: On) {
    on('engine.create', async (_, e, next) => ({ ...(await next(e)), delegate: { runs: async () => [{ label: 'mm-1', state: 'running' }] } }) as never)
  },
}
const brokenRuns = {
  name: 'delegate',
  register(on: On) {
    on('engine.create', async (_, e, next) => ({ ...(await next(e)), delegate: { runs: async () => {
      throw new Error('delegate down')
    } } }) as never)
  },
}
type Peek = { idleSince: number | null; nudge: string }
const peek = async ($: Parameters<Parameters<typeof test>[2]>[0]) =>
  JSON.parse(String(((await $.command.run({ command: 'peekclock', args: '' } as never)) as { text?: string }).text)) as Peek

// master 上红:state() 没有 nudge 字段。
test('GWT-1 子 agent 在跑时不提醒;结束后再过 5 分钟提醒一次', { timeoutMs: 60000, plugins: [reader, idleRuns] }, async ($, on) => {
  const { clock } = stub(on, { ttl: '1h' })
  let agents = [{ id: 'a1', status: 'running', type: 'general-purpose' }]
  on('agent.list', async () => ({ value: agents }) as never)
  await $.session.start({ ...start, surface: 'terminal' } as never)
  await reply($)
  await clock.settle()
  await clock.advance(6 * 60_000)
  let s = await peek($)
  expect(s.nudge, '子 agent 在跑').toBe('none')
  expect(s.idleSince, '在干活 idleSince 为 null').toBe(null)
  agents = [{ id: 'a1', status: 'completed', type: 'general-purpose' }]
  await clock.advance(1000)
  const quiet = (await peek($)).idleSince
  expect(quiet !== null, '子 agent 结束后开始计时').toBe(true)
  await clock.advance(4 * 60_000)
  expect((await peek($)).nudge, '结束后 4 分钟').toBe('none')
  await clock.advance(61_000)
  s = await peek($)
  expect(s.nudge, '结束后 5 分钟出提醒').toBe('warm')
  expect(s.idleSince, '计时从子 agent 结束算').toBe(quiet)
})

// master 上红:state() 没有 nudge 字段。
test('GWT-2 delegate 有 running 时不提醒', { timeoutMs: 60000, plugins: [reader, runningRuns] }, async ($, on) => {
  const { clock } = stub(on, { ttl: '1h' })
  on('agent.list', async () => ({ value: [] }) as never)
  await $.session.start({ ...start, surface: 'terminal' } as never)
  await reply($)
  await clock.settle()
  await clock.advance(6 * 60_000)
  const s = await peek($)
  expect(s.nudge, 'MiniMax run 在跑').toBe('none')
  expect(s.idleSince, '在干活').toBe(null)
})

// master 上红:state() 没有 nudge / idleSince 字段。
test('GWT-3 delegate.runs() 抛错按在干活,不提醒', { timeoutMs: 60000, plugins: [reader, brokenRuns] }, async ($, on) => {
  const { clock } = stub(on, { ttl: '1h' })
  on('agent.list', async () => ({ value: [] }) as never)
  await $.session.start({ ...start, surface: 'terminal' } as never)
  await reply($)
  await clock.settle()
  await clock.advance(6 * 60_000)
  const s = await peek($)
  expect(s.nudge, '读不到不弹').toBe('none')
  expect(s.idleSince, '读不到按在干活').toBe(null)
})

// master 上红:state() 没有 nudge 字段,band 没有「保温 2h」按钮。
test('GWT-4 三者全空 4:59 不提醒,5:00 提醒,之后不重复', { timeoutMs: 60000, plugins: [reader, idleRuns] }, async ($, on) => {
  const { clock } = stub(on, { ttl: '1h' })
  on('agent.list', async () => ({ value: [] }) as never)
  const fills: string[] = []
  on('prompt.fill', async ($, e) => {
    fills.push((e as { text: string }).text)
    return { isFilled: true } as never
  })
  const runs: string[] = []
  on('command.run', { command: 'relay' }, async ($, e) => {
    runs.push(`relay ${e.args}`)
    return { text: 'ok' }
  })
  await $.session.start({ ...start, surface: 'terminal' } as never)
  await reply($)
  await clock.settle()
  expect((await peek($)).idleSince, '从回复结束算').toBe(1_000_000)
  await clock.advance(5 * 60_000 - 1000)
  expect((await peek($)).nudge, '4:59').toBe('none')
  await clock.advance(1000)
  expect((await peek($)).nudge, '5:00').toBe('warm')
  let v = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: props(160) })
  expect(await v.find({ key: 'nudge-warm' }), '提醒带 [保温 2h]').toBeDefined()
  expect(await v.find({ text: /你 5 分钟没动/ }), '提醒文字').toBeDefined()
  await v.press({ key: 'nudge-skip' })
  let shown = 0
  for (let i = 0; i < 20; i++) {
    await clock.advance(30_000)
    if ((await peek($)).nudge === 'warm') shown += 1
  }
  expect(shown, '点「先不」后同一段停手不再出').toBe(0)
  await clock.advance(60 * 60_000)
  expect((await peek($)).nudge, '冷了').toBe('cold')
  v = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: props(160) })
  await v.press({ key: 'coldhandoff' })
  await clock.advance(10)
  expect(runs, '一键交接直接跑 relay 的冷交接命令').toEqual(['relay coldhandoff'])
  expect(fills, '不再只填输入框').toEqual([])
  expect((await peek($)).handoffSince, '写交接中').toBeGreaterThan(0)
  v = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: props(160) })
  expect(await v.find({ text: '写交接中…' }), '横条显示写交接中').toBeDefined()
})

// master 上红:一轮在跑时 band 不画。
test('GWT-5 一轮在跑时 ◷ 段只有 ●,不含数字', { timeoutMs: 30000 }, async ($, on) => {
  const { clock } = stub(on)
  await $.session.start({ ...start, surface: 'terminal' } as never)
  await reply($)
  await clock.settle()
  // 一轮在跑由引擎的 isWorking 告诉 band(测试接缝里 turn.start 不能直接发)。
  const v = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: { isWorking: true, hasSurvey: false, maxRows: 10, bodyColumns: 120 } as never })
  expect(await v.find({ text: '●' }), '绿点').toBeDefined()
  expect(await v.find({ text: /\d/ }), '不报时间').toBeUndefined()
  expect(await v.find({ key: 'hide' }), '不画整条').toBeUndefined()
})

// 缓存 v2 切片 4:board ◷ 段读的选读字段、[▾] 与 [一键交接] 的命令。
test('state() 给 board 的选读字段:价、保温停的短句;/cacheclock skip 收起提醒;handoff 写交接中到 10 分钟收起', { timeoutMs: 60000, plugins: [reader, idleRuns] }, async ($, on) => {
  const { clock } = stub(on, { ttl: '1h' })
  on('agent.list', async () => ({ value: [] }) as never)
  const runs: string[] = []
  on('command.run', { command: 'relay' }, async ($, e) => {
    runs.push(`relay ${e.args}`)
    return { text: 'ok' }
  })
  on('model.fork', async () => ({ value: { isAnswered: true, text: 'ok', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } }) as never)
  await $.session.start({ ...start, surface: 'terminal' } as never)
  await reply($)
  await clock.settle()
  let s = (await peek($)) as Peek & { tokens: number; coldUsd: number | null; maxPings: number; stopped: string; handoffSince: number | null }
  expect([s.tokens, s.coldUsd, s.maxPings, s.stopped, s.handoffSince]).toEqual([182_000, 1.82, 30, '', null])
  await clock.advance(5 * 60_000)
  expect((await peek($)).nudge).toBe('warm')
  await $.command.run({ command: 'cacheclock', args: 'skip' } as never)
  expect((await peek($)).nudge, '/cacheclock skip = 先不').toBe('none')

  await $.command.run({ command: 'keepwarm', args: '30m' } as never)
  await clock.advance(31 * 60_000)
  s = (await peek($)) as typeof s
  expect([s.nudge, s.stopped], '窗口到了').toEqual(['stopped', '窗口到了'])

  await $.command.run({ command: 'cacheclock', args: 'handoff' } as never)
  await clock.advance(10)
  expect(runs).toEqual(['relay coldhandoff'])
  expect(((await peek($)) as typeof s).handoffSince, '写交接中').toBeGreaterThan(0)
  await clock.advance(10 * 60_000 + 5000)
  expect(((await peek($)) as typeof s).handoffSince, '10 分钟没写出来就收起').toBe(null)
})

// board ◷ 段的停因短句是闭集:stopWarm 的每个会亮出来的原因都落进 STOP_BRIEFS,API 错误原文不进 board。
test('stopBrief: every reason that shows maps into STOP_BRIEFS', () => {
  const cases: [string, string][] = [
    ['保温已停:2 小时窗口到了。/keepwarm 可再开。', '窗口到了'],
    ['保温已停:8 小时窗口到了。/keepwarm 可再开。', '窗口到了'],
    ['保温已停:已发 30 次 ping。/keepwarm 可再开。', 'ping 满 30'],
    ['保温已停:还没有可保温的回复。', '还没回复'],
    ['保温已停:连续 3 次 ping 失败(overloaded_error: Overloaded, please retry after a long while 529)。', 'ping 连败'],
    ['保温已停:会话刚压缩。', '保温停了'],
  ]
  for (const [why, brief] of cases) expect(stopBrief(why), why).toBe(brief)
  expect([...STOP_BRIEFS]).toEqual(['窗口到了', 'ping 满 30', '还没回复', 'ping 连败', '保温停了'])
})
