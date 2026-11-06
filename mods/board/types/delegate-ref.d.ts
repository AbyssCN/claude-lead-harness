// delegate's noun (lead-harness SDD C-0), optional: board reads it only when delegate is installed.
declare module 'claude-code' {
  interface EngineInterface {
    delegate?: {
      runs: () => Promise<
        Array<{ label: string; state: string; executor?: string; id?: string; model?: string; round?: number; maxRounds?: number; startedAt?: number }>
      >
    }
  }
}
export {}
