// Pure readers: one markdown file + one section spec → a summary line and detail lines.
import type { BoardSection } from '../types'

export type Rendered = { summary: string; detail: string[] }

// Markdown → plain: bold, code, struck-out markers and [text](link) dropped.
export const plain = (s: string): string =>
  s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|`|~~/g, '').trim()

export const short = (s: string, n = 60): string => {
  const p = plain(s).replace(/ · /g, '/')
  return p.length > n ? `${p.slice(0, n)}…` : p
}

// The lines under every heading matching `heading`, each up to the next heading of the same or a higher level.
export function under(md: string, heading: string): string[] {
  const re = new RegExp(heading)
  const out: string[] = []
  let level = 0
  for (const line of md.split('\n')) {
    const h = line.match(/^(#+) /)
    if (h) {
      const l = h[1]!.length
      if (re.test(line)) level = l
      else if (level && l <= level) level = 0
      continue
    }
    if (level) out.push(line)
  }
  return out
}

// Unindented list items (`1. x`, `- x`), text only.
export const topItems = (lines: readonly string[]): string[] =>
  lines.flatMap(l => {
    const m = l.match(/^(?:\d+\.|[-*]) (.*)$/)
    return m ? [m[1]!] : []
  })

// An item's name: its leading bold, else the text before the first colon / paren / dash.
export function itemTitle(text: string, n = 40): string {
  const t = text.replace(/^\[[ xX]\] /, '')
  const bold = t.match(/^\*\*(.+?)\*\*/)
  if (bold) return short(bold[1]!, n)
  return short(t.split(/[:：(（—]/)[0] ?? t, n)
}

// `prefix` and the items on one line, cut with a count of the rest.
export function joinCapped(items: readonly string[], prefix = '', width = 110): string {
  let line = prefix
  for (const [i, it] of items.entries()) {
    const next = line === prefix ? `${prefix}${it}` : `${line} · ${it}`
    if (next.length > width && line !== prefix) return `${line} … +${items.length - i}`
    line = next
  }
  return line
}

// Highest version first: 10.11 > 10.9 > 10.8.
export const byVersionDesc = (a: string, b: string): number => {
  const na = a.match(/\d+/g)?.map(Number) ?? []
  const nb = b.match(/\d+/g)?.map(Number) ?? []
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (nb[i] ?? -1) - (na[i] ?? -1)
    if (d) return d
  }
  return b.localeCompare(a)
}

// Open rows of a DECISIONS-PENDING table: a struck-out question or one marked 关闭 is closed.
export function openDecisionRows(md: string): string[] {
  return md
    .split('\n')
    .filter(l => /^\|\s*\d+\s*\|/.test(l))
    .map(l => l.split('|')[2]?.trim() ?? '')
    .filter(q => q !== '' && !q.startsWith('~~') && !/关闭/.test(q))
}

// A list section's items: the ones after its `after` marker, or, when the file no longer has that marker,
// every item under the heading (a _NEXT.md rewritten without its 下一步 line still lists what is on).
export function listItems(s: Extract<BoardSection, { kind: 'list' }>, md: string): string[] {
  let lines = under(md, s.heading)
  if (s.after) {
    const re = new RegExp(s.after)
    const i = lines.findIndex(l => re.test(l))
    if (i >= 0) {
      lines = lines.slice(i + 1)
      const end = lines.findIndex(l => /^(---|\*\*[^*]+\*\*\s*$)/.test(l))
      if (end >= 0) lines = lines.slice(0, end)
    }
  }
  return topItems(lines)
}

function renderList(s: Extract<BoardSection, { kind: 'list' }>, md: string): Rendered {
  const items = listItems(s, md)
  const m = s.stamp ? md.match(new RegExp(s.stamp, 'm')) : null
  const stamp = m ? ` · ${plain(m[1] ?? m[0])}` : ''
  if (s.countOnly) return { summary: `${s.label} ${items.length} 条${stamp}`, detail: [] }
  const shown = items.slice(0, s.max ?? 6)
  return {
    summary: `${s.label}${stamp}`,
    detail: [
      ...shown.map((t, i) => `${i + 1}. ${itemTitle(t, 70)}`),
      ...(items.length > shown.length ? [`… 另 ${items.length - shown.length} 条`] : []),
    ],
  }
}

// GOAL's in-progress marker (owner 10.11): `- [ ] 〔进行中 <run名…>〕…`; dropped when the item is ticked.
const RUNNING = /^〔进行中\s*([^〕]*)〕\s*/

export type Group = { name: string; done: number; running: Array<{ title: string; runs: string }>; planned: string[] }

// Top-level checkboxes grouped by the headings of one level; open ones split into running and planned.
export function checklistGroups(md: string, group: '##' | '###'): Group[] {
  const groups: Group[] = []
  let g: Group | null = null
  const level = group.length
  // A checkbox above any heading of the group's level files under the nearest higher heading (`## 清单`),
  // so a GOAL written without `###` sections still reads as named sections.
  let outer = '清单'
  const nameOf = (h: string) => short(h.split(/[(（]/)[0] ?? h, 24)
  for (const line of md.split('\n')) {
    const h = line.match(/^(#+) (.*)$/)
    if (h && h[1]!.length <= level) {
      if (h[1]!.length === level) groups.push((g = { name: nameOf(h[2]!), done: 0, running: [], planned: [] }))
      else {
        g = null
        if (h[1]!.length > 1) outer = nameOf(h[2]!)
      }
      continue
    }
    const c = line.match(/^- \[([ xX])\] (.*)$/)
    if (!c) continue
    if (!g) groups.push((g = { name: outer, done: 0, running: [], planned: [] }))
    if (c[1] !== ' ') {
      g.done++
      continue
    }
    const r = c[2]!.match(RUNNING)
    if (r) {
      g.running.push({ title: itemTitle(c[2]!.slice(r[0].length), 40), runs: r[1]!.trim() })
    } else g.planned.push(c[2]!)
  }
  return groups
}

function renderChecklist(s: Extract<BoardSection, { kind: 'checklist' }>, md: string): Rendered {
  const groups = checklistGroups(md, s.group)
  const done = groups.reduce((n, x) => n + x.done, 0)
  const running = groups.reduce((n, x) => n + x.running.length, 0)
  const planned = groups.reduce((n, x) => n + x.planned.length, 0)
  const total = done + running + planned
  if (!s.titles) {
    return {
      summary: `${s.label} ${done}/${total} · 未勾 ${running + planned}`,
      detail: groups.filter(x => x.running.length + x.planned.length).map(x => `${x.name} ${x.done}/${x.done + x.running.length + x.planned.length}`),
    }
  }
  return {
    summary: `${s.label} 规划完成 ${done}/${total} · 进行中 ${running} · 规划中 ${planned}`,
    detail: groups
      .filter(x => x.running.length + x.planned.length)
      .flatMap(x => [
        joinCapped(x.planned.map(t => itemTitle(t, 28)), `${x.name} ${x.done}/${x.done + x.running.length + x.planned.length}${x.planned.length ? ' 规划中:' : ''}`),
        ...x.running.map(t => `  ▶ ${short(t.title, 28)}${t.runs ? `(${t.runs})` : ''}`),
      ]),
  }
}

type Row = { name: string; status: string }

// Rows of every markdown table in `lines` with a column whose header matches `column` (状态 by default);
// a column other than 状态 prefixes the value with its header (触发:W1 出闸).
export function tableRows(lines: readonly string[], column = /状态/): Row[] {
  const out: Row[] = []
  let col = -1
  let prefix = ''
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('|')) {
      col = -1
      continue
    }
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (/^\|[\s:|-]+\|$/.test(line)) continue
    if (/^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      col = cells.findIndex(c => column.test(c))
      prefix = col >= 0 && !/状态/.test(cells[col]!) ? `${plain(cells[col]!)}:` : ''
      continue
    }
    if (col < 0 || cells[col] === undefined) continue
    const first = plain(cells[0] ?? '')
    const name = /^\S{1,6}$/.test(first) ? `${first} ${plain(cells[1] ?? '')}` : first
    out.push({ name, status: prefix + plain(cells[col]!) })
  }
  return out
}

