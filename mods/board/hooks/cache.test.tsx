import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { cacheView, cells } from './hud'
import type { CacheIn } from './hud'
import { hudLines, textOf, T } from './tui'
import type { Cache, Hud, Row } from './tui'
import { PEN_FIXTURE as pen, PEN_LONGEST } from './pen-fixture'

// 缓存 v2 切片 4(docs/plan/2026-10-23-cache-v2.md D-6):D 第 2 行的 ◷ 段按 docs/design/term/base/G-<状态>.html 画。
const HUD = (pen as { hud: Hud }).hud
const NOW = 10_000_000
const base: CacheIn = { lastEnd: NOW - 120_000, ttlMs: 3_600_000, warm: null, idleSince: NOW - 60_000, nudge: 'none', tokens: 245_000, coldUsd: 2.45, maxPings: 30, stopped: '', handoffSince: null }

describe('cacheView: cache-clock state() → G row', () => {
  test('a turn or helper working (idleSince null) → working', () => {
    expect(cacheView({ ...base, idleSince: null }, NOW)).toEqual({ state: 'working' })
  })
  test('idle under 5 minutes → minutes left', () => {
    expect(cacheView(base, NOW)).toEqual({ state: 'idle', min: 58 })
  })
  test("nudge 'warm' → remind with the cold price", () => {
    expect(cacheView({ ...base, nudge: 'warm', lastEnd: NOW - 5 * 60_000 }, NOW)).toEqual({ state: 'remind', min: 55, tokens: 245_000, usd: 2.45 })
  })
  test('warming beats the nudge: time left, pings, spend', () => {
    const warm = { startedAt: NOW - 48 * 60_000, windowMs: 2 * 3_600_000, pings: 3, usd: 0.36 }
    expect(cacheView({ ...base, warm, nudge: 'warm' }, NOW)).toEqual({ state: 'warming', leftMs: 72 * 60_000, windowMs: 7_200_000, pings: 3, maxPings: 30, usd: 0.36 })
  })
  test("nudge 'stopped' → why it stopped", () => {
    expect(cacheView({ ...base, nudge: 'stopped', stopped: '窗口到了' }, NOW)).toEqual({ state: 'stopped', why: '窗口到了' })
  })
  test("nudge 'cold' → tokens and price", () => {
    expect(cacheView({ ...base, nudge: 'cold', lastEnd: NOW - 7_200_000 }, NOW)).toEqual({ state: 'cold', tokens: 245_000, usd: 2.45 })
  })
  test('a cold handoff writing → flushing, over everything', () => {
    expect(cacheView({ ...base, idleSince: null, handoffSince: NOW - 1000 }, NOW)).toEqual({ state: 'flushing' })
  })
  test('no cache-clock, an old one without idleSince, or no reply yet → null (old ◷ —)', () => {
    expect(cacheView(null, NOW)).toBe(null)
    expect(cacheView({ lastEnd: NOW, ttlMs: 1, warm: null }, NOW)).toBe(null)
    expect(cacheView({ ...base, lastEnd: 0 }, NOW)).toBe(null)
  })
})

// The ◷ segment: the cells after the last │ of line 2, its start column 0.
function seg(c: Cache): { row: Row; text: string; at: (t: string) => number } {
  const l2 = hudLines({ ...HUD, cache: c })[1]
  const all = textOf(l2)
  const cut = all.lastIndexOf('│ ') + 2
  const row: Row = []
  let n = 0
  for (const s of l2) {
    if (n >= cut) row.push(s)
    n += s.t.length
  }
  const text = all.slice(cut)
  return { row, text, at: t => cells(text.slice(0, text.indexOf(t))) }
}
const btn = (r: Row, t: string) => r.find(s => s.t === t)

