// Effort per phase (D-12 / D-13 / INV-9): the GOAL's effort table for the main loop,
// a userConfig map by agent type for subagents.

import { section } from './goal'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const DEFAULT_EFFORT: Readonly<Record<string, Effort>> = { plan: 'xhigh', build: 'medium', review: 'high', chore: 'low' }

const PAIR = /([A-Za-z][\w-]*|[\p{Script=Han}]+)\s*(?:=|→|->|:|：|\|)\s*(low|medium|high|xhigh|max)\b/giu

function pairs(text: string): Record<string, Effort> {
  const out: Record<string, Effort> = {}
  for (const m of text.matchAll(PAIR)) {
    const key = m[1]?.trim()
    const effort = m[2]?.toLowerCase() as Effort | undefined
    if (key && effort && key.toLowerCase() !== 'phase' && key.toLowerCase() !== 'effort') out[key] = effort
  }
  return out
}

// `- plan=xhigh` · `build → medium` · `| review | high |`; the defaults fill phases the table leaves out.
export function effortTable(goalMd: string): Record<string, Effort> {
  const table: Record<string, Effort> = {}
  for (const [k, v] of Object.entries(pairs(section(goalMd, 'effort').join('\n')))) table[k.toLowerCase()] = v
  return { ...DEFAULT_EFFORT, ...table }
}

// userConfig `subagentEffort`: `Explore=low, Plan=high, general-purpose=medium`.
export const agentEffortMap = (config: string): Record<string, Effort> => pairs(config.replace(/,/g, '\n'))

// What a request should ask for: the phase's effort on the main loop while relay runs;
// the agent type's mapped effort for a subagent; null leaves the request as it is.
export function pickEffort(o: {
  isRunning: boolean
  phase: string
  table: Readonly<Record<string, Effort>>
  isSubagent: boolean
  agentType?: string
  agentMap: Readonly<Record<string, Effort>>
}): Effort | null {
  if (o.isSubagent) return o.agentType ? (o.agentMap[o.agentType] ?? null) : null
  if (!o.isRunning) return null
  return o.table[o.phase.toLowerCase()] ?? null
}
