export type PlanStatus = 'pending' | 'in_progress' | 'completed'
export type PlanStep = { text: string; status: PlanStatus; doneAt?: string; id?: string }
export type Plan = { title: string; steps: PlanStep[]; updatedAt: string }
type StepIn = { text: string; status: PlanStatus; id?: string }

export const PLAN_TOOL_NAME = 'plan'
const TOOL = 'mcp__board__plan'
export const PLAN_PROMPT =
  `Your to-do list is the ${TOOL} tool (this app has no TodoWrite). The user watches it as a progress bar. ` +
  'Use it only for long work: 4 or more distinct steps that will take many tool calls (building a feature, a multi-file change, dispatching helpers). ' +
  'Do not use it for questions, lookups, comparisons, short fixes or anything you finish in a few tool calls: each call costs the user a model round trip. ' +
  'When you do use it, call it once at the start with every step, again when a step finishes, and mark the last step completed before your final answer. ' +
  'A step that launches subagents is one step.'

// Long work only (owner 10.23: a plain question went through board plan and slowed the turn).
export const NUDGE_AFTER = 12
export const STALE_AFTER = 8
export const DONE_HOLD_MS = 20_000
const NUDGE_NEW = `Board: you have no plan for this task yet. Call ${TOOL} now with every step in order, so the user sees your progress.`
const NUDGE_STALE = `Board: the plan has not changed in a while. If a step finished, call ${TOOL} with the full list now.`

const STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed']
const isStatus = (v: unknown): v is PlanStatus => typeof v === 'string' && (STATUSES as readonly string[]).includes(v)
const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim()
const str = (v: unknown) => (typeof v === 'string' ? oneLine(v) : '')

export function planPath(home: string, sessionId: string): string {
  return `${home}/.claude/mods-state/plan-${sessionId}.json`
}

const isDone = (p: Plan | null) => !!p && p.steps.length > 0 && p.steps.every(st => st.status === 'completed')

function apply(prev: Plan | null, title: string | undefined, incoming: StepIn[], now: string): Plan {
  const allDone = incoming.length > 0 && incoming.every(st => st.status === 'completed')
  const fresh = !prev || (isDone(prev) && !allDone)
  const old = fresh ? [] : prev!.steps
  const used = new Set<number>()
  const steps = incoming.map(st => {
    const i = old.findIndex((o, k) => !used.has(k) && (st.id ? o.id === st.id : o.text === st.text))
    if (i >= 0) used.add(i)
    const was = i >= 0 ? old[i] : undefined
    const step: PlanStep = { text: st.text, status: st.status, ...(st.id ? { id: st.id } : {}) }
    if (st.status === 'completed') step.doneAt = was?.status === 'completed' && was.doneAt ? was.doneAt : now
    return step
  })
  return { title: title?.trim() || (fresh ? '计划' : prev!.title), steps, updatedAt: now }
}

const keep = (st: PlanStep): StepIn => ({ text: st.text, status: st.status, ...(st.id ? { id: st.id } : {}) })

/** The plan tool, TodoWrite, TaskCreate and TaskUpdate all feed one plan. */
export function planFromCall(tool: string, input: Record<string, unknown>, prev: Plan | null, now: string): Plan | null {
  if (tool === TOOL || tool === PLAN_TOOL_NAME) {
    const raw = Array.isArray(input.steps) ? (input.steps as unknown[]) : []
    const steps: StepIn[] = []
    for (const s of raw) {
      const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
      const text = str(o.text)
      if (text) steps.push({ text, status: isStatus(o.status) ? o.status : 'pending' })
    }
    return apply(prev, typeof input.title === 'string' ? input.title : undefined, steps, now)
  }
  if (tool === 'TodoWrite') {
    const todos = Array.isArray(input.todos) ? (input.todos as unknown[]) : []
    const steps: StepIn[] = []
    for (const t of todos) {
      const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
      const text = str(o.content)
      if (text) steps.push({ text, status: isStatus(o.status) ? o.status : 'pending' })
    }
    return apply(prev, undefined, steps, now)
  }
  const current: StepIn[] = prev && !isDone(prev) ? prev.steps.map(keep) : []
  if (tool === 'TaskCreate') {
    const text = str(input.subject)
    if (!text) return null
    const id = typeof input.taskId === 'string' ? input.taskId : undefined
    return apply(prev, undefined, [...current, { text, status: 'pending', ...(id ? { id } : {}) }], now)
  }
  if (tool !== 'TaskUpdate') return null
  // An unknown task id with a subject joins the list.
  const id = typeof input.taskId === 'string' ? input.taskId : ''
  const all: StepIn[] = prev ? prev.steps.map(keep) : []
  const i = all.findIndex(st => st.id === id)
  const subject = str(input.subject)
  if (input.status === 'deleted') return i >= 0 ? apply(prev, undefined, all.filter((_, k) => k !== i), now) : null
  const status = isStatus(input.status) ? input.status : undefined
  if (i < 0) return subject ? apply(prev, undefined, [...current, { text: subject, status: status ?? 'pending', id }], now) : null
  all[i] = { ...all[i]!, ...(subject ? { text: subject } : {}), ...(status ? { status } : {}) }
  return apply(prev, undefined, all, now)
}

/** Caller keeps the once-per-turn / once-per-stretch flags; this only picks the text. */
export function nudgeFor(state: { turnCalls: number; planned: boolean; sinceUpdate: number; live: boolean }): string | null {
  if (!state.planned && !state.live && state.turnCalls >= NUDGE_AFTER) return NUDGE_NEW
  if (state.live && state.sinceUpdate >= STALE_AFTER) return NUDGE_STALE
  return null
}
