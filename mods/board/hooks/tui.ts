// The terminal sidebar (E①) and the two lines above the prompt (D), cell by cell as docs/design/term/tui.py draws them.
// Pure: a View in, rows of coloured segments out; register.tsx turns segments into Text. Colours are board-unified.pen's.
import { cells, cut } from './hud'
import type { CacheView } from './hud'
import { PEN_SPRITES } from './pen-sprites'
import { termSprite } from './sprites'
import type { CostumeKey } from './sprites'

export const T = {
  panel: '#14121c', border: '#2c2840', card: '#231d38', helper: '#1d1a29', track: '#2a2640',
  txt: '#ece9fb', sub: '#8f89a8', dim: '#5b5575', acc: '#c4b5fd', p1: '#c4b5fd', p2: '#8b5cf6', p3: '#6d28d9',
  done: '#22c55e', wip: '#eab308', red: '#ef4444', cyan: '#22d3ee', blue: '#3b82f6', sep: '#3f3f46',
  go: '#12301c', cold: '#6b7280',
} as const

/** A run of cells in one colour; `bg` left out = the row's own background; `press` = a button, the action it runs. */
export type Seg = { t: string; fg: string; bg?: string; b?: boolean; press?: CacheAction }
export type Row = Seg[]

export type Bar3 = { done: number; running: number; planned: number }
/** One body row of a block (README of docs/design/term/fixture has the JSON form). */
export type BodyRow =
  | { bullet: string }
  | { bar: string; done: number; running: number; planned: number }
  | { warn: string }
  | { run: string }
  | { alert: string }
  | { left: string; right: string }
  | { text: string }
  | { dash: true }
export type Block = { key: string; title: string; source: string; rows: BodyRow[] }
/** `meta` = `<档> · <tokens> · <用时>`(档名着档色);`fill` 档色条比例(子 agent = ctx,MiniMax = 轮),`tail` 条后的字。 */
export type Helper = { id?: string; costume: string; name: string; meta: string; fill?: number; tail?: string; rows?: string[]; colors?: Record<string, string> }
export type View = {
  card: { repo: string; pct: string; live: string; now: string; bar: Bar3 }
  who: { title: string; source: string; helpers: Helper[]; more?: number }
  plan: { title: string; source: string; fill: number; line: string } | { title: string; source: string; none: true }
  blocks: Block[]
  hint?: boolean
}

/** D-5: these six fold to one `▸ <title>` row; 走到哪, 谁在跑, 任务条, 待拍板 stay open. */
export const FOLDS = /^(下一步|GOAL|TODO|ROADMAP|最近提交|今日用量)/

