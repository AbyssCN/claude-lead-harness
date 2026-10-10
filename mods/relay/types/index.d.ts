export type Ops = {
  diskFreeGb: number | null
  worktrees: string[]
  decisions: string[]
  runningRuns: string[]
}

// armed: the note asking for a handoff went out; ready: the handoff file is
// written and the clear is scheduled for `clearAt`.
// snoozeTokens: after a cancel, ask again only past this context size.
// waitAgents: the agent said ready while subagents were still out; ask it to
// rewrite the handoff once they are all back.
export type Handoff = { phase: 'idle' | 'armed' | 'ready'; path: string; armedAt: number; snoozeTokens: number; waitAgents: boolean }

// C-4 (frozen): relay writes, cue reads. running = GOAL active and relay drives the loop;
// waiting-owner = stopped at an owner fork; done = acceptance passed; idle = no GOAL or /relay stop.
export type RelayMode = 'idle' | 'running' | 'waiting-owner' | 'done'

// The active GOAL and its loop counters. Mirrored to $.store under `goal:<cwd>` so a restart can re-arm.
export type RelayGoal = {
  path: string
  title: string
  phase: string
  item: string
  // Turns relay has reacted to under this GOAL (budget: userConfig maxTurns).
  turns: number
  // Consecutive answers that ended without a RELAY line or on a question (D-14).
  nudges: number
  // Stuck guard: same phase+item with HEAD unchanged.
  stuckKey: string
  stuckHead: string
  stuckCount: number
  // Bumped on every main-loop turn end; a heartbeat armed under an older value is stale.
  waitGen: number
  // The GOAL's effort table (phase → effort), re-read on every wake.
  efforts: Record<string, string>
  startedAt: number
  sessionId: string
  lastEvent: string
}

export type RelayCheck = { isDone: boolean; text: string }

// What the pane draws; refreshed whenever relay reads the GOAL or measures the session.
export type RelayView = {
  checklist: RelayCheck[]
  ledger: string[]
  contextTokens: number
  threshold: number
  runs: string | null
  gateSlots: number | null
  diskFreeGb: number | null
  // userConfig diskMinGB; below it the disk row turns red (0 = never).
  diskMinGb?: number
}

// Who sent the prompt of the turn now running: 'work' (the user, relay, delegate, a loop, a task
// notification) or 'other' (another plugin, a peer); relay reacts to work turns only.
export type RelayOrigin = 'work' | 'other'

declare module 'claude-code' {
  interface PluginState {
    relay: {
      ops: Ops | null
      handoff: Handoff
      diskWarned: boolean
      agents: string[]
      agentTypes: Record<string, string>
      turnRunning: boolean
      mode: RelayMode
      goal: RelayGoal | null
      view: RelayView | null
      origin: RelayOrigin
      lastEffort: Record<string, string>
      selfClear: boolean
    }
  }
}
