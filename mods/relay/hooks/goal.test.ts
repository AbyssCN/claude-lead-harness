import { describe, expect, test } from 'claude-code/testing'

import { agentEffortMap, effortTable, pickEffort } from './effort'
import { acceptance, appendLedger, checklist, currentItem, endsAsking, goalTitle, ledger, ledgerLine, normalizeGoal, parseRelay, section } from './goal'
import { fit, paneRows } from './pane'
import { resumePrompt } from './parse'

const GOAL = [
  '# GOAL: 多端适配,性能优先',
  '## 原话',
  '> 多端适配,性能优先',
  '## 终点状态',
  '手机和桌面都能用',
  '## 验收',
  '- `pnpm test` → exit 0',
  '- `grep -q x y` 退出码 1',
  '- 人工看一眼(无命令)',
  '## 清单',
  '- [x] 量基线 a1b2c3',
  '- [ ] 修 header',
  '- [ ] 修 footer',
  '## 抢占规则',
  '- p95 > 300 ms',
  '## 停机条件',
  'done / owner / stuck',
  '## 不许停的情况',
  '整理完不是停机条件',
  '## effort          phase → effort',
  '- plan=xhigh · build=low',
  '- review → high',
  '## 改道账',
  '- 10.09 10:00 · 触发 x · → y',
].join('\n')

describe('RELAY line (C-2)', () => {
  test('the four kinds', () => {
    expect(parseRelay('做完了一步。\nRELAY: continue phase=build')).toEqual({ kind: 'continue', phase: 'build' })
    expect(parseRelay('ok\n`RELAY: continue`')).toEqual({ kind: 'continue', phase: null })
    expect(parseRelay('全过\n**RELAY: done**')).toEqual({ kind: 'done' })
    expect(parseRelay('RELAY: owner 要不要砍掉桌面端?')).toEqual({ kind: 'owner', question: '要不要砍掉桌面端?' })
    expect(parseRelay('RELAY: replan 延迟回归 -> 修 p95')).toEqual({ kind: 'replan', reason: '延迟回归', item: '修 p95' })
    expect(parseRelay('RELAY: replan 主干红 → 修 CI')).toEqual({ kind: 'replan', reason: '主干红', item: '修 CI' })
  })
  test('only the last line counts', () => {
    expect(parseRelay('RELAY: done\n然后我又说了一句')).toEqual({ kind: 'none' })
    expect(parseRelay('')).toEqual({ kind: 'none' })
  })
  test('questions and option menus are violations (D-14)', () => {
    expect(endsAsking('整理好了,要不要继续?\nRELAY: continue phase=build')).toBe(true)
    expect(endsAsking('A. 先修 header\nB. 先修 footer\nRELAY: continue phase=build')).toBe(true)
    expect(endsAsking('header 已修,提交 abc。\nRELAY: continue phase=build')).toBe(false)
  })
})

describe('GOAL.md (C-1)', () => {
  test('sections, title, checklist, ledger', () => {
    expect(goalTitle(GOAL)).toBe('多端适配,性能优先')
    expect(section(GOAL, '终点状态')).toEqual(['手机和桌面都能用'])
    expect(checklist(GOAL).map(c => c.isDone)).toEqual([true, false, false])
    expect(currentItem(GOAL)).toBe('修 header')
    expect(ledger(GOAL)).toEqual(['- 10.09 10:00 · 触发 x · → y'])
  })
  test('acceptance: code spans are commands, exit codes default to 0', () => {
    expect(acceptance(GOAL).map(a => [a.command, a.exitCode])).toEqual([
      ['pnpm test', 0],
      ['grep -q x y', 1],
    ])
  })
  test('ledger appends inside 改道账, before the next section', () => {
    const md = appendLedger(`${GOAL}\n\n## 附注\nx`, ledgerLine(Date.UTC(2026, 9, 10, 9, 5), '延迟回归', '修 p95'))
    const lines = ledger(md)
    expect(lines.length).toBe(2)
    expect(lines[1]).toMatch(/^- \d\d\.\d\d \d\d:\d\d · 触发 延迟回归 · → 修 p95$/)
    expect(md.includes('## 附注\nx')).toBe(true)
  })
  test('normalize keeps the line verbatim and fills missing sections', () => {
    const md = normalizeGoal('```markdown\n# GOAL: x\n## 验收\n- `true`\n```', '原样的一句话')
    expect(md.startsWith('# GOAL: x')).toBe(true)
    for (const s of ['## 原话', '## 终点状态', '## 验收', '## 清单', '## 抢占规则', '## 停机条件', '## 不许停的情况', '## effort', '## 改道账']) expect(md.includes(s)).toBe(true)
    expect(section(md, '原话')).toContain('> 原样的一句话')
    expect(md.includes('```')).toBe(false)
  })
})

describe('effort (D-12, INV-9)', () => {
  test('table from the GOAL over the defaults', () => {
    expect(effortTable(GOAL)).toEqual({ plan: 'xhigh', build: 'low', review: 'high', chore: 'low' })
    expect(effortTable('# GOAL: x')).toEqual({ plan: 'xhigh', build: 'medium', review: 'high', chore: 'low' })
  })
  test('main loop only while running; subagents by type', () => {
    const table = effortTable(GOAL)
    const agentMap = agentEffortMap('Explore=low, Plan=high')
    expect(pickEffort({ isRunning: true, phase: 'build', table, isSubagent: false, agentMap })).toBe('low')
    expect(pickEffort({ isRunning: false, phase: 'build', table, isSubagent: false, agentMap })).toBe(null)
    expect(pickEffort({ isRunning: true, phase: 'wait', table, isSubagent: false, agentMap })).toBe(null)
    expect(pickEffort({ isRunning: true, phase: 'build', table, isSubagent: true, agentType: 'Plan', agentMap })).toBe('high')
    expect(pickEffort({ isRunning: true, phase: 'build', table, isSubagent: true, agentMap })).toBe(null)
  })
})

describe('handoff carries the GOAL (D-20)', () => {
  test('resume prompt names the active GOAL and its phase', () => {
    const p = resumePrompt('/h.md', null, [], { path: '/r/docs/plan/10.10/GOAL.md', phase: 'build' })
    expect(p.includes('/r/docs/plan/10.10/GOAL.md(phase=build)')).toBe(true)
    expect(resumePrompt('/h.md').includes('激活中的 GOAL')).toBe(false)
  })
})

describe('pane rows', () => {
  test('fits CJK by cells and lists the checklist', () => {
    expect(fit('一二三四五六', 7)).toBe('一二三…')
    expect(fit('abc', 7)).toBe('abc')
    const rows = paneRows({
      mode: 'running',
      goal: { path: '/g.md', title: 'T', phase: 'build', item: '修 header', turns: 3, nudges: 0, stuckKey: '', stuckHead: '', stuckCount: 0, waitGen: 0, efforts: {}, startedAt: 0, sessionId: 's', lastEvent: '' },
      view: { checklist: checklist(GOAL), ledger: ledger(GOAL), contextTokens: 100_000, threshold: 500_000, runs: null, gateSlots: 4, diskFreeGb: 80 },
      effort: 'medium',
      maxTurns: 200,
      columns: 40,
    })
    const text = rows.map(r => r.text)
    expect(text).toContain('☑ 量基线 a1b2c3')
    expect(text).toContain('☐ 修 header')
    expect(text.some(t => t.includes('phase build · effort medium'))).toBe(true)
  })
})