function renderTable(s: Extract<BoardSection, { kind: 'table' }>, md: string): Rendered {
  const rows = tableRows(s.heading ? under(md, s.heading) : md.split('\n'))
  const show = new RegExp(s.show)
  const count = s.count ? new RegExp(s.count) : null
  const alert = s.alert ? new RegExp(s.alert) : null
  const shown = new Map<string, string[]>()
  const counted = new Map<string, number>()
  for (const r of rows) {
    const m = r.status.match(show)
    if (m) {
      const k = m[1] ?? m[0]
      shown.set(k, [...(shown.get(k) ?? []), `${alert?.test(r.status) ? '⚠ ' : ''}${itemTitle(r.name, 26)}`])
      continue
    }
    const c = count ? r.status.match(count) : null
    if (c) counted.set(c[1] ?? c[0], (counted.get(c[1] ?? c[0]) ?? 0) + 1)
  }
  const tally = [...[...shown].map(([k, v]) => [k, v.length] as const), ...counted]
  return {
    summary: `${s.label}:${tally.map(([k, n]) => `${k} ${n}`).join(' · ') || '无'}`,
    detail: [...shown].map(([k, v]) => joinCapped(v, `${k}:`)),
  }
}

function renderPending(s: Extract<BoardSection, { kind: 'pending' }>, md: string): Rendered {
  const rows = openDecisionRows(md)
  return { summary: `${s.label} ${rows.length}`, detail: rows.length ? [joinCapped(rows.map(r => itemTitle(r, 24)))] : [] }
}

