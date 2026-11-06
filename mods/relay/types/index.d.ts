export type Ops = {
  diskFreeGb: number | null
  worktrees: string[]
  decisions: string[]
  runningRuns: string[]
}

// due: past the threshold outside a GOAL / scheduled run — owner is reminded, /relay go hands off; never cleared alone.
// armed: the note asking for a handoff went out; ready: the handoff file is
// written and the clear is scheduled.
// snoozeTokens: after a cancel, or between reminders, ask again only past this context size.
// waitAgents: the agent said ready while subagents were still out; ask it to
// rewrite the handoff once they are all back.
// anchor: anchorOf(owner's last message) when armed; the handoff's first line must carry it, and the clear checks it again.
// auto: armed by relay under a GOAL / scheduled run (cleared after delaySeconds); false = /relay go (cleared at once).
// by: the origin kind of the prompt that armed it, to judge `auto` again at clear time.
// retried: a /relay go handoff whose anchor did not match was sent back once.
export type Handoff = {
  phase: 'idle' | 'due' | 'armed' | 'ready'
  path: string
  armedAt: number
  snoozeTokens: number
  waitAgents: boolean
  anchor: string
  auto: boolean
  by: string
  retried: boolean
  // ready 时排定的 /clear 时刻(ms);board 第 2 行画倒计时用(F 稿 ④)。0 = 没排。
  clearAt: number
}

// owner's last message, as he typed it.
export type LastPerson = { text: string; at: number }
// An answer given after it, which he has not answered yet.
export type Unseen = { at: number; origin: string; text: string }
// A background shell / monitor of this session still running, as the last Stop hook listed it.
export type BgTask = { id: string; type: string; command: string }

// C-4 (frozen): relay writes, cue reads. running = GOAL active and relay drives the loop;
// waiting-owner = stopped at an owner fork; done = acceptance passed; idle = no GOAL or /relay stop.
export type RelayMode = 'idle' | 'running' | 'waiting-owner' | 'done'
export type IdleStall = '' | 'nudged' | 'parked'

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
  // The repo the GOAL was claimed for (relay/bin/owner.mjs keys the owner record by it); older records lack it.
  cwd?: string
}

// Why relay changed a GOAL's mode: the `--why` of `owner.mjs mode` (D-12, frozen list).
export type ModeWhy =
  | 'goal'
  | 'continue'
  | 'owner-parked'
  | 'done-accepted'
  | 'done-failed'
  | 'no-relay-line-twice'
  | 'stuck'
  | 'max-turns'
  | 'goal-clear'
  | 'relay-stop'
  | 'owner-clear'
  | 'resume'
  | 'revive'
  | 'fence'
  | 'relay-clear'

// The first turn after a revive, until it ends (D-6 / D-11). head: `git rev-parse HEAD` at the revive; waits: the GOAL's
// ⏸ lines then, verbatim and in order (a waiting-owner revive turn must leave both as they were).
export type ReviveRound = { kind: 'running' | 'waiting-owner'; head: string; waits: string[] }

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
}

// Who sent the prompt of the turn now running: 'work' (owner, relay, delegate, a loop, a task
// notification) or 'other' (another plugin, a peer); relay reacts to work turns only.
export type RelayOrigin = 'work' | 'other'

// /handoff (shareable, no clear) and the /relay go steps share one row shape.
export type ShareStep = { label: string; detail: string; status: 'wait' | 'run' | 'done' | 'fail'; progress: number }
// The /handoff band: working (steps run), ready (copy / hand off and clear / close), failed (error, the draft, try again).
export type SharePanel = {
  phase: 'working' | 'ready' | 'failed'
  steps: ShareStep[]
  tick: number
  file: string
  chars: number
  error: string
  note: string
}
// Where an armed or ready handoff's clear has got to (the band's last three steps); '' before and after.
export type GoStage = '' | 'flush' | 'side' | 'clear'

declare module 'claude-code' {
  interface PluginState {
    relay: {
      ops: Ops | null
      handoff: Handoff
      diskWarned: boolean
      agents: string[]
      agentTypes: Record<string, string>
      bgTasks: BgTask[]
      lastPerson: LastPerson | null
      unseen: Unseen[]
      turnRunning: boolean
      turnKind: string
      mode: RelayMode
      goal: RelayGoal | null
      view: RelayView | null
      origin: RelayOrigin
      lastEffort: Record<string, string>
      selfClear: boolean
      idleStall: IdleStall
      share: SharePanel | null
      goStage: GoStage
      pendingKickoff: string
      // This session's Claude Code process (the GOAL owner's pid, O-2); 0 until read.
      ownerPid: number
      revive: ReviveRound | null
    }
  }
}
