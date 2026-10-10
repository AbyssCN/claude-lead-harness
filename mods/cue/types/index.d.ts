export type Cue = { title: string; prompt: string }
export type CueSet = { turnId: string; items: Cue[] }

/** C-4: relay's session mode, read only here; declared locally (no dependency on relay). */
export type RelayMode = 'idle' | 'running' | 'waiting-owner' | 'done'

declare module 'claude-code' {
  interface PluginState {
    cue: { current: CueSet | null }
    relay: { mode: RelayMode }
  }
}