export function render(s: BoardSection, md: string): Rendered {
  switch (s.kind) {
    case 'list':
      return renderList(s, md)
    case 'checklist':
      return renderChecklist(s, md)
    case 'table':
      return renderTable(s, md)
    case 'pending':
      return renderPending(s, md)
  }
}

const GLYPH = { done: '✓', running: '▶', planned: '○' } as const

// Every item of a section, one per line, under the file's headings: what `/board <section>` prints.
export function renderFull(s: BoardSection, md: string): string[] {
  if (s.kind === 'pending') return openDecisionRows(md).map((r, i) => `${i + 1}. ${short(r, 120)}`)
  if (s.kind === 'list') {
    let lines = under(md, s.heading)
    if (s.after) {
      const i = lines.findIndex(l => new RegExp(s.after!).test(l))
      lines = i < 0 ? [] : lines.slice(i + 1)
    }
    return topItems(lines).map((t, i) => `${i + 1}. ${short(t, 160)}`)
  }
  const out: string[] = []
  const lines = md.split('\n')
  if (s.kind === 'checklist') {
    const level = s.group.length
    for (const line of lines) {
      const h = line.match(/^(#+) (.*)$/)
      if (h && h[1]!.length <= level) {
        if (h[1]!.length === level) out.push('', `## ${short(h[2]!.split(/[(（]/)[0] ?? h[2]!, 40)}`)
        continue
      }
      const c = line.match(/^- \[([ xX])\] (.*)$/)
      if (!c) continue
      const r = c[2]!.match(RUNNING)
      const glyph = c[1] !== ' ' ? GLYPH.done : r ? GLYPH.running : GLYPH.planned
      const body = r ? c[2]!.slice(r[0].length) : c[2]!
      out.push(`  ${glyph} ${itemTitle(body, 60)}${r && r[1]!.trim() ? `(${r[1]!.trim()})` : ''}`)
    }
    return out.slice(out[0] === '' ? 1 : 0)
  }
  // table: every row of the whole file (the summary's heading filter does not apply), under its ## / ###;
  // Later-style tables with a 触发 column instead of 状态 count too.
  let heading: string[] = []
  let block: string[] = []
  const flush = (): void => {
    const rows = tableRows(block, /状态|触发/)
    block = []
    if (!rows.length) return
    out.push('', heading.filter(Boolean).join(' / '))
    for (const r of rows) out.push(`  ${itemTitle(r.name, 50)} — ${short(r.status, 40)}`)
  }
  for (const line of lines) {
    const h = line.match(/^(#+) (.*)$/)
    if (h) {
      flush()
      const l = h[1]!.length
      if (l === 2) heading = [plain(h[2]!)]
      else if (l === 3) heading = [heading[0] ?? '', plain(h[2]!)]
      continue
    }
    if (line.startsWith('|')) block.push(line)
    else flush()
  }
  flush()
  return out.slice(out[0] === '' ? 1 : 0)
}

// How long ago, coarse: 刚刚 / 12 分钟前 / 3 小时前 / 2 天前.
export function age(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 2) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 48 * 60) return `${Math.floor(min / 60)} 小时前`
  return `${Math.floor(min / 1440)} 天前`
}

export type Tally = { name: string; done: number; running: number; planned: number }

const DONE = /^(已上线|已并 main|Done)/
const RUNNING_STATUS = /^(进行中|已排|On Track|At Risk|Blocked)/
const SKIPPED = /^(不做|Void)/

// Roadmap rows counted per `##` layer (per `###` when the file has one layer): done / running / planned.
export function roadmapLayers(md: string): Tally[] {
  const by = (level: 2 | 3): Tally[] => {
    const out: Tally[] = []
    let cur: Tally | null = null
    let block: string[] = []
    const flush = (): void => {
      for (const r of tableRows(block, /状态|触发/)) {
        if (!cur || SKIPPED.test(r.status) || r.name.startsWith('~~')) continue
        if (DONE.test(r.status)) cur.done++
        else if (RUNNING_STATUS.test(r.status)) cur.running++
        else cur.planned++
      }
      block = []
    }
    for (const line of md.split('\n')) {
      const h = line.match(/^(#+) (.*)$/)
      if (h) {
        flush()
        if (h[1]!.length === level) {
          const name = plain(h[2]!).replace(/\s*·\s*/, ' ').split(/\s*[(（]/)[0]!.replace(/^\d+\.\s*/, '')
          out.push((cur = { name, done: 0, running: 0, planned: 0 }))
        } else if (h[1]!.length < level) cur = null
        continue
      }
      if (line.startsWith('|')) block.push(line)
      else flush()
    }
    flush()
    return out.filter(t => t.done + t.running + t.planned > 0)
  }
  const layers = by(2)
  return layers.length > 1 ? layers : by(3)
}

// Display width: CJK and full-width glyphs take two cells.
export const cellsOf = (s: string): number =>
  [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(ch) ? 2 : 1), 0)

// Cut or pad to exactly `n` cells.
export function fitCells(s: string, n: number): string {
  let out = ''
  let used = 0
  const chars = [...s]
  const total = cellsOf(s)
  for (const ch of chars) {
    const w = cellsOf(ch)
    if (used + w > n - (total > n ? 1 : 0)) break
    out += ch
    used += w
  }
  if (total > n) {
    out += '…'
    used += 1
  }
  return out + ' '.repeat(Math.max(0, n - used))
}

// A bar of `width` cells split done / running / planned, each at least one cell when non-zero.
export function barCells(t: Omit<Tally, 'name'>, width: number): { done: number; running: number; planned: number } {
  const total = t.done + t.running + t.planned
  if (!total) return { done: 0, running: 0, planned: width }
  let done = Math.round((t.done / total) * width)
  let running = t.running ? Math.max(1, Math.round((t.running / total) * width)) : 0
  if (t.done && !done) done = 1
  if (done + running > width) done = width - running
  return { done, running, planned: width - done - running }
}