describe('the ◷ segment, cell for cell as G', () => {
  test('working: one green bold ●', () => {
    expect(seg({ state: 'working' }).row).toEqual([{ t: '●', fg: T.done, bg: '#0c0c0c', b: true }])
  })
  test('idle: ◷ 58m green bold', () => {
    expect(seg({ state: 'idle', min: 58 }).row).toEqual([{ t: '◷ 58m', fg: T.done, bg: '#0c0c0c', b: true }])
  })
  // 10.23 晚 ◷ 段缩到 24 格(第 2 行让给六分块小人):位置 = G 稿 x ÷ 7.8(±1,判官同一容差)
  test('remind: price at 6, [ 保温 ] label at 14 (G x 49 / 110 px), no ▾', () => {
    const s = seg({ state: 'remind', min: 55, tokens: 245_000, usd: 2.45 })
    expect(s.text).toBe('◷ 55m ≈$2.45  保温 ')
    expect([s.at('≈'), s.at('保温')]).toEqual([6, 14])
    expect(btn(s.row, ' 保温 ')).toEqual({ t: ' 保温 ', fg: '#22c55e', bg: '#12301c', b: true, press: 'warm' })
    expect(s.row[0]).toEqual({ t: '◷ 55m', fg: '#eab308', bg: '#0c0c0c', b: true })
  })
  test('warming: 4-cell bar 60% filled, time at 12, [ 停 ] label at 19', () => {
    const s = seg({ state: 'warming', leftMs: 72 * 60_000, windowMs: 7_200_000, pings: 3, maxPings: 30, usd: 0.36 })
    expect(s.text).toBe(`◷ 保温 ${'▆'.repeat(4)} 1h12m  停 `)
    expect([s.at('▆'), s.at('1h12m'), s.at('停')]).toEqual([7, 12, 19])
    expect(s.row.filter(x => x.t.startsWith('▆')).map(x => [x.t.length, x.fg])).toEqual([[2, '#8b5cf6'], [2, '#2a2640']])
    expect(btn(s.row, ' 停 ')).toEqual({ t: ' 停 ', fg: '#8f89a8', bg: '#2a2640', b: true, press: 'stop' })
  })
  test('stopped: red reason, [ ↻ ] label at 12, [ 交接 ] label at 16', () => {
    const s = seg({ state: 'stopped', why: '窗口到了' })
    expect(s.text).toBe('◷ 窗口到了  ↻   交接 ')
    expect([s.at('↻'), s.at('交接')]).toEqual([12, 16])
    expect(s.row[0]).toEqual({ t: '◷ 窗口到了 ', fg: '#ef4444', bg: '#0c0c0c' })
    expect(btn(s.row, ' ↻ ')).toEqual({ t: ' ↻ ', fg: '#eab308', bg: '#2a2640', b: true, press: 'rewarm' })
    expect(btn(s.row, ' 交接 ')).toEqual({ t: ' 交接 ', fg: '#22c55e', bg: '#12301c', b: true, press: 'handoff' })
  })
  test('cold: grey tokens and price, [交接] at 15', () => {
    const s = seg({ state: 'cold', tokens: 245_000, usd: 2.45 })
    expect(s.text).toBe('❄ 245k ≈$2.45  交接 ')
    expect(s.at('交接')).toBe(15)
    expect(s.row[0]!.fg).toBe('#6b7280')
    expect(btn(s.row, ' 交接 ')?.press).toBe('handoff')
  })
  test('flushing: 写交接中… green bold, no button (G-handing)', () => {
    const s = seg({ state: 'flushing' })
    expect(s.text).toBe('◷ 写交接中…')
    expect(s.row).toEqual([{ t: '◷ 写交接中…', fg: '#22c55e', bg: '#0c0c0c', b: true }])
  })
  test('no cache view: the old ◷ Nm, not bold (D 提案 2)', () => {
    expect(seg(null as never).row).toEqual([{ t: '◷ 58m', fg: T.done, bg: '#0c0c0c' }])
  })
})

