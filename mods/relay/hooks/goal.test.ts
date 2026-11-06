import { describe, expect, test } from 'claude-code/testing'

import { agentEffortMap, effortTable, pickEffort } from './effort'
import { acceptance, altitude, appendLedger, checklist, currentItem, endsAsking, GOAL_TEMPLATE, goalPrompt, goalTitle, ledger, ledgerLine, normalizeGoal, parseRelay, SECTIONS, section } from './goal'
import { fit, paneRows } from './pane'
import { resumePrompt } from './parse'
import { goalTemplateHints } from './register'

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
    expect(parseRelay('RELAY: owner 要不要砍掉桌面端?')).toEqual({ kind: 'owner', question: '要不要砍掉桌面端?', recommend: '' })
    expect(parseRelay('RELAY: owner 桌面端砍不砍 | 推荐: 先不砍,量完再定')).toEqual({ kind: 'owner', question: '桌面端砍不砍', recommend: '先不砍,量完再定' })
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

// 高度: the four lines copied verbatim from myapp docs/plan/10.17/GOAL.md §高度 (a9e83e0dc), any order, tail `→ 问 owner:` on one.
const ALT_GOAL = [
  '# GOAL: 让高度节成为常驻闸',
  '## 原话',
  '> 提高 altitude,depth,range,speed',
  '## 终点状态',
  '每份新 GOAL 都带四行高度',
  '## 高度',
  '- **再往上一层**:这套流程做完,owner 下一步想发生的是「任何仓只跟 lead 聊天就能走完 plan → 合并」—— 下一个 GOAL 把 otherapp 装上同一套 workflow check 并合入一片(otherapp 先:owner 第二常用仓,retro 提案已在排队;acme-site 其后)—— 调度,lead 定,不问 owner。',
  '- **长期化**:S13 收片状态机 + S15 依赖前沿 + S2a/S2b 沙箱 + methods-check 四件都是长期在跑的闸 / 读数;「lead 回合数」读数(S11)进 handoff 每日一行。',
  '- **难目标**:lead 每片回合数 ≤ 2(今天无读数,S11 先量基线);收片零人工接力的片占比 ≥ 80%(collect: auto 合并说明计数);一轮过闸率 ≥ 70%。',
  "- **外部判官**:验收节里全部命令都是工具跑的;其中 `sandbox-probe.sh`(T1–T8)· `methods-check.mjs` · `gate-slice.sh` 三条是「模型说了不算」的判官,`git log --merges | grep 'collect: auto'` 是零人工接力的物证。",
  '## 验收',
  '- `true` → exit 0',
].join('\n')

// A GOAL from before 高度 existed: the old template, with 高度 dropped.
const OLD_GOAL = ['# GOAL: 多端适配,性能优先', ...GOAL_TEMPLATE.split('\n').slice(1).filter(l => !l.startsWith('## 高度'))].join('\n')

const blankOut = (md: string, key: string): string => md.replace(new RegExp(`^- \\*\\*${key}\\*\\*:.*$`, 'm'), `- **${key}**:无`)

describe('高度 (altitude)', () => {
  test('the template carries ten sections, 高度 before 验收', () => {
    expect(GOAL_TEMPLATE.split('\n').length).toBe(11)
    expect(SECTIONS.indexOf('高度')).toBe(2)
    expect(GOAL_TEMPLATE.split('\n')[3]).toContain('## 高度')
  })
  test('four lines, all answered, none of them asking owner', () => {
    const a = altitude(ALT_GOAL)
    expect(a.length).toBe(4)
    expect(a.map(x => x.line.startsWith('- **再往上一层**'))).toEqual([true, false, false, false])
    expect(a.map(x => x.filled)).toEqual([true, true, true, true])
    expect(a.map(x => x.asksOwner)).toEqual([false, false, false, false])
  })
  test('a heading that kept the template line still reads', () => {
    const heading = GOAL_TEMPLATE.split('\n')[3] ?? ''
    const md = ALT_GOAL.replace('## 高度', heading)
    expect(altitude(md).map(x => x.filled)).toEqual([true, true, true, true])
  })
  test('the → 问 owner: tail marks the one answer that climbs', () => {
    const md = ALT_GOAL.replace(/^- \*\*再往上一层\*\*:(.*)$/m, (_m, tail: string) => `- **再往上一层**:${tail} → 问 owner:要不要开第二条产品线`)
    expect(altitude(md).map(x => x.asksOwner)).toEqual([true, false, false, false])
  })
  test('「无」 is not an answer', () => {
    expect(altitude(blankOut(ALT_GOAL, '难目标')).map(x => x.filled)).toEqual([true, true, false, true])
  })
  test('a GOAL without the section reads empty, and normalizeGoal backfills no answer', () => {
    expect(section(OLD_GOAL, '高度')).toEqual([])
    expect(altitude(OLD_GOAL)).toEqual([])
    const backfilled = normalizeGoal(OLD_GOAL, '多端适配,性能优先')
    expect(backfilled).toContain('## 高度')
    expect(altitude(backfilled).filter(a => a.filled).length).toBe(0)
  })
  test('an old GOAL without 高度 reads exactly as before', () => {
    expect(section(GOAL, '高度')).toEqual([])
    expect(section(GOAL, '验收')).toEqual(['- `pnpm test` → exit 0', '- `grep -q x y` 退出码 1', '- 人工看一眼(无命令)'])
    expect(checklist(GOAL).map(c => c.isDone)).toEqual([true, false, false])
    expect(acceptance(GOAL).map(a => [a.command, a.exitCode])).toEqual([['pnpm test', 0], ['grep -q x y', 1]])
  })
  test('the prompt names ten headings and the four 高度 lines', () => {
    const p = goalPrompt('x', [], '10.17')
    expect(p.includes('十个二级标题')).toBe(true)
    expect(p.includes('九个二级标题')).toBe(false)
    expect(p.includes('再往上一层')).toBe(true)
  })
  test('/goal 写回来的提示: fewer than two answers is a note beside 已激活, not a rejection', () => {
    const one = blankOut(blankOut(blankOut(ALT_GOAL, '长期化'), '难目标'), '外部判官')
    expect(altitude(one).filter(a => a.filled).length).toBe(1)
    expect(goalTemplateHints(one).join('\n')).toContain('高度节')
    const two = blankOut(blankOut(ALT_GOAL, '长期化'), '难目标')
    expect(altitude(two).filter(a => a.filled).length).toBe(2)
    expect(goalTemplateHints(two).join('\n')).not.toContain('高度节')
    expect(goalTemplateHints(ALT_GOAL).length).toBe(0)
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
