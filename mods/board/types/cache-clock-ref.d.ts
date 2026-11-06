// cache-clock's noun (SDD 片 7 frozen interface), optional: board draws ◷ only when cache-clock is installed.
declare module 'claude-code' {
  interface EngineInterface {
    cacheClock?: {
      state: () => Promise<{ lastEnd: number; ttlMs: number; warm: { startedAt: number; windowMs: number; pings: number } | null }>
    }
  }
}
export {}