// 最坏值:每一态取 cache-clock state() 算得出的最长字串，不抄夹具。◷ 段一超宽，宿主不截断也不报错，
// 把整段文字挤成换行后只剩空白(10.23 cold 的「≈$2.45」就是这么没的)。
// SEG_ROOM:整行 98 格(seg-room/ 实测)减最长前缀 74 格(六分块小人 3 × 5 格,10.23 晚)= 24 格。
const SEG_ROOM = 24
const H = 3_600_000
const worst: Array<[string, CacheIn]> = [
  // min = ceil(ttl 余量);ttl 只有 5m / 1h / 60 s 演示，最长 1h → 60m
  ['idle 60m', { ...base, lastEnd: NOW, ttlMs: H }],
  // tokens:上下文上限 1M → 1000k;coldUsd:1M × 最贵写价 20 $/M = $20,money() 在 [10, 100) 最长(≈$xx.xx,7 格)
  ['remind 1000k ≈$99.99', { ...base, lastEnd: NOW, ttlMs: H, nudge: 'warm', tokens: 1_000_000, coldUsd: 99.99 }],
  ['remind usd null → 1000k', { ...base, lastEnd: NOW, ttlMs: H, nudge: 'warm', tokens: 1_000_000, coldUsd: null }],
  // 窗口上限 MAX_WINDOW 8h → 8h00m;保温花费 ≤ 30 ping × 单次冷写 ≈$21,money(n, false) 最长也是 [10, 100) 的 $xx.xx
  ['warming 8h00m $99.99', { ...base, warm: { startedAt: NOW, windowMs: 8 * H, pings: 30, usd: 99.99 }, maxPings: 30 }],
  ['cold 1000k ≈$99.99', { ...base, nudge: 'cold', tokens: 1_000_000, coldUsd: 99.99 }],
  ['cold usd null', { ...base, nudge: 'cold', tokens: 1_000_000, coldUsd: null }],
  // 停因是闭集:cache-clock STOP_BRIEFS(窗口到了 / ping 满 30 / 还没回复 / ping 连败 / 保温停了)
  ...['窗口到了', 'ping 满 30', '还没回复', 'ping 连败', '保温停了'].map((w): [string, CacheIn] => [`stopped ${w}`, { ...base, nudge: 'stopped', stopped: w }]),
  ['stopped empty → fallback', { ...base, nudge: 'stopped', stopped: '' }],
  ['working', { ...base, idleSince: null }],
  ['flushing', { ...base, handoffSince: NOW }],
]
describe(`the ◷ segment at its longest fits ${SEG_ROOM} cells`, () => {
  for (const [name, s] of worst)
    test(name, () => {
      const v = cacheView(s, NOW)
      expect(v).not.toBe(null)
      const { text } = seg(v!)
      expect(cells(text), text).toBeLessThanOrEqual(SEG_ROOM)
    })
})

// 整行：第 2 行 = 最长前缀 + 每一态 ◷ 段最长值，cells() ≤ 98。
// 98 实测(seg-room/):前缀 62 + 36 与最长前缀 83 + 15 都整行画出，任一再多 1 格就被挤没或截成「…」。
// 前缀上界从 tui.ts 推：条 8 格;n/m 各 ≤ 3 格(数到 100 写 99+,步骤数没有上限);步骤名 cut(TASK_TEXT=13),全 ASCII 时才用满 13 格(CJK 在边上会少 1 格);
// 小人最多 MAX_DOTS=3 个、各 5 格(六分块，10.23 晚);在跑数 ≤ 3 格(99+,helper 数没有上限)。前缀上界 98 − ◷ 段 24 = 74。
const LINE2_MAX = 98
const longest: Hud = { ...HUD, task: { done: 100, n: 100, text: 'relay-coldhandoff-flush-start-and-wait' }, dots: Array.from({ length: 100 }, () => 'other') }
describe(`line 2 at its longest (longest prefix + each ◷ at its longest) fits ${LINE2_MAX} cells`, () => {
  test('the longest prefix fits 74 cells: 99+/99+, a 13-cell step, 3 crabs, 99+ 在跑', () => {
    const t = textOf(hudLines({ ...longest, cache: { state: 'working' } })[1])
    expect(t).toBe(' ▶ 任务 ▆▆▆▆▆▆▆▆ 99+/99+ relay-coldha… │ 🬋🬴██🬗 🬋🬴██🬗 🬋🬴██🬗 99+ 在跑 │ ●')
    expect(cells(t.slice(0, t.lastIndexOf('│ ') + 2))).toBeLessThanOrEqual(LINE2_MAX - SEG_ROOM)
  })
  test('fixture/longest.json: its line2 is what board draws from its hud (the gate checks the screen against it)', () => {
    const fx = PEN_LONGEST as { hud: Hud; line2: string }
    expect(textOf(hudLines(fx.hud)[1])).toBe(fx.line2)
    expect(cells(fx.line2)).toBeLessThanOrEqual(LINE2_MAX)
  })
  for (const [name, s] of worst)
    test(name, () => {
      const t = textOf(hudLines({ ...longest, cache: cacheView(s, NOW)! })[1])
      expect(cells(t), t).toBeLessThanOrEqual(LINE2_MAX)
    })
})

