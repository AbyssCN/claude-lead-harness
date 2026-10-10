// delegate's noun (SDD C-0), typed here as optional: relay does not depend on delegate and reads it
// only when it is installed. Not relay's contract (plugin.json names ./types/index.d.ts alone).
declare module 'claude-code' {
  interface EngineInterface {
    delegate?: { runs: () => Promise<Array<{ label: string; state: string }>> }
  }
}
export {}
