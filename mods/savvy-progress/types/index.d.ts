export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  tier: string
  after: number[]
}

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
}

/** An omd-lite run launched from this session (its meta.json names the session). Mapped from delegate's `$.delegate.runs()`. */
export type OmdRun = {
  id: string
  label: string
  executor: string
  spec: string
  model: string
  status: AgentStatus
  /** exec: the executor works; gate: the gates run; end: result.json written or the driver gone. */
  phase: 'exec' | 'gate' | 'end'
  /** Why a run failed: the stuck reason, the failed gate, or `interrupted`. */
  note: string
  round: number
  maxRounds: number
  toolCalls: number
  lastTool: string
  message: string
  tokens: number
  contextTokens: number
  startedAt: number
  endedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      now: number
      omd: OmdRun[]
      omdDismissed: string[]
    }
  }
}
