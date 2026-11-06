import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { barCells, byVersionDesc, checklistGroups, fitCells, itemTitle, listItems, render, renderFull, roadmapLayers, tableRows, under } from './parse'
import { fmtTokens, parseUsage, usageLine } from './usage'
import type { UsageRow } from './usage'

describe('board parse', () => {
  test('under() stops at a sibling heading, keeps nested ones', () => {
    const md = ['## A', 'a1', '### A.1', 'a2', '## B', 'b'].join('\n')
    expect(under(md, '^## A')).toEqual(['a1', 'a2'])
  })

  test('item title: leading bold, else text before the colon', () => {
    expect(itemTitle('**目标 `x.md`**;交接 y')).toBe('目标 x.md')
    expect(itemTitle('[ ] PX-L 加载:**PX-L0 已合**')).toBe('PX-L 加载')
  })

  test('GOAL dirs sort by version, not by text', () => {
    expect(['10.8', '10.11', '10.9'].sort(byVersionDesc)).toEqual(['10.11', '10.9', '10.8'])
  })

  test('list after a marker, with a stamp (myapp _NEXT shape)', () => {
    const md = ['最近更新:10.10 下午', '## 现在', '- 生产', '**下一步**', '1. **目标 GOAL**;x', '2. G3 完成(y)', '', '---', '## 指针', '1. no'].join('\n')
    const r = render({ kind: 'list', label: '下一步', file: '', heading: '^## 现在', after: '^\\*\\*下一步\\*\\*', stamp: '^最近更新[:：](.*)$' }, md)
    expect(r.summary).toBe('下一步 · 10.10 下午')
    expect(r.detail).toEqual(['1. 目标 GOAL', '2. G3 完成'])
  })

  test('checklist counts per group and names the open ones', () => {
    const md = ['# G', '### PX · 性能(注)', '- [x] **A**', '- [ ] **B**:z', '  - [ ] nested ignored', '### O', '- [x] C'].join('\n')
    const r = render({ kind: 'checklist', label: 'GOAL', file: '', group: '###', titles: true }, md)
    expect(r.summary).toBe('GOAL 规划完成 2/3 · 进行中 0 · 规划中 1')
    expect(r.detail).toEqual(['PX/性能 1/2 规划中:B'])
  })

  test('a GOAL with no ### sections names its groups by the ## heading above, never (未分节)', () => {
    const md = ['# GOAL', '## 清单', '- [x] T1', '- [ ] T4 回测', '## 抢占规则', 'x', '## 待 owner', '- [ ] #1 A3'].join('\n')
    const g = checklistGroups(md, '###')
    expect(g.map(x => [x.name, x.done, x.planned.length])).toEqual([['清单', 1, 1], ['待 owner', 0, 1]])
  })

  test('a list whose marker is gone falls back to every item under the heading', () => {
    const md = ['## 现在', '**生产**', '- **线上 = abc**(23.10)', '- 生产三张班表已发布', '## 指针', '- no'].join('\n')
    expect(listItems({ kind: 'list', label: '下一步', file: '', heading: '^## 现在', after: '^\\*\\*下一步\\*\\*' }, md)).toEqual(['**线上 = abc**(23.10)', '生产三张班表已发布'])
  })

  test('in-progress marker: 〔进行中 run〕 splits running from planned', () => {
    const md = ['### PX', '- [x] A', '- [ ] 〔进行中 px-d3a-measure〕**PX-G 性能标准**:x', '- [ ] **PX-RUM** 真机', '- [ ] 〔进行中〕**F2** y'].join('\n')
    const r = render({ kind: 'checklist', label: 'GOAL', file: '', group: '###', titles: true }, md)
    expect(r.summary).toBe('GOAL 规划完成 1/4 · 进行中 2 · 规划中 1')
    expect(r.detail).toEqual(['PX 1/4 规划中:PX-RUM', '  ▶ PX-G 性能标准(px-d3a-measure)', '  ▶ F2'])
  })

  test('table rows: status column found by header, shown vs counted vs ignored', () => {
    const md = [
      '| # | 功能 | 状态 | 判据 |', '|---|---|---|---|',
      '| G41 | **监察备查包**:一键 | 进行中(G41-a 已上线) | x |',
      '| G35 | 年假台账 | 候选 | x |',
      '| G31 | 补全 | 已上线 2026.10.3 | x |',
    ].join('\n')
    expect(tableRows(md.split('\n')).map(r => r.status)).toEqual(['进行中(G41-a 已上线)', '候选', '已上线 2026.10.3'])
    const r = render({ kind: 'table', label: 'ROADMAP', file: '', show: '^(进行中|已排)', count: '^(候选)' }, md)
    expect(r.summary).toBe('ROADMAP:进行中 1 · 候选 1')
    expect(r.detail).toEqual(['进行中:G41 监察备查包'])
  })

  test('otherapp roadmap: id in bold in the first cell, alert marks risk', () => {
    const md = ['### 现在', '| 项 | 结果 | 状态 |', '|---|---|---|', '| **P0** PayrollCo 生产访问 | x | **Blocked** |', '### 之后', '| 项 | 结果 | 状态 |', '|---|---|---|', '| W2 | y | Blocked |'].join('\n')
    const r = render({ kind: 'table', label: 'R', file: '', heading: '^### 现在', show: '^(Blocked)', alert: 'Blocked' }, md)
    expect(r.detail).toEqual(['Blocked:⚠ P0 PayrollCo 生产访问'])
  })

  test('pending skips closed rows', () => {
    const md = ['| # | 问题 |', '|---|---|', '| 1 | R18 年资 |', '| 3 | ~~试用~~ 关闭 |'].join('\n')
    expect(render({ kind: 'pending', label: '待拍板', file: '' }, md).summary).toBe('待拍板 1')
  })

  test('full roadmap lists every row of the file under its headings, 触发 tables too', () => {
    const md = ['## E · 引擎', '### 核心', '| # | 功能 | 状态 |', '|---|---|---|', '| E1 | 校验:实时 | 已上线 |', '| E2 | 求解 | 候选 |', '## G', '| # | 功能 | 状态 |', '|---|---|---|', '| G1 | 导出 | 进行中 |'].join('\n')
    expect(renderFull({ kind: 'table', label: 'R', file: '', show: 'x' }, md)).toEqual(['E · 引擎 / 核心', '  E1 校验 — 已上线', '  E2 求解 — 候选', '', 'G', '  G1 导出 — 进行中'])
    const later = ['### 之后', '| 项 | 结果 | 触发 |', '|---|---|---|', '| **W2** 销售 | x | W1 出闸 |'].join('\n')
    expect(renderFull({ kind: 'table', label: 'R', file: '', heading: '^### 现在', show: 'x' }, later)).toEqual(['之后', '  W2 销售 — 触发:W1 出闸'])
  })

  test('full GOAL marks each item done / running / planned', () => {
    const md = ['### PX', '- [x] **A**', '- [ ] 〔进行中 r1〕**B**', '- [ ] **C**'].join('\n')
    expect(renderFull({ kind: 'checklist', label: 'GOAL', file: '', group: '###', titles: true }, md)).toEqual(['## PX', '  ✓ A', '  ▶ B(r1)', '  ○ C'])
  })

  test('roadmap tallies per layer: done / running / planned, 不做 skipped', () => {
    const md = ['## E · 引擎', '| # | 功能 | 状态 |', '|---|---|---|', '| E1 | a | 已上线 2026.10.2 |', '| E2 | b | 进行中 |', '| E3 | c | 候选 |', '| E4 | d | 不做 |', '## G', '| # | 功能 | 状态 |', '|---|---|---|', '| G1 | e | 已并 main |'].join('\n')
    expect(roadmapLayers(md)).toEqual([{ name: 'E 引擎', done: 1, running: 1, planned: 1 }, { name: 'G', done: 1, running: 0, planned: 0 }])
  })

  test('bar keeps a cell for a non-zero part and fills the width', () => {
    expect(barCells({ done: 1, running: 1, planned: 98 }, 10)).toEqual({ done: 1, running: 1, planned: 8 })
    expect(barCells({ done: 0, running: 0, planned: 0 }, 5)).toEqual({ done: 0, running: 0, planned: 5 })
    expect(fitCells('性能与体验', 6)).toBe('性能… ')
  })
})

