// delegate's contract (C-0, docs/plan/2026-10-10-lead-harness.md): the `$.delegate` noun.
// Consumers (savvy-progress, relay) list delegate under `dependencies`; never copy this file.
export type DelegateExecutor = 'minimax' | 'mcode' | 'pi' | 'claude' | 'other'
export type DelegateState = 'running' | 'pass' | 'fail' | 'not-run' | 'interrupted'
export type DelegateRun = {
  label: string; runDir: string; executor: DelegateExecutor; model?: string
  state: DelegateState; round?: number; maxRounds?: number
  startedAt: number; endedAt?: number; wallSeconds?: number
  stuck?: string; outside?: string[]; failureClass?: string; tool?: string; tokens?: number
}
export type Delegate = { runs: () => Promise<DelegateRun[]> }
declare module 'claude-code' { interface EngineInterface { delegate: Delegate } }
