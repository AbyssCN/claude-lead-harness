import { describe, expect, test } from 'claude-code/testing'

import { barCells, byVersionDesc, fitCells, itemTitle, render, renderFull, roadmapLayers, tableRows, under } from './parse'

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

  test('list after a marker, with a stamp (next-md layout _NEXT shape)', () => {
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

  test('in-progress marker: 〔进行中 run〕 splits running from planned', () => {
    const md = ['### PX', '- [x] A', '- [ ] 〔进行中 px-d3a-measure〕**PX-G 性能标准**:x', '- [ ] **PX-RUM** 真机', '- [ ] 〔进行中〕**F2** y'].join('\n')
    const r = render({ kind: 'checklist', label: 'GOAL', file: '', group: '###', titles: true }, md)
    expect(r.summary).toBe('GOAL 规划完成 1/4 · 进行中 2 · 规划中 1')
    expect(r.detail).toEqual(['PX 1/4 规划中:PX-RUM', '  ▶ PX-G 性能标准(px-d3a-measure)', '  ▶ F2'])
  })

  test('table rows: status column found by header, shown vs counted vs ignored', () => {
    const md = [
      '| # | 功能 | 状态 | 判据 |', '|---|---|---|---|',
      '| G41 | **导出报表**:一键 | 进行中(G41-a 已上线) | x |',
      '| G35 | 暗色模式 | 候选 | x |',
      '| G31 | 补全 | 已上线 2026.10.3 | x |',
    ].join('\n')
    expect(tableRows(md.split('\n')).map(r => r.status)).toEqual(['进行中(G41-a 已上线)', '候选', '已上线 2026.10.3'])
    const r = render({ kind: 'table', label: 'ROADMAP', file: '', show: '^(进行中|已排)', count: '^(候选)' }, md)
    expect(r.summary).toBe('ROADMAP:进行中 1 · 候选 1')
    expect(r.detail).toEqual(['进行中:G41 导出报表'])
  })

  test('status-next roadmap: id in bold in the first cell, alert marks risk', () => {
    const md = ['### 现在', '| 项 | 结果 | 状态 |', '|---|---|---|', '| **P0** 支付网关生产访问 | x | **Blocked** |', '### 之后', '| 项 | 结果 | 状态 |', '|---|---|---|', '| W2 | y | Blocked |'].join('\n')
    const r = render({ kind: 'table', label: 'R', file: '', heading: '^### 现在', show: '^(Blocked)', alert: 'Blocked' }, md)
    expect(r.detail).toEqual(['Blocked:⚠ P0 支付网关生产访问'])
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