// M8b: board 显示当日模型用量。台账由 piw 写(`~/.omd-lite/usage/<本地日期>.jsonl`),board 只读。
const NEXT_MD = ['最近更新:10.15', '## 现在', '- 生产', '', '**下一步**', '1. **接任务**', ''].join('\n')
const entry = (label: string, model: string, arm: 'primary' | 'fallback', total: number) =>
  JSON.stringify({ at: 1_800_000_000, label, model, arm, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total } })
const USAGE_JSONL = [
  entry('r1', 'minimax-cp/MiniMax-M3.1-Flash-Preview', 'primary', 1_000_000),
  entry('r2', 'minimax-cp/MiniMax-M3.1-Flash-Preview', 'primary', 2_500_000),
  entry('r3', 'deepseek/deepseek-v4-flash', 'fallback', 400_000),
].join('\n')
const USAGE_LINE = '今日 token:MiniMax-M3.1-Flash-Preview 3.5M · deepseek-v4-flash 400.0k(备用 400.0k / 上限 300.0M)'

/** The ledger's own path: HOME + 本地日期, the way piw writes it. */
const ledgerPath = (): string => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `/home/t/.omd-lite/usage/${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`
}

/** A board world: one repo with a `_NEXT.md`, an optional ledger file, no git, no delegate. */
function boardWorld(on: On, env: Record<string, string>, files: Record<string, string> = { '/home/t/repos/myapp/_NEXT.md': NEXT_MD }) {
  mock.env(on, env)
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/t/repos/myapp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('fs.stat', (_, e) => {
    if (!(e.path in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: 10, mtimeMs: 1_800_000_000_000, isLink: false } }
  })
  on('fs.read', (_, e) => {
    if (!(e.path in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: files[e.path]! }
  })
  on('fs.list', () => ({ value: [] }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
}

const boardText = async ($: Engine): Promise<string> => String(((await $.command.run({ command: 'board', args: '' } as never)) as { text?: string }).text)

describe('board: 当日模型用量 (M8b)', () => {
  test('fmtTokens keeps one decimal, and a count under a thousand as it is', () => {
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1234)).toBe('1.2k')
    expect(fmtTokens(1234567)).toBe('1.2M')
    expect(fmtTokens(1234567890)).toBe('1.2B')
  })

  test('parseUsage reads the day\'s jsonl; a line it cannot read is skipped', () => {
    const jsonl = [entry('r1', 'minimax-cp/MiniMax-M3.1-Flash-Preview', 'primary', 10), '{"at":2,"label":"r2",', entry('r3', 'deepseek/deepseek-v4-flash', 'fallback', 400_000)].join('\n')
    expect(parseUsage(jsonl).map(r => r.label)).toEqual(['r1', 'r3'])
  })

  test('usageLine ranks models by tokens and carries the fallback total against the cap', () => {
    expect(usageLine(parseUsage(USAGE_JSONL), 300_000_000)).toBe(USAGE_LINE)
    // the same day written the other way round: the order comes from the tokens, not from the file
    const flipped: UsageRow[] = [
      { at: 2, label: 'r3', model: 'deepseek/deepseek-v4-flash', arm: 'fallback', tokens: { total: 400_000 } },
      { at: 1, label: 'r1', model: 'minimax-cp/MiniMax-M3.1-Flash-Preview', arm: 'primary', tokens: { total: 3_500_000 } },
    ]
    expect(usageLine(flipped, 300_000_000)).toBe(USAGE_LINE)
  })

  test('nothing spent today: no line at all, not a zero', () => {
    expect(usageLine([], 300_000_000)).toBeNull()
  })

  test('the full board shows today\'s ledger after 在跑的片', async ($, on) => {
    boardWorld(on, { HOME: '/home/t' }, { '/home/t/repos/myapp/_NEXT.md': NEXT_MD, [ledgerPath()]: USAGE_JSONL })
    const text = await boardText($)
    expect(text).toContain(`▸ ${USAGE_LINE}`)
    // its place: after the sections, where the 在跑的片 line sits
    expect(text.indexOf('▸ 下一步')).toBeLessThan(text.indexOf('▸ 今日 token'))
  })

  test('the sidebar pane shows today\'s ledger as its own 今日用量 block', async ($, on) => {
    boardWorld(on, { HOME: '/home/t' }, { '/home/t/repos/myapp/_NEXT.md': NEXT_MD, [ledgerPath()]: USAGE_JSONL })
    const clock = mock.clock(on)
    await $.session.start({ cwd: '/home/t/repos/myapp', surface: 'terminal', isInteractive: true } as const)
    await $.command.run({ command: 'board', args: 'open all', presentation: { isFullscreen: true, columns: 170 } } as never)
    const ui = await $.ui.mount({ plugin: 'board', surface: 'terminal', component: 'Pane', requestId: 'board', props: { bodyColumns: 200 } } as never)
    await clock.advance(60_000) // the pane's own tick: builds the model again
    // E-15 of docs/plan/2026-10-23-board-fidelity.md: a titled block, one right-aligned row per model.
    const shown = (await ui.findAll({ type: 'Text' })).map(el => el.text ?? '')
    expect(shown.some(t => t.includes('今日用量 · 3.9M / 300.0M'))).toBe(true)
    expect(shown.some(t => /MiniMax-M3\.1-Flash-Preview\s+3\.5M │$/.test(t))).toBe(true)
    expect(shown.some(t => /deepseek-v4-flash\s+400\.0k │$/.test(t))).toBe(true)
    await ui.unmount()
  })

  test('no ledger file for today: the board reads as before, with no usage line', async ($, on) => {
    boardWorld(on, { HOME: '/home/t' })
    const text = await boardText($)
    expect(text).toContain('▸ 下一步')
    expect(text).not.toContain('今日 token')
  })

  for (const [cap, shown] of [['1000000', '1.0M'], ['abc', '300.0M'], [undefined, '300.0M']] as const) {
    test(`the cap shown is $PIW_DAILY_FALLBACK_TOKEN_CAP (${cap ?? 'unset'} → ${shown}), piw's 300.0M when it is unreadable`, async ($, on) => {
      boardWorld(on, { HOME: '/home/t', ...(cap === undefined ? {} : { PIW_DAILY_FALLBACK_TOKEN_CAP: cap }) }, { '/home/t/repos/myapp/_NEXT.md': NEXT_MD, [ledgerPath()]: USAGE_JSONL })
      expect(await boardText($)).toContain(`▸ 今日 token:MiniMax-M3.1-Flash-Preview 3.5M · deepseek-v4-flash 400.0k(备用 400.0k / 上限 ${shown})`)
    })
  }
})