// Through the engine: the fixture's ◷ segment, a Button under each G button, a press runs cache-clock's command.
const FX = '/fx/pen-g.json'
function world(on: On, cache: Cache): { commands: string[] } {
  const commands: string[] = []
  mock.env(on, { HOME: '/home/t', BOARD_FIXTURE: FX })
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/t/repos/myapp' }))
  on('session.id', async () => ({ value: 'sid1' }) as never)
  on('settings.read', async () => ({ value: { enabledPlugins: {} } }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', async () => ({ value: { tool: 'mcp__board__plan' } }) as never)
  on('agent.list', async () => ({ value: [] }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box flexDirection="column" />
  })
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('fs.read', (_, e) => {
    if (e.path === FX) return { value: JSON.stringify({ ...(pen as object), hud: { ...HUD, cache } }) }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  for (const name of ['keepwarm', 'cacheclock']) {
    on('command.run', { command: name }, async ($, e) => {
      commands.push(`${name}${e.args ? ` ${e.args}` : ''}`)
      return { text: 'ok' }
    })
  }
  return { commands }
}
const startIn = ($: Engine) => $.session.start({ source: 'startup', cwd: '/home/t/repos/myapp', surface: 'terminal', isInteractive: true } as never)
const mount = ($: Engine) => $.ui.mount({ plugin: 'board', surface: 'terminal', component: 'AbovePrompt', props: { isWorking: false, hasSurvey: false, maxRows: 10, bodyColumns: 220 } } as never)

describe('the ◷ buttons are pressable', () => {
  test('remind: [保温] runs /keepwarm (▾ 先不 收进 24 格时去掉，发消息就收回)', async ($, on) => {
    const w = world(on, { state: 'remind', min: 55, tokens: 245_000, usd: 2.45 })
    await startIn($)
    const ui = await mount($)
    expect(await ui.find({ key: 'cache-warm-btn' })).toBeDefined()
    await ui.press({ key: 'cache-warm-btn' })
    expect(w.commands).toEqual(['keepwarm'])
  })
  test('stopped: [↻] /keepwarm, [交接] /cacheclock handoff', async ($, on) => {
    const w = world(on, { state: 'stopped', why: '窗口到了' })
    await startIn($)
    const ui = await mount($)
    await ui.press({ key: 'cache-rewarm-btn' })
    await ui.press({ key: 'cache-handoff-btn' })
    expect(w.commands).toEqual(['keepwarm', 'cacheclock handoff'])
  })
  test('warming: [停] /keepwarm off', async ($, on) => {
    const w = world(on, { state: 'warming', leftMs: 72 * 60_000, windowMs: 7_200_000, pings: 3, maxPings: 30, usd: 0.36 })
    await startIn($)
    await (await mount($)).press({ key: 'cache-stop-btn' })
    expect(w.commands).toEqual(['keepwarm off'])
  })
  test('the G cells are drawn as coloured Text beside the Button', async ($, on) => {
    world(on, { state: 'cold', tokens: 245_000, usd: 2.45 })
    await startIn($)
    const ui = await mount($)
    const t = (await ui.findAll({ type: 'Text' })).filter(el => el.text === ' 交接 ')
    expect(t.some(el => (el.props as { backgroundColor?: string }).backgroundColor === '#12301c')).toBe(true)
    expect(await ui.find({ key: 'cache-handoff-btn' })).toBeDefined()
  })
})

// owner 10.23:一轮结束、只剩子 agent / delegate 在跑也算「刚停手」:画 ◷ 分钟，不画绿点。
describe('◷ while only helpers run', () => {
  test('turn over, helpers still busy (idleSince null, turn false) → idle minutes', () => {
    expect(cacheView({ ...base, lastEnd: NOW, ttlMs: H, idleSince: null, turn: false }, NOW)).toEqual({ state: 'idle', min: 60 })
  })
  test('the main turn runs → the green dot', () => {
    expect(cacheView({ ...base, lastEnd: NOW, ttlMs: H, idleSince: null, turn: true }, NOW)).toEqual({ state: 'working' })
  })
})
