export type LastPrompt = { text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'prompt-guard': { last: LastPrompt | null }
  }
}
