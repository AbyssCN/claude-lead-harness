// delegate's contract (C-0, docs/plan/2026-10-10-lead-harness.md): the `$.delegate` noun.
// Consumers (savvy-progress, relay) list delegate under `dependencies`; never copy this file.
export type DelegateExecutor = 'minimax' | 'mcode' | 'pi' | 'claude' | 'other'
export type DelegateState = 'running' | 'pass' | 'fail' | 'not-run' | 'interrupted'
export type DelegateRun = {
  label: string; runDir: string; executor: DelegateExecutor; model?: string
  state: DelegateState; round?: number; maxRounds?: number
  startedAt: number; endedAt?: number; wallSeconds?: number
  stuck?: string; outside?: string[]; failureClass?: string; tool?: string; tokens?: number
  /** Dollars the executor's provider billed (pi usage lines, meta at the end); absent when it billed nothing, e.g. a subscription. */
  costUsd?: number
}
export type Delegate = {
  /** The runs launched from this session (and its /clear lineage). */
  runs: () => Promise<DelegateRun[]>
  /** G-5: the runs of every session, and the ones omdl-queue.sh / slot-run.sh start (cross-session; ops views, not handoffs). Same shape as `runs`. */
  allRuns: () => Promise<DelegateRun[]>
}
/** A run that died with no result (shape of hooks/logic.ts `Orphan`; the contract must be self-contained). */
export type DelegateOrphan = {
  label: string; repo: string; base: string; worktree: string; branch: string; spec: string; prompt: string
  gates: string[]; maxRounds?: number; role?: string; executor?: string; model?: string
  context: boolean; claudeSession?: string; startedAt: number
}
declare module 'claude-code' {
  interface EngineInterface { delegate: Delegate }
  interface PluginState { delegate: { orphans: DelegateOrphan[] } }
}
