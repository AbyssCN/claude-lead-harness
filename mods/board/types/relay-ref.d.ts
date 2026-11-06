// relay's noun, optional: board draws the F handoff row only when relay is installed.
declare module 'claude-code' {
  interface EngineInterface {
    relay?: {
      handoff: () => Promise<{ phase: string; waitAgents: boolean; armedAt: number; clearAt: number; stage: string }>
    }
  }
}
export {}