class Line {
  segs: Row = []
  n = 0
  constructor(readonly bg: string) {}
  t(t: string, fg: string, b = false, bg?: string): this {
    if (t) this.segs.push({ t, fg, bg: bg ?? this.bg, ...(b ? { b: true } : {}) })
    this.n += cells(t)
    return this
  }
  to(col: number): this {
    return this.t(' '.repeat(Math.max(0, col - this.n)), this.bg)
  }
  right(t: string, fg: string, width: number, b = false): this {
    return this.to(width - cells(t)).t(t, fg, b)
  }
  done(width: number): Row {
    this.to(width)
    return this.segs
  }
}

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
export function lerp(a: string, b: string, k: number): string {
  const x = hex(a)
  const y = hex(b)
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * k).toString(16).padStart(2, '0')).join('')}`
}

/** Cells of a three-part bar at `width`: a non-zero part keeps a cell. */
export function split(t: Bar3, width: number): Bar3 {
  const total = t.done + t.running + t.planned
  if (!total) return { done: 0, running: 0, planned: width }
  let done = Math.round((t.done / total) * width)
  const running = t.running ? Math.max(1, Math.round((t.running / total) * width)) : 0
  if (t.done && !done) done = 1
  if (done + running > width) done = width - running
  return { done, running, planned: width - done - running }
}
function bar3(L: Line, t: Bar3, width: number, ch = '▬'): void {
  const c = split(t, width)
  L.t(ch.repeat(c.done), T.done).t(ch.repeat(c.running), T.wip).t(ch.repeat(c.planned), T.track)
}

export const SW = 7
export const SH = 8
/** The 谁在跑 sprite as SH / 2 rows of (top, bottom) pixel pairs; .pen costumes from PEN_SPRITES, others from a fallback table. */
export function spriteCells(h: Helper): Array<Array<[string | null, string | null]>> {
  const px = PEN_SPRITES[h.costume]
  const at = (x: number, y: number): string | null => {
    if (px) return px[y]?.[x] ?? null
    // 不在 .pen 里的造型:旧终端精灵是 8 列身子 + 2 列道具，放不进 SW 列——去掉道具，身子从右边裁到 SW 列(居中放不下时不两边各砍)
    const rows = (h.rows ?? []).map(r => r.slice(0, Math.min(8, SW)))
    const ox = Math.max(0, Math.floor((SW - (rows[0]?.length ?? 0)) / 2))
    const oy = Math.floor((SH - rows.length) / 2)
    const ch = rows[y - oy]?.[x - ox]
    return (ch && h.colors?.[ch]) || null
  }
  return Array.from({ length: SH / 2 }, (_, r) => Array.from({ length: SW }, (_, x) => [at(x, 2 * r), at(x, 2 * r + 1)] as [string | null, string | null]))
}
function putCells(L: Line, cs: Array<[string | null, string | null]>): void {
  for (const [top, bot] of cs) {
    if (top && bot) L.t('▀', top, false, bot)
    else if (top) L.t('▀', top)
    else if (bot) L.t('▄', bot)
    else L.t(' ', T.txt)
  }
}

export const TIER_BAR = 17
export type Drawn = { key: string; row: Row }

/** The sidebar inside its frame: rows `W + 4` wide (frame, pad, W content, pad, frame). */
export function sidebar(v: View, W: number, fold: boolean, cap = 3): Drawn[] {
  const side: Drawn[] = []
  const push = (key: string, row: Row) => side.push({ key, row })
  const row = (bg: string = T.panel) => new Line(bg)
  const blank = (key: string) => push(key, row().done(W))
  // 头卡占满内容宽(稿里卡只受侧栏 8px 内边距，即框内那 1 格)
  const card = (key: string, fill: (C: Line) => void) => {
    const C = new Line(T.card)
    fill(C)
    push(key, C.done(W))
  }
  const c = v.card
  // 40 列稿(owner 10.23):卡内边距 1 格;「现在在 … · 下一步:…」拆两行，不截。卡的上下内边距稿里只有 7px(不到半行),
  // 不占整行：真实 myapp(3 个 helper、22 条待拍板)侧栏比宿主给的高，留着它们底边就被截掉。
  const [nowAt, nextUp] = c.now.includes(' · 下一步') ? [c.now.slice(0, c.now.indexOf(' · 下一步')), c.now.slice(c.now.indexOf(' · 下一步') + 3)] : [c.now, '']
  card('card-1', C => C.t(` ${cut(c.repo, W - 7)}`, T.txt, true).right(c.pct, T.acc, W - 1, true))
  card('card-3', C => C.t(' ●', T.sub).t(` ${cut(c.live, W - 4)}`, T.sub))
  card('card-4', C => C.t(` ${cut(nowAt, W - 2)}`, T.txt, true))
  if (nextUp) card('card-4b', C => C.t(` ${cut(nextUp, W - 2)}`, T.txt, true))
  card('card-5', C => {
    C.t(' ', T.txt)
    bar3(C, c.bar, W - 2)
  })
  blank('card-gap')

  const head = (key: string, title: string, source: string, folded: boolean) => {
    const left = folded ? `▸ ${title}` : title
    // 40 列稿：来源放得下才画，放不下整段不画，不截。
    const room = W - cells(left) - 1
    const src = cells(source) <= room ? source : ''
    push(key, row().t(left, T.sub, true).right(src, T.dim, W).done(W))
  }

  head('who-h', v.who.title, v.who.source, false)
  if (!v.who.helpers.length) {
    push('who-none', row().t('—', T.dim).done(W))
    blank('who-gap')
  }
  v.who.helpers.forEach((h, k) => {
    const id = h.id ?? `h${k}`
    const sprite = spriteCells(h)
    sprite.forEach((cs, i) => {
      const L = row(T.helper).t(' ', T.txt)
      putCells(L, cs)
      const room = W - SW - 3
      const tier = DOT[h.costume] ?? DOT.other!
      if (i === 0) L.to(SW + 2).t(cut(h.name, room), T.txt, true)
      if (i === 1) L.to(SW + 2).t(cut(h.meta, room), tier)
      if (i === 2 && (h.fill !== undefined || h.tail)) {
        // 条定宽 TIER_BAR 格(稿 118px ÷ 6.94),尾字跟在条后：各卡的条右缘对齐
        const bw = Math.min(TIER_BAR, room)
        const tail = h.tail ? cut(h.tail, Math.max(0, room - bw - 1)) : ''
        const on = Math.max(0, Math.min(bw, Math.round((h.fill ?? 0) * bw)))
        L.to(SW + 2).t('▬'.repeat(on), tier).t('▬'.repeat(bw - on), T.track)
        if (tail) L.t(' ', T.txt).t(tail, T.sub)
      }
      push(`sprite-${id}`, L.done(W))
    })
    blank(`helper-${id}`)
  })
  if (v.who.more) {
    push('who-more', row().t(`+${v.who.more}`, T.sub).done(W))
    blank('who-more-gap')
  }

  head('band-h', v.plan.title, v.plan.source, false)
  if ('none' in v.plan) push('band-none', row().t('—', T.dim).done(W))
  else {
    const L = row()
    const on = Math.max(0, Math.min(W, Math.round(v.plan.fill * W)))
    for (let i = 0; i < W; i++) L.t('█', i < on ? lerp(T.p3, T.p1, on > 1 ? i / (on - 1) : 0) : T.track)
    push('task-band', L.done(W))
    push('band-step', row().t(cut(v.plan.line, W), T.sub).done(W))
  }

  let lastFolded = false
  for (const b of v.blocks) {
    const folded = fold && FOLDS.test(b.key)
    if (!(folded && lastFolded)) blank(`gap-${b.key}`)
    lastFolded = folded
    head(`${b.key}-h`, b.title, b.source, folded)
    if (folded) continue
    b.rows.slice(0, 'bar' in (b.rows[0] ?? {}) ? undefined : cap).forEach((r, i) => push(`${b.key}-${i}`, body(r, W)))
  }
  if (v.hint) {
    blank('gap-hint')
    hint(W).forEach((r, i) => push(`hint-${i}`, r))
  }

  const bd = (t: string): Seg => ({ t, fg: T.border, bg: T.panel })
  const pad: Seg = { t: ' ', fg: T.txt, bg: T.panel }
  return [
    { key: 'frame-top', row: [bd(`╭${'─'.repeat(W + 2)}╮`)] },
    ...side.map(s => ({ key: s.key, row: [bd('│'), pad, ...s.row, pad, bd('│')] })),
    { key: 'frame-bottom', row: [bd(`╰${'─'.repeat(W + 2)}╯`)] },
  ]
}

function body(r: BodyRow, W: number): Row {
  const L = new Line(T.panel)
  if ('bullet' in r) return L.t('· ', T.sub).t(cut(r.bullet, W - 2), T.txt).done(W)
  if ('bar' in r) {
    L.t(cut(r.bar, 13), T.sub).to(14)
    bar3(L, r, W - 14)
    return L.done(W)
  }
  if ('warn' in r) return L.t('⚠  ', T.wip).t(cut(r.warn, W - 3), T.txt).done(W)
  if ('run' in r) return L.t('▶  ', T.wip).t(cut(r.run, W - 3), T.txt).done(W)
  if ('alert' in r) return L.t('⚠  ', T.red).t(cut(r.alert, W - 3), T.txt).done(W)
  if ('left' in r) {
    const right = cut(r.right, Math.max(0, W - 6))
    return L.t(cut(r.left, Math.max(4, W - cells(right) - 1)), T.txt).right(right, T.sub, W).done(W)
  }
  if ('text' in r) return L.t(cut(r.text, W), T.sub).done(W)
  return L.t('—', T.dim).done(W)
}

// H: the repo has no progress files; a dashed card says which file lights which block.
function hint(W: number): Row[] {
  const box = (parts: Array<[string, string, boolean?]>) => {
    const L = new Line(T.panel).t('┆', T.dim)
    for (const [t, fg, b] of parts) L.t(cut(t, Math.max(0, W - 2 - L.n)), fg, b)
    return L.to(W - 1).t('┆', T.dim).done(W)
  }
  return [
    new Line(T.panel).t(`╭${'┄'.repeat(W - 2)}╮`, T.dim).done(W),
    box([[' 进度块没亮', T.txt, true], [':仓里还没有进度文件。', T.sub]]),
    box([[' 建一个就会出现对应块:', T.sub]]),
    box([[' · ', T.sub], ['<版本>/GOAL.md', T.txt, true], [' → 百分比+各节', T.sub]]),
    box([[' · ', T.sub], ['docs/ROADMAP.md', T.txt, true], [' → ROADMAP', T.sub]]),
    box([[' · ', T.sub], ['docs/plan/TODO.md', T.txt, true], [' → TODO', T.sub]]),
    box([[' · ', T.sub], ['_NEXT.md', T.txt, true], [' → 下一步', T.sub]]),
    box([[' · ', T.sub], ['DECISIONS-PENDING.md', T.txt, true], [' → 待拍板', T.sub]]),
    new Line(T.panel).t(`╰${'┄'.repeat(W - 2)}╯`, T.dim).done(W),
  ]
}

/** How many body rows each list block may keep so the frame fits `bodyRows` (3 → 2 → 1). */
export function fitCap(v: View, W: number, fold: boolean, bodyRows: number): number {
  let cap = 3
  while (cap > 1 && sidebar(v, W, fold, cap).length > bodyRows) cap--
  return cap
}

// ---------- D: the two lines above the prompt ----------

export type Hud = {
  model: string | null
  effort: string | null
  repo: string
  branch: string
  dirty: boolean
  ahead: number
  ctx: number | null
  fiveH: { pct: number; reset: string } | null
  week: number | null
  remote: boolean | null
  task: { done: number; n: number; text: string } | null
  dots: string[]
  cacheMin: number | null
  /** The ◷ segment as G draws it (缓存 v2 D-6); absent or null = the old `◷ Nm` from cacheMin. */
  cache?: Cache | null
}

/** One state of the ◷ segment, base/G-<state>.html; `flushing` (写交接中…) is base/G-handing.html. */
export type Cache = CacheView
/** What a ◷ button does; register.tsx runs cache-clock's command for it. */
export type CacheAction = 'warm' | 'skip' | 'stop' | 'rewarm' | 'handoff' | 'ho-cancel' | 'ho-now'

/** The hat colour each costume's dot takes (waivers.json: one ● per working helper). */
export const DOT: Record<string, string> = {
  heavy: '#D4537E', medium: '#378ADD', minimax: '#F23F5D', fable: '#7F77DD', careful: '#BA7517', light: '#1D9E75', explore: '#FF6B4A', other: '#D97757',
}

const TERM = '#0c0c0c'
function dBar(L: Line, pct: number, n: number, color: string): void {
  const on = Math.max(0, Math.min(n, Math.round((pct / 100) * n)))
  L.t('▆'.repeat(on), color).t('▆'.repeat(n - on), T.track)
}
const tone = (p: number) => (p >= 80 ? T.red : p >= 60 ? T.wip : T.done)
const sep = (L: Line) => L.t(' │ ', T.sep)
// D 稿第 2 行前缀定宽(稿注：条 8 格、步骤名最多 13 格、最多 3 个六分块小人各 5 格、数到 100 写 99+),整行最长 74 + ◷ 段 24 = 98 格。
export const TASK_TEXT = 13
export const MAX_DOTS = 3
const upTo99 = (n: number) => (n > 99 ? '99+' : String(n))

/** Line 1 then line 2, as tui.py's l1 / l2; `room` cuts the branch, then the repo, never the gauges. */
export function hudLines(h: Hud, room = 200): [Row, Row] {
  const draw = (repo: string, branch: string): Line => {
    const L = new Line(TERM)
    const who = [h.model, h.effort].filter(Boolean).join('·')
    if (who) {
      L.t(` ${who}`, T.cyan, true)
      sep(L)
    } else L.t(' ', T.txt)
    if (h.repo) {
      L.t(`${repo}${branch ? ` ⎇ ${branch}${h.dirty ? '*' : ''}` : ''}${h.ahead > 0 ? ' ' : ''}`, T.txt)
      if (h.ahead > 0) L.t(`↑${h.ahead}`, h.ahead >= 5 ? T.wip : T.sub, true)
      sep(L)
    }
    if (h.ctx === null) L.t('ctx —', T.sub)  // 没有数:用 D 稿里有的标签灰，不用侧栏的暗灰
    else {
      L.t('ctx ', T.sub)
      dBar(L, h.ctx, 6, tone(h.ctx))
      L.t(` ${Math.round(h.ctx)}%`, tone(h.ctx))
    }
    sep(L)
    if (!h.fiveH) L.t('5h —', T.sub)
    else {
      L.t('5h ', T.sub)
      dBar(L, h.fiveH.pct, 6, T.blue)
      L.t(` ${Math.round(h.fiveH.pct)}%${h.fiveH.reset ? ` ${h.fiveH.reset}` : ''}`, T.blue)
    }
    sep(L)
    L.t(h.week === null ? '周 —' : `周 ${Math.round(h.week)}%`, h.week === null ? T.sub : T.blue)
    if (h.remote !== null) L.t('  ☎', h.remote ? T.done : T.sep)
    return L
  }
  let l1 = draw(h.repo, h.branch)
  if (l1.n > room && h.repo) {
    let over = l1.n - room
    const bw = Math.max(4, cells(h.branch) - over)
    over -= cells(h.branch) - bw
    const rw = Math.max(8, cells(h.repo) - Math.max(0, over))
    l1 = draw(cut(h.repo, rw), cut(h.branch, bw))
  }
  const l2 = new Line(TERM)
  let first = true
  const part = () => {
    if (!first) sep(l2)
    first = false
  }
  if (h.task && h.task.n) {
    part()
    l2.t(' ▶ 任务 ', T.p2, true)
    dBar(l2, (h.task.done / h.task.n) * 100, 8, T.p2)
    l2.t(` ${upTo99(h.task.done)}/${upTo99(h.task.n)}${h.task.text ? ` ${cut(h.task.text, TASK_TEXT)}` : ''}`, T.acc)
  }
  if (h.dots.length) {
    part()
    if (l2.n === 0) l2.t(' ', T.txt)
    h.dots.slice(0, MAX_DOTS).forEach((d, i) => {
      if (i) l2.t(' ', T.txt)
      for (const s of sextSprite(d)) l2.segs.push({ ...s, bg: s.bg ?? TERM }), (l2.n += 1)
    })
    l2.t(` ${upTo99(h.dots.length)} 在跑`, T.txt)
  }
  part()
  if (l2.n === 0) l2.t(' ', T.txt)
  if (h.cache) {
    cacheSeg(l2, h.cache)
    return [l1.segs, l2.segs]
  }
  const m = h.cacheMin
  l2.t(m === null ? '◷ —' : m > 0 ? `◷ ${m}m` : '◷ 冷', m === null ? T.sep : m > 0 && m < 5 ? T.wip : m > 0 ? T.done : T.sep)  // 冷或没有数:变灰，用第 2 行稿里有的分隔灰
  return [l1.segs, l2.segs]
}

const money = (n: number | null, approx = true) => (n === null ? '' : `${approx ? '≈' : ''}$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`)
const kTokens = (n: number) => `${Math.round(n / 1000)}k`
const hm = (ms: number) => {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}
export const WARM_BAR = 4
function button(L: Line, label: string, fg: string, bg: string, press: CacheAction): void {
  L.segs.push({ t: label, fg, bg, b: true, press })
  L.n += cells(label)
}

/**
 * The ◷ segment of line 2, cell for cell as base/G-<state>.html. The .pen draws the CJK narrower than two cells, so
 * where its next node starts before the terminal text ends the button follows with no space (remind, stopped); that
 * keeps every node's start column within one of x ÷ 7.8.
 */
function cacheSeg(L: Line, c: Cache): void {
  switch (c.state) {
    case 'working':
      L.t('●', T.done, true)
      return
    case 'idle':
      L.t(`◷ ${c.min}m`, c.min < 5 ? T.wip : T.done, true)
      return
    case 'remind':
      L.t(`◷ ${c.min}m`, T.wip, true).t(' ', T.txt).t(`${money(c.usd) || kTokens(c.tokens)} `, T.wip)
      button(L, ' 保温 ', T.done, T.go, 'warm')
      return
    case 'warming': {
      L.t('◷ 保温', T.p2, true).t(' ', T.txt)
      dBar(L, c.windowMs > 0 ? (Math.max(0, c.leftMs) / c.windowMs) * 100 : 0, WARM_BAR, T.p2)
      L.t(` ${hm(c.leftMs)} `, T.acc)
      button(L, ' 停 ', T.sub, T.track, 'stop')
      return
    }
    case 'stopped':
      L.t(`◷ ${c.why} `, T.red)
      button(L, ' ↻ ', T.wip, T.track, 'rewarm')
      L.t(' ', T.txt)
      button(L, ' 交接 ', T.done, T.go, 'handoff')
      return
    case 'cold': {
      const usd = money(c.usd)
      L.t(`❄ ${kTokens(c.tokens)}${usd ? ` ${usd}` : ''} `, T.cold)
      button(L, ' 交接 ', T.done, T.go, 'handoff')
      return
    }
    case 'flushing':
      L.t('◷ 写交接中…', T.done, true)  // 契约 D-5,base/G-handing.html
      return
    // F 稿 ④(40 列定稿):relay 交接时整段换掉 ◷
    case 'ho-write':
      L.t('✎ 写交接… ', T.p2, true)
      button(L, ' 取消 ', T.sub, T.track, 'ho-cancel')
      return
    case 'ho-wait':
      L.t(`⏸ 等子 agent ${c.min}m `, T.sub)
      button(L, ' 取消 ', T.sub, T.track, 'ho-cancel')
      return
    case 'ho-count':
      L.t(`⟲ ${c.sec}s `, c.sec <= 5 ? T.red : T.wip, true)
      button(L, ' 现在交接 ', T.done, T.go, 'ho-now')
      L.t(' ', T.txt)
      button(L, ' 取消 ', T.sub, T.track, 'ho-cancel')
      return
    case 'ho-flush':
      L.t('✎ 补存 checkpoint…', T.p2, true)
  }
}

// D 稿第 2 行的小人：termSprite 缩到 10×3 像素，每格 2×3 用六分块字符画，一格只有前景、背景两色
// (格里透明的像素落在背景色上;只有一色时背景露终端底)。docs/design/term/review/row2-sprite/sext_px.py 用同一算法给 .pen 出像素。
const SEXT: string[] = (() => {
  const t: string[] = []
  let k = 0
  for (let m = 0; m < 64; m++) {
    if (m === 0) t.push(' ')
    else if (m === 63) t.push('█')
    else if (m === 21) t.push('▌')
    else if (m === 42) t.push('▐')
    else t.push(String.fromCodePoint(0x1fb00 + k++))
  }
  return t
})()
const rgb = (h: string) => hex(h)
export function sextSprite(costume: string): Seg[] {
  const { rows, colors } = termSprite(costume as CostumeKey, 0)
  const sh = rows.length
  const sw = rows[0]?.length ?? 0
  const grid: Array<Array<string | null>> = []
  for (let y = 0; y < 3; y++) {
    const r: Array<string | null> = []
    for (let x = 0; x < 10; x++) {
      const y0 = Math.floor((y * sh) / 3), y1 = Math.max(Math.floor(((y + 1) * sh) / 3), y0 + 1)
      const x0 = Math.floor((x * sw) / 10), x1 = Math.max(Math.floor(((x + 1) * sw) / 10), x0 + 1)
      const px: string[] = []
      for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) px.push(rows[j]?.[i] ?? '.')
      const solid = px.filter(p => p !== '.')
      if (solid.length * 2 < px.length) r.push(null)
      else {
        const n = new Map<string, number>()
        for (const p of solid) n.set(p, (n.get(p) ?? 0) + 1)
        const top = [...n.entries()].sort((a, b) => b[1] - a[1])[0]![0]
        r.push((colors[top] ?? '#D97757').toUpperCase())
      }
    }
    grid.push(r)
  }
  const out: Seg[] = []
  const d2 = (p: string, q: string) => rgb(p).reduce((s, v, i) => s + (v - rgb(q)[i]!) ** 2, 0)
  for (let x = 0; x < 10; x += 2) {
    const bits = [0, 1, 2].flatMap(y => [grid[y]![x]!, grid[y]![x + 1]!])
    const n = new Map<string, number>()
    for (const p of bits) if (p) n.set(p, (n.get(p) ?? 0) + 1)
    const ranked = [...n.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])
    const a = ranked[0]
    if (!a) {
      out.push({ t: ' ', fg: T.txt })
      continue
    }
    const b = ranked[1]
    let m = 0
    bits.forEach((p, i) => {
      if (p && (!b || d2(p, a) <= d2(p, b))) m |= 1 << i
    })
    out.push(b ? { t: SEXT[m]!, fg: a, bg: b } : { t: SEXT[m]!, fg: a })
  }
  return out
}

/** Plain text of a row, for tests and logs. */
export const textOf = (r: Row): string => r.map(s => s.t).join('')
