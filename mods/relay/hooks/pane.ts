// What the GOAL pane shows, as plain rows sized to the pane's body (D-24).

import type { RelayGoal, RelayMode, RelayView } from '../types'

export type Row = { text: string; tone?: 'accent' | 'success' | 'warning' | 'error' | 'dim'; isBold?: boolean }

const MODE_TEXT: Record<RelayMode, { text: string; tone: Row['tone'] }> = {
  idle: { text: '空闲', tone: 'dim' },
  running: { text: '自动续跑', tone: 'success' },
  'waiting-owner': { text: '等 owner 拍板', tone: 'warning' },
  done: { text: '验收通过,已停', tone: 'accent' },
}

// Display width: CJK and full-width glyphs take two cells.
const cells = (ch: string): number => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(ch) ? 2 : 1)

export function fit(text: string, columns: number): string {
  const room = Math.max(4, columns)
  const chars = [...text]
  if (chars.reduce((n, ch) => n + cells(ch), 0) <= room) return text
  let used = 0
  let out = ''
  for (const ch of chars) {
    if (used + cells(ch) > room - 1) break
    used += cells(ch)
    out += ch
  }
  return `${out}…`
}

const bar = (used: number, total: number, width: number): string => {
  const n = Math.max(4, Math.min(20, width))
  const filled = total > 0 ? Math.min(n, Math.round((used / total) * n)) : 0
  return `${'█'.repeat(filled)}${'░'.repeat(n - filled)}`
}

export function paneRows(o: {
  mode: RelayMode
  goal: RelayGoal | null
  view: RelayView | null
  effort: string | undefined
  maxTurns: number
  columns: number
}): Row[] {
  const { mode, goal, view, columns } = o
  const rows: Row[] = []
  const push = (text: string, tone?: Row['tone'], isBold?: boolean): void => {
    rows.push({ text: fit(text, columns), ...(tone ? { tone } : {}), ...(isBold ? { isBold } : {}) })
  }
  if (!goal) {
    push('没有激活的 GOAL', 'dim')
    push('/goal <一句话> 写 GOAL.md 并立刻开跑', 'dim')
    return rows
  }
  push(goal.title || goal.path, undefined, true)
  const m = MODE_TEXT[mode]
  push(`${m.text} · phase ${goal.phase} · effort ${o.effort ?? '默认'}`, m.tone)
  push(`轮次 ${goal.turns}/${o.maxTurns}${goal.lastEvent ? ` · ${goal.lastEvent}` : ''}`, 'dim')
  if (view) {
    const k = (n: number): string => `${Math.round(n / 1000)}k`
    const room = Math.max(4, Math.min(20, columns - 22))
    push(`上下文 ${bar(view.contextTokens, view.threshold, room)} ${k(view.contextTokens)}/${k(view.threshold)}`, view.contextTokens >= view.threshold ? 'warning' : undefined)
    const done = view.checklist.filter(c => c.isDone).length
    push('')
    push(`清单 ${done}/${view.checklist.length}`, undefined, true)
    for (const c of view.checklist) push(`${c.isDone ? '☑' : '☐'} ${c.text}`, c.isDone ? 'dim' : c.text === goal.item ? 'accent' : undefined)
    if (view.ledger.length) {
      push('')
      push('改道账', undefined, true)
      for (const l of view.ledger.slice(-3)) push(l.replace(/^[-*]\s*/, ''), 'dim')
    }
    push('')
    if (view.runs !== null) push(`run:${view.runs}`)
    if (view.gateSlots !== null) push(`闸槽:${view.gateSlots}`, 'dim')
    if (view.diskFreeGb !== null) push(`磁盘:${view.diskFreeGb} GB`, view.diskFreeGb < (view.diskMinGb ?? 50) ? 'error' : 'dim')
  }
  push(fit(goal.path, columns), 'dim')
  return rows
}
