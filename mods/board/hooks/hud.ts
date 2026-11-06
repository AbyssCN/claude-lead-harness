// The two lines above the prompt (SDD D-11..D-13), as pure text segments; register.tsx colours and draws them.

const FAMILIES: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' }

/** `claude-opus-5-5` → `Opus 5.5`; an id it cannot read comes back as is. */
export function modelShort(id: string): string {
  const bare = id.replace(/\[1m\]$/i, '')
  const a = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(bare)
  if (a) return `${FAMILIES[a[1]!.toLowerCase()]} ${a[2]}${a[3] ? `.${a[3]}` : ''}`
  const b = /claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)/i.exec(bare)
  if (b) return `${FAMILIES[b[3]!.toLowerCase()]} ${b[1]}${b[2] ? `.${b[2]}` : ''}`
  return FAMILIES[bare.toLowerCase()] ?? bare
}

/** Time to a reset: `59m`, `3h05m`, `6d 9h`; past or unreadable → ''. */
export function untilReset(resetsAt: string | undefined, now: number): string {
  const t = resetsAt ? Date.parse(resetsAt) : NaN
  if (!Number.isFinite(t) || t <= now) return ''
  const m = Math.ceil((t - now) / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** A bar of `w` cells for a 0..100 share. */
export function bar(pct: number, w: number): { on: string; off: string } {
  const n = Math.max(0, Math.min(w, Math.round((pct / 100) * w)))
  return { on: '█'.repeat(n), off: '░'.repeat(w - n) }
}

const pctText = (p: number) => `${Math.round(p)}%`

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Line1In = {
  model: string | null
  effort: string | null
  repo: string
  branch: string
  dirty: boolean
  ahead: number
  ctxPercent: number | undefined
  limits: Limit[]
  now: number
}
/** A segment: its text, a bar (percent) when it has one, a tone. */
export type Seg = { text: string; pct?: number; tail?: string; tone?: 'accent' | 'warn' | 'dim' }

/** Line 1: model·effort │ repo ⎇ branch* ↑N │ ctx │ 5h │ 周. A figure the engine did not give is `—` (D-13). */
export function line1(i: Line1In): Seg[][] {
  const out: Seg[][] = []
  const who = [i.model ? modelShort(i.model) : null, i.effort].filter(Boolean).join('·')
  if (who) out.push([{ text: who, tone: 'accent' }])
  if (i.repo) {
    const where: Seg[] = [{ text: `${i.repo}${i.branch ? ` ⎇ ${i.branch}${i.dirty ? '*' : ''}` : ''}` }]
    if (i.ahead > 0) where.push({ text: ` ↑${i.ahead}`, tone: i.ahead >= 5 ? 'warn' : 'dim' })
    out.push(where)
  }
  const gauge = (label: string, p: number | undefined, tail = ''): Seg[] =>
    p === undefined ? [{ text: `${label} —`, tone: 'dim' }] : [{ text: `${label} `, pct: p, tail: ` ${pctText(p)}${tail ? ` ${tail}` : ''}` }]
  out.push(gauge('ctx', i.ctxPercent))
  const five = i.limits.find(l => l.kind === 'five_hour')
  out.push(gauge('5h', five?.percentUsed, five ? untilReset(five.resetsAt, i.now) : ''))
  const week = i.limits.find(l => l.kind === 'seven_day')
  out.push(week ? [{ text: `周 ${pctText(week.percentUsed)}` }] : [{ text: '周 —', tone: 'dim' }])
  return out
}

/** Minutes the cache stays warm, from cache-clock's state; null when there is nothing to show. */
export function cacheMinutes(s: { lastEnd: number; ttlMs: number } | null | undefined, now: number): number | null {
  if (!s || !s.lastEnd) return null
  return Math.max(0, Math.ceil((s.lastEnd + s.ttlMs - now) / 60_000))
}

/** cache-clock's `state()` as board reads it: the frozen fields, and the optional ones cache-clock 0.x adds for the ◷ buttons. */
export type CacheIn = {
  lastEnd: number
  ttlMs: number
  warm: { startedAt: number; windowMs: number; pings: number; usd?: number | null } | null
  idleSince?: number | null
  nudge?: 'none' | 'warm' | 'stopped' | 'cold'
  tokens?: number
  coldUsd?: number | null
  maxPings?: number
  stopped?: string
  handoffSince?: number | null
  /** 主对话这一轮在跑(cache-clock 0.4);false = 一轮已结束，只剩子 agent / delegate 在跑。 */
  turn?: boolean
}
export type CacheView =
  | { state: 'working' }
  | { state: 'idle'; min: number }
  | { state: 'remind'; min: number; tokens: number; usd: number | null }
  | { state: 'warming'; leftMs: number; windowMs: number; pings: number; maxPings: number; usd: number | null }
  | { state: 'stopped'; why: string }
  | { state: 'cold'; tokens: number; usd: number | null }
  | { state: 'flushing' }
  | { state: 'ho-write' }
  | { state: 'ho-wait'; min: number }
  | { state: 'ho-count'; sec: number }
  | { state: 'ho-flush' }

/** relay 的 `$.relay.handoff()`(relay 0.x 起):交接阶段、何时 /clear、在不在补存 checkpoint。 */
export type RelayIn = { phase: string; waitAgents: boolean; armedAt: number; clearAt: number; stage: string }

/** F 稿 ④:交接进行时第 2 行右段画哪一态;null = 没在交接，照旧画 ◷。 */
export function handoffView(r: RelayIn | null | undefined, now: number): CacheView | null {
  if (!r) return null
  if (r.stage === 'flush') return { state: 'ho-flush' }
  if (r.phase === 'armed') return r.waitAgents ? { state: 'ho-wait', min: Math.max(0, Math.floor((now - r.armedAt) / 60_000)) } : { state: 'ho-write' }
  if (r.phase !== 'ready') return null
  if (r.clearAt > now) return { state: 'ho-count', sec: Math.ceil((r.clearAt - now) / 1000) }
  return { state: 'ho-wait', min: Math.max(0, Math.floor((now - r.clearAt) / 60_000)) }
}

/**
 * Which G row the ◷ segment draws (缓存 v2 D-6): 写交接中 while a cold handoff writes, ● while anything works,
 * the warm bar while warming, then nudge's remind / stopped / cold, else minutes left. null = draw the old `◷ —`
 * (no cache-clock, no reply yet, or a cache-clock without idleSince).
 */
export function cacheView(s: CacheIn | null | undefined, now: number): CacheView | null {
  if (!s || s.idleSince === undefined) return null
  if (s.handoffSince) return { state: 'flushing' }
  // owner 10.23:一轮结束、只剩子 agent 在跑也算「刚停手」,画 ◷ 分钟，不画绿点。
  if (s.idleSince === null && s.turn !== false) return { state: 'working' }
  if (s.warm) {
    const leftMs = s.warm.startedAt + s.warm.windowMs - now
    return { state: 'warming', leftMs, windowMs: s.warm.windowMs, pings: s.warm.pings, maxPings: s.maxPings ?? 30, usd: s.warm.usd ?? null }
  }
  if (!s.lastEnd) return null
  const min = cacheMinutes(s, now) ?? 0
  const tokens = s.tokens ?? 0
  const usd = s.coldUsd ?? null
  if (s.idleSince === null) return min === 0 ? { state: 'cold', tokens, usd } : { state: 'idle', min }
  if (s.nudge === 'cold' || min === 0) return { state: 'cold', tokens, usd }
  if (s.nudge === 'stopped') return { state: 'stopped', why: s.stopped || '保温停了' }
  if (s.nudge === 'warm') return { state: 'remind', min, tokens, usd }
  return { state: 'idle', min }
}

/** Line 2's task segment text: `n/m <step>`. */
export function taskText(steps: ReadonlyArray<{ text: string; status: string }>): { done: number; n: number; live: string } {
  return { done: steps.filter(s => s.status === 'completed').length, n: steps.length, live: steps.find(s => s.status === 'in_progress')?.text ?? '' }
}

// D-7: the big percentage in the terminal, three rows of block glyphs per character (check-board.mjs reads the same table).
export const BIG: Record<string, readonly [string, string, string]> = {
  0: ['█▀█', '█ █', '█▄█'], 1: ['▀█ ', ' █ ', '▄█▄'], 2: ['▀▀█', '▄▀▀', '█▄▄'], 3: ['▀▀█', ' ▀█', '▄▄█'], 4: ['█ █', '▀▀█', '  █'],
  5: ['█▀▀', '▀▀█', '▄▄█'], 6: ['█▀▀', '█▀█', '█▄█'], 7: ['▀▀█', '  █', '  █'], 8: ['█▀█', '█▀█', '█▄█'], 9: ['█▀█', '▀▀█', '▄▄█'],
  '%': ['▀ █', '▄▀ ', '█ ▄'],
}

/** `68%` → three rows of block glyphs, one space between characters; a character with no glyph is left out. */
export function bigText(s: string): [string, string, string] {
  const gs = [...s].map(ch => BIG[ch]).filter((g): g is readonly [string, string, string] => !!g)
  return [0, 1, 2].map(i => gs.map(g => g[i]).join(' ')) as [string, string, string]
}

const wide = (ch: string) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(ch)
/** Terminal cells of a string: CJK and full-width glyphs take two. */
export const cells = (s: string): number => [...s].reduce((n, ch) => n + (wide(ch) ? 2 : 1), 0)

/** Cut to at most `n` cells, ending in `…` when cut; never padded. */
export function cut(s: string, n: number): string {
  if (cells(s) <= n) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const w = wide(ch) ? 2 : 1
    if (used + w > n - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}
