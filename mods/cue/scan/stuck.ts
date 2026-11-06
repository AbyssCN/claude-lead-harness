// Pure: is a pane showing a cue dialog, how long has each dialog been open in working hours, what one tick writes.
// No engine and no Node here: the scanner (bin/cue-stuck-scan.ts) does the herdr calls and the files.

/** Both marks of cue's AskUserQuestion dialog (popupQuestion in hooks/seat.ts): the chip, and the closing question. */
export const MARK_CHIP = '☐ cue'
export const MARK_ASK = '发送吗?'
/** Open longer than this inside working hours counts once as stuck. */
export const STUCK_SEC = 600
/** The timer's period. */
export const TICK_MS = 5 * 60_000
/** Helsinki working hours, [from, to). */
export const WORK_FROM_H = 8
export const WORK_TO_H = 22
const TZ = 'Europe/Helsinki'

/** The dialog's title (the text after `cue · ` on the first body line), or null when the pane shows no cue dialog. */
export function cueDialog(screen: string): { title: string } | null {
  const chip = screen.indexOf(MARK_CHIP)
  if (chip < 0 || screen.indexOf(MARK_ASK, chip) < 0) return null
  for (const raw of screen.slice(chip + MARK_CHIP.length).split('\n')) {
    const line = raw.replace(/^[\s│┃|]+/, '').replace(/[\s│┃|]+$/, '')
    const m = /^cue · (.+)$/.exec(line)
    if (m) return { title: m[1]!.trim() }
  }
  return { title: '(没读到标题)' }
}

/** Helsinki wall-clock parts of an instant. */
export function helsinki(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms))
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  return { y: n('year'), mo: n('month'), d: n('day'), h: n('hour'), mi: n('minute'), s: n('second') }
}

/** The instant a Helsinki wall-clock time names (DST-correct; a skipped hour resolves forward). */
export function fromHelsinki(y: number, mo: number, d: number, h: number): number {
  let t = Date.UTC(y, mo - 1, d, h)
  for (let i = 0; i < 3; i++) {
    const p = helsinki(t)
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s)
    const want = Date.UTC(y, mo - 1, d, h)
    if (shown === want) break
    t += want - shown
  }
  return t
}

/** `2026-11-02 15:41` in Helsinki. */
export function helsinkiStamp(ms: number): string {
  const p = helsinki(ms)
  const z = (v: number) => String(v).padStart(2, '0')
  return `${p.y}-${z(p.mo)}-${z(p.d)} ${z(p.h)}:${z(p.mi)}`
}

/** Helsinki date `2026-11-02`. */
export function helsinkiDay(ms: number): string {
  return helsinkiStamp(ms).slice(0, 10)
}

/** Seconds of [from, to) that fall inside Helsinki working hours. */
export function workSeconds(from: number, to: number): number {
  if (to <= from) return 0
  let total = 0
  const first = helsinki(from)
  // Walk Helsinki days from the one `from` falls on; noon UTC of each day steps safely across DST.
  let noon = Date.UTC(first.y, first.mo - 1, first.d, 12)
  for (let guard = 0; guard < 400; guard++) {
    const p = helsinki(noon)
    const start = fromHelsinki(p.y, p.mo, p.d, WORK_FROM_H)
    const end = fromHelsinki(p.y, p.mo, p.d, WORK_TO_H)
    if (start >= to) break
    total += Math.max(0, Math.min(end, to) - Math.max(start, from))
    noon += 86_400_000
  }
  return Math.round(total / 1000)
}

export type Agent = { pane_id: string; agent_status?: string; name?: string; cwd?: string; agent_session?: { value?: string } }
export type Box = { pane: string; name: string | null; repo: string; session: string | null; title: string; firstSeen: number; counted: boolean }
export type State = { boxes: Record<string, Box>; outbox: Alert[]; lastTick?: number }
export type Alert = { dedupKey: string; text: string; kind: 'p0' }
export type Seen = { pane: string; screen: string | null }

export const emptyState = (): State => ({ boxes: {}, outbox: [] })

/** A short stable tag (djb2, base 36) for a set of boxes. */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const keyOf = (pane: string, title: string) => `${pane}\u0000${title}`
const repoOf = (cwd?: string) => (cwd ?? '').split('/').filter(Boolean).pop() ?? ''

export type OpenRow = { pane: string; name: string | null; repo: string; title: string; firstSeen: string; openSec: number; workSec: number; stuck: boolean }
export type Reading = {
  ts: string
  at: string
  scanned: number
  blocked: number
  open: number
  boxes: OpenRow[]
  closed: { pane: string; title: string; openSec: number; workSec: number; stuck: boolean }[]
  newStuck: number
  unreadable: string[]
}

/**
 * One tick. `agents` is herdr's list; `seen` holds the screen of every blocked pane (null = `agent read` failed).
 * First-seen is kept per pane + title: the same pane showing a new card starts a new clock.
 */
