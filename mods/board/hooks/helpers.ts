import type { CostumeKey } from './sprites'

export type Helper = {
  id: string
  label: string
  costume: CostumeKey
  phase: 'working' | 'done' | 'failed'
  step: string
  tokens: number | null
  startedAt: number
  round?: number
  maxRounds?: number
}

const TIERS = new Set<CostumeKey>(['fable', 'heavy', 'careful', 'medium', 'light'])

const tierOf = (type: string): CostumeKey => {
  const bare = type.replace(/^[^:]*:/, '')
  if (!bare.startsWith('savvy-')) return 'other'
  const t = bare.slice('savvy-'.length).toLowerCase() as CostumeKey
  return TIERS.has(t) ? t : 'other'
}

// D-4 of docs/plan/2026-10-23-board-fidelity.md: $.agent.list()'s status is the truth; pending, running and
// waiting (a subagent waiting on its own background work) all count as working.
const agentPhase = (status: string): Helper['phase'] =>
  status === 'completed' || status === 'idle' ? 'done' : status === 'failed' || status === 'killed' ? 'failed' : 'working'

/** A subagent's card; `calls` (its tool calls so far) rides in `round`, with no `maxRounds`: a subagent has no known total. */
export function helperFromAgent(a: { id: string; type: string; description?: string; status: string; startedAt: number; contextTokens?: number; calls?: number }): Helper {
  return {
    ...(typeof a.calls === 'number' ? { round: a.calls } : {}),
    id: a.id,
    label: a.description || a.type,
    costume: a.type === 'Explore' ? 'explore' : tierOf(a.type),
    phase: agentPhase(a.status),
    step: a.description ?? '',
    tokens: typeof a.contextTokens === 'number' ? a.contextTokens : null,
    startedAt: a.startedAt,
  }
}

export function helperFromRun(r: { id: string; label: string; executor: string; model?: string; state: string; startedAt: number; round?: number; maxRounds?: number }): Helper {
  const minimax = r.executor === 'mcode' || r.executor === 'minimax' || /minimax/i.test(r.model ?? '')
  return {
    id: r.id,
    label: r.label,
    costume: minimax ? 'minimax' : 'other',
    phase: r.state === 'running' ? 'working' : r.state === 'fail' || r.state === 'interrupted' ? 'failed' : 'done',
    step: '',
    tokens: null,
    startedAt: r.startedAt,
    ...(typeof r.round === 'number' ? { round: r.round } : {}),
    ...(typeof r.maxRounds === 'number' ? { maxRounds: r.maxRounds } : {}),
  }
}

export function frameOf(tick: number, phase: Helper['phase']): number {
  return phase === 'working' ? tick % 2 : 0
}