export function tick(prev: State, agents: Agent[], seen: Seen[], now: number): { state: State; reading: Reading; alerts: Alert[] } {
  const byPane = new Map(agents.map((a) => [a.pane_id, a]))
  const boxes: Record<string, Box> = {}
  const unreadable: string[] = []
  // A box first seen now opened somewhere since the last tick: the midpoint, when that tick was a regular one.
  const born = prev.lastTick !== undefined && now - prev.lastTick <= 3 * TICK_MS ? Math.round((prev.lastTick + now) / 2) : now
  for (const s of seen) {
    if (s.screen === null) {
      unreadable.push(s.pane)
      // Not read this tick: keep what was open there, neither closed nor counted.
      for (const [k, b] of Object.entries(prev.boxes)) if (b.pane === s.pane) boxes[k] = { ...b }
      continue
    }
    const d = cueDialog(s.screen)
    if (!d) continue
    const k = keyOf(s.pane, d.title)
    const a = byPane.get(s.pane)
    boxes[k] = prev.boxes[k] ? { ...prev.boxes[k]! } : {
      pane: s.pane, name: a?.name ?? null, repo: repoOf(a?.cwd), session: a?.agent_session?.value ?? null, title: d.title, firstSeen: born, counted: false,
    }
  }
  const rows: OpenRow[] = []
  const fresh: string[] = []
  const unread = new Set(unreadable)
  for (const b of Object.values(boxes)) {
    const workSec = workSeconds(b.firstSeen, now)
    // A pane not read this tick may have closed its box: count it once it is seen again.
    if (!b.counted && workSec > STUCK_SEC && !unread.has(b.pane)) {
      b.counted = true
      fresh.push(`${b.name ? `${b.name}(${b.pane})` : b.pane} · ${b.repo}「${b.title}」${helsinkiStamp(b.firstSeen).slice(11)} 起`)
    }
    rows.push({
      pane: b.pane, name: b.name, repo: b.repo, title: b.title, firstSeen: helsinkiStamp(b.firstSeen),
      openSec: Math.round((now - b.firstSeen) / 1000), workSec, stuck: b.counted,
    })
  }
  // One message per tick, however many boxes crossed the line in it.
  // The outbox rings once per key family a day and once per identity (the key less its timestamps) in 36 h (rcmux
  // p0-policy): both name the set of boxes, so a new set of stuck boxes rings, the same set again does not.
  const alerts: Alert[] = fresh.length
    ? [{ kind: 'p0', dedupKey: `cue-stuck-${hash(fresh.map((f) => f.split('」')[0]).sort().join('|'))}:${new Date(now).toISOString()}`, text: `cue 确认框卡住 ${fresh.length} 个(工作时间里开着超过 10 分钟):\n${fresh.join('\n')}` }]
    : []
  const closed = Object.entries(prev.boxes)
    .filter(([k]) => !(k in boxes))
    .map(([, b]) => ({ pane: b.pane, title: b.title, openSec: Math.round((now - b.firstSeen) / 1000), workSec: workSeconds(b.firstSeen, now), stuck: b.counted }))
  const reading: Reading = {
    ts: new Date(now).toISOString(),
    at: helsinkiStamp(now),
    scanned: agents.length,
    blocked: seen.length,
    open: rows.length,
    boxes: rows,
    closed,
    newStuck: fresh.length,
    unreadable,
  }
  return { state: { boxes, outbox: [...prev.outbox, ...alerts], lastTick: now }, reading, alerts }
}

/** The tick herdr could not list: no count, never a zero. */
export function unreadableReading(now: number, error: string): { ts: string; at: string; unreadable: 'list'; error: string } {
  return { ts: new Date(now).toISOString(), at: helsinkiStamp(now), unreadable: 'list', error }
}

/** A Helsinki day's working-hours stuck count, from the reading lines (`--summary`). */
export function summarize(lines: string[], day: string) {
  let ticks = 0, unreadable = 0, partly = 0, stuck = 0, maxOpen = 0
  const titles: string[] = []
  for (const l of lines) {
    const r = JSON.parse(l) as { ts: string; unreadable?: unknown; newStuck?: number; open?: number; boxes?: { pane: string; title: string; stuck: boolean; workSec: number }[] }
    if (helsinkiDay(Date.parse(r.ts)) !== day) continue
    ticks++
    if (r.unreadable === 'list') { unreadable++; continue }
    // Some blocked panes could not be read (the tick exited 1): the rest still count, and the tick says so.
    if (Array.isArray(r.unreadable) && r.unreadable.length) partly++
    stuck += r.newStuck ?? 0
    maxOpen = Math.max(maxOpen, r.open ?? 0)
    for (const b of r.boxes ?? []) if (b.stuck && !titles.includes(`${b.pane} · ${b.title}`)) titles.push(`${b.pane} · ${b.title}`)
  }
  return { day, ticks, unreadableTicks: unreadable, partlyUnreadableTicks: partly, stuck, maxOpenAtOnce: maxOpen, stuckBoxes: titles }
}
