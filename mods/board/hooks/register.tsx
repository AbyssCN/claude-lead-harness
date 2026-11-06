import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BoardSection, PaneBand, PaneHelper, PaneModel } from '../types'
import { frameOf, helperFromAgent, helperFromRun } from './helpers'
import { age, barCells, byVersionDesc, checklistGroups, itemTitle, listItems, openDecisionRows, render, renderFull, short, tableRows, under } from './parse'
import { bar, bigText, cacheMinutes, cacheView, cells, handoffView, cut, modelShort, taskText, untilReset } from './hud'
import type { CacheIn, Limit, RelayIn } from './hud'
import { fitCap, hudLines, sidebar } from './tui'
import type { BodyRow, CacheAction, Hud, Row, View } from './tui'
import { DONE_HOLD_MS, PLAN_PROMPT, PLAN_TOOL_NAME, nudgeFor, planFromCall, planPath } from './plan'
import type { Plan } from './plan'
import { spriteSvg, termSprite } from './sprites'
import type { CostumeKey } from './sprites'
import { fmtTokens, parseUsage, usageDay, usageLine, usageRows } from './usage'

// Built-in layouts (SDD D-3), picked by which file a repo has; `.claude/board.json` overrides.
const PRESETS: ReadonlyArray<{ probe: string; sections: BoardSection[] }> = [
  {
    probe: '_NEXT.md', // myapp
    sections: [
      { kind: 'list', label: '下一步', file: '_NEXT.md', heading: '^## 现在', after: '^\\*\\*下一步\\*\\*', stamp: '^最近更新[:：](.*)$' },
      { kind: 'checklist', label: 'GOAL', file: 'docs/plan/*/GOAL.md', group: '###', titles: true },
      { kind: 'pending', label: '待拍板', file: 'docs/plan/DECISIONS-PENDING.md' },
      { kind: 'checklist', label: 'TODO', file: 'docs/plan/TODO.md', group: '##' },
      { kind: 'table', label: 'ROADMAP', file: 'docs/ROADMAP.md', show: '^(进行中|已排|待 owner)', count: '^(候选|待核)' },
    ],
  },
  {
    probe: 'docs/status/NEXT.md', // otherapp
    sections: [
      { kind: 'list', label: '下一步', file: 'docs/status/NEXT.md', heading: '^## ▶️ 下一步', stamp: '^## 🧭 现状[(（]([^)）]+)' },
      { kind: 'list', label: '待 owner(roadmap §5)', file: 'docs/ops/roadmap.md', heading: '^## 5\\. 待 owner' },
      { kind: 'list', label: 'NEXT 里的待办 / 待裁', file: 'docs/status/NEXT.md', heading: '^## 🙋', countOnly: true },
      { kind: 'table', label: 'ROADMAP 现在 + 接下来', file: 'docs/ops/roadmap.md', heading: '^### (现在|接下来)', show: '^(At Risk|Blocked|On Track|Not Started)', count: '^(Done)', alert: 'At Risk|Blocked' },
    ],
  },
]

const PANE = 'board'
const PANE_MIN_COLUMNS = 110
const TICK_MS = 60_000
// piw's `$PIW_DAILY_FALLBACK_TOKEN_CAP` default, the one its side documents.
const DEFAULT_DAILY_CAP = 300_000_000
// Wanted across sessions (a /clear starts a new one): set by /board open, cleared by /board close.
const WANT_KEY = 'paneOpen'
const model = atom({ plugin: 'board', key: 'model' } as const, null)
const at = atom({ plugin: 'board', key: 'at' } as const, 0)
const helpersAtom = atom({ plugin: 'board', key: 'helpers' } as const, [])
const bandAtom = atom({ plugin: 'board', key: 'band' } as const, null)
const clkAtom = atom({ plugin: 'board', key: 'clk' } as const, { tick: 0, now: 0 })
// D-5 of docs/plan/2026-10-23-board-tui-judge.md: `/board open` folds six blocks to their titles, `/board open all` does not.
// 这个会话侧栏折不折(D-5)。chosen = 本会话已经打过 /board open(all):session.start 晚到的「按上次的折叠重开」不再盖掉它
// (board-gate 并行截图时,/board open all 被晚到的重开改回了折叠)。
const foldAtom = atom({ plugin: 'board', key: 'fold' } as const, { folded: true, chosen: false })
const FOLD_KEY = 'paneFold'
const PANE_COLUMNS = 40  // 40 列稿(owner 10.23,他的 dockColumns 就是 40);宿主给的 bodyColumns 比 pane 少 1(左分隔线),再减框 4 格是内容宽

// D-4: BOARD_FIXTURE=<json> → every figure in the sidebar and the two lines comes from that file, nothing from git,
// repo files, the engine's usage or the agent list. Schema: docs/design/term/fixture/README.md.
type Fixture = View & { hud: Hud }
let fixture: Fixture | null | undefined
async function fixtureOf($: EngineInterface): Promise<Fixture | null> {
  if (fixture !== undefined) return fixture
  const path = ((await $.env.get('BOARD_FIXTURE').catch(() => undefined)) ?? '').trim()
  if (!path) return (fixture = null)
  const full = path.startsWith('/') ? path : `${await $.session.cwd().catch(() => '')}/${path}`
  try {
    fixture = JSON.parse(String(await $.fs.read(full))) as Fixture
  } catch (err) {
    fixture = null
    await logLine($, `fixture ${full}: ${String(err)}`)
  }
  return fixture
}

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME').catch(() => undefined)) ?? '/home/user'
}

const repoRoot = (cwd: string): string => cwd.replace(/(\/repos\/[^/]+).*$/, '$1')

const exists = async ($: EngineInterface, p: string): Promise<boolean> => !!(await $.fs.stat(p).catch(() => null))

async function readText($: EngineInterface, p: string): Promise<string | null> {
  try {
    return String(await $.fs.read(p))
  } catch {
    return null
  }
}

async function sectionsOf($: EngineInterface, root: string): Promise<BoardSection[] | null> {
  const own = await readText($, `${root}/.claude/board.json`)
  if (own) {
    try {
      const s = JSON.parse(own).sections
      if (Array.isArray(s)) return s as BoardSection[]
    } catch {
      // Malformed: fall back to the presets.
    }
  }
  for (const p of PRESETS) if (await exists($, `${root}/${p.probe}`)) return p.sections
  return null
}

// A file path with one `*` segment → the highest-versioned match, and what the `*` stood for.
async function resolveFile($: EngineInterface, root: string, file: string): Promise<{ path: string; tag: string } | null> {
  const star = file.indexOf('*')
  if (star < 0) return { path: `${root}/${file}`, tag: '' }
  const dir = `${root}/${file.slice(0, star)}`
  const rest = file.slice(star + 1)
  const names = (await $.fs.list(dir).catch(() => []))
    .filter(d => d.kind === 'dir')
    .map(d => d.name)
    .sort(byVersionDesc)
  for (const n of names) if (await exists($, `${dir}${n}${rest}`)) return { path: `${dir}${n}${rest}`, tag: ` ${n}` }
  return null
}

async function git($: EngineInterface, root: string, args: string[]): Promise<string> {
  try {
    const r = await $.process.run(['git', '-C', root, ...args], { timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

// Each section as a summary line and its details, or one line saying which file was missing.
async function board($: EngineInterface, root: string, sections: readonly BoardSection[], brief: boolean): Promise<string[]> {
  const now = Date.now()
  const out: string[] = []
  for (const s of sections) {
    const f = await resolveFile($, root, s.file)
    const md = f ? await readText($, f.path) : null
    if (!f || md === null) {
      out.push(`▸ ${s.label}:读不到 ${s.file}`)
      continue
    }
    const st = await $.fs.stat(f.path).catch(() => null)
    const r = render({ ...s, label: `${s.label}${f.tag}` }, md)
    out.push(`▸ ${r.summary}${st ? `  [${f.path.slice(root.length + 1)} ${age(now - st.mtimeMs)}]` : ''}`)
    if (!brief) out.push(...r.detail.map(d => `    ${d}`))
  }
  return out
}

type RunRef = Awaited<ReturnType<NonNullable<EngineInterface['delegate']>['runs']>>[number]

// Absent noun (delegate not installed): the call throws, caught here.
async function delegateRuns($: EngineInterface): Promise<RunRef[] | null> {
  try {
    const runs = await $.delegate!.runs()
    return Array.isArray(runs) ? runs : null
  } catch {
    return null
  }
}

// Absent noun (cache-clock not installed): the call throws, caught here.
async function cacheState($: EngineInterface): Promise<CacheIn | null> {
  try {
    return (await $.cacheClock!.state()) as CacheIn
  } catch {
    return null
  }
}

// Absent noun (relay not installed, or older than 0.x): the call throws, caught here.
async function relayState($: EngineInterface): Promise<RelayIn | null> {
  try {
    return (await $.relay!.handoff()) as RelayIn
  } catch {
    return null
  }
}

async function header($: EngineInterface, root: string): Promise<string> {
  const branch = await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = await git($, root, ['rev-parse', '--short', 'HEAD'])
  return `${root.split('/').pop()} · ${branch || '?'} ${head}`
}

// Today's spend, from the ledger piw writes; piw owns the cap, this only shows it.
// Nothing read (no file, no rows): null, so the board leaves the line out instead of printing 0.
async function usageToday($: EngineInterface): Promise<string | null> {
  const text = await readText($, `${await home($)}/.omd-lite/usage/${usageDay(new Date())}.jsonl`)
  if (!text) return null
  const cap = Number(((await $.env.get('PIW_DAILY_FALLBACK_TOKEN_CAP').catch(() => undefined)) ?? '').trim())
  return usageLine(parseUsage(text), Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_DAILY_CAP)
}

async function fullBoard($: EngineInterface, root: string, here: boolean): Promise<string> {
  const sections = await sectionsOf($, root)
  if (!sections) return `board:${root} 没有可读的进度文件(_NEXT.md / docs/status/NEXT.md / .claude/board.json)`
  const lines = [await header($, root), ...(await board($, root, sections, false))]
  // delegate's runs belong to this session, so only on the board of the repo it runs in.
  if (here) {
    const runs = await delegateRuns($)
    const live = (runs ?? []).filter(r => r.state === 'running')
    if (runs) lines.push(`▸ 在跑的片(${live.length}):${live.map(r => `${r.label}${r.executor ? `(${r.executor})` : ''}`).join(' · ') || '无'}`)
    const usage = await usageToday($)
    if (usage) lines.push(`▸ ${usage}`)
  }
  const log = await git($, root, ['log', '-5', '--format=%h %s'])
  if (log) lines.push('▸ 最近提交', ...log.split('\n').map(l => `    ${short(l, 90)}`))
  return lines.join('\n')
}

// `/board <section> [repo]`: which sections a word names.
const SECTION_WORDS: Record<string, (s: BoardSection) => boolean> = {
  roadmap: s => /^ROADMAP/.test(s.label),
  goal: s => /^GOAL/.test(s.label),
  todo: s => /^TODO/.test(s.label),
  next: s => /^下一步/.test(s.label),
  下一步: s => /^下一步/.test(s.label),
  待拍板: s => s.kind === 'pending' || /^待/.test(s.label),
  pending: s => s.kind === 'pending' || /^待/.test(s.label),
}

async function fullSection($: EngineInterface, root: string, word: string): Promise<string> {
  const sections = (await sectionsOf($, root)) ?? []
  const picked = sections.filter(SECTION_WORDS[word]!)
  if (!picked.length) return `board:${root.split('/').pop()} 没有「${word}」这一段`
  const out: string[] = []
  for (const s of picked) {
    const f = await resolveFile($, root, s.file)
    const md = f ? await readText($, f.path) : null
    if (!f || md === null) {
      out.push(`▸ ${s.label}:读不到 ${s.file}`)
      continue
    }
    out.push(`▸ ${render({ ...s, label: `${s.label}${f.tag}` }, md).summary}  [${f.path.slice(root.length + 1)}]`, ...renderFull(s, md), '')
  }
  return `${root.split('/').pop()}\n${out.join('\n').trim()}`
}

async function allBoards($: EngineInterface, h: string): Promise<string> {
  const out: string[] = []
  for (const d of await $.fs.list(`${h}/repos`).catch(() => [])) {
    if (d.kind !== 'dir') continue
    const root = `${h}/repos/${d.name}`
    // Main checkouts only: a worktree's .git is a file.
    if ((await $.fs.stat(`${root}/.git`).catch(() => null))?.kind !== 'dir') continue
    const sections = await sectionsOf($, root)
    if (!sections) continue
    out.push(await header($, root), ...(await board($, root, sections, true)), '')
  }
  return out.join('\n').trim() || 'board:~/repos 下没有带进度文件的仓'
}

// The sidebar's model for the repo this session works in (E① / H of docs/plan/2026-10-23-board-fidelity.md).
// Each block is { key, summary: `<title>\t<source>`, lines }; '#card' carries the top card's fields
// [repo, branch, sha, preset, now-line], '#hint' marks the H card that stands in for the progress blocks.
const SHOWN = 3
const ROADMAP_RUNNING = /^(进行中|On Track)/
const ROADMAP_ALERT = /^(Blocked|At Risk)/
const ROADMAP_QUEUED = /^(已排|Not Started)/
const ROADMAP_NICK = /^待 owner/

async function presetOf($: EngineInterface, root: string): Promise<string> {
  if (await exists($, `${root}/.claude/board.json`)) return 'board.json'
  for (const p of PRESETS) if (await exists($, `${root}/${p.probe}`)) return p.probe.split('/').pop() ?? p.probe
  return ''
}

async function buildModel($: EngineInterface, root: string): Promise<PaneModel> {
  const sections = await sectionsOf($, root)
  const now = Date.now()
  const name = root.split('/').pop() ?? root
  const [branch, sha, preset] = await Promise.all([git($, root, ['rev-parse', '--abbrev-ref', 'HEAD']), git($, root, ['rev-parse', '--short', 'HEAD']), presetOf($, root)])
  const m: PaneModel = { title: name, goal: null, running: [], blocks: [], roadmap: [] }
  const card = { key: '#card', summary: '', lines: [name, branch || '?', sha, preset, ''] }
  m.blocks.push(card)
  for (const s of sections ?? []) {
    const f = await resolveFile($, root, s.file)
    const md = f ? await readText($, f.path) : null
    if (!f || md === null) {
      m.blocks.push({ key: s.label, summary: `${s.label}\t读不到 ${s.file}`, lines: ['—'] })
      continue
    }
    const rel = f.path.slice(root.length + 1)
    const st = await $.fs.stat(f.path).catch(() => null)
    // 40 列稿：来源只写文件名，侧栏放不下就整段不画(tui.ts head)。
    const src = `${rel.split('/').pop()}${st ? ` · ${ago(now - st.mtimeMs)}` : ''}`
    if (s.kind === 'checklist' && s.titles && !m.goal) {
      const groups = checklistGroups(md, s.group)
      m.goal = { tag: src, groups: groups.map(g => ({ name: g.name, done: g.done, running: g.running.length, planned: g.planned.length })) }
      m.running = groups.flatMap(g => g.running)
      const done = groups.reduce((n, g) => n + g.done, 0)
      const total = groups.reduce((n, g) => n + g.done + g.running.length + g.planned.length, 0)
      const at = groups.findIndex(g => g.running.length + g.planned.length > 0)
      if (at >= 0) {
        const g = groups[at]!
        const next = g.running[0]?.title ?? itemTitle(g.planned[0] ?? '', 40)
        card.lines[4] = `现在在 §${at + 1} ${g.name} · 下一步:${next}`
      }
      m.blocks.push({ key: 'GOAL', summary: `GOAL · ${done}/${total}\t${src}`, lines: [] })
      continue
    }
    if (s.kind === 'checklist') {
      const groups = checklistGroups(md, s.group).map(g => ({ name: g.name, open: g.running.length + g.planned.length })).filter(g => g.open)
      const open = groups.reduce((n, g) => n + g.open, 0)
      m.blocks.push({ key: s.label, summary: `${s.label} · ${open} 未勾\t${src}`, lines: groups.slice(0, SHOWN).map(g => `§ ${g.name}\t${g.open} 未勾`) })
      continue
    }
    if (s.kind === 'pending') {
      const rows = openDecisionRows(md)
      m.blocks.push({ key: s.label, summary: `${s.label} · ${rows.length}\t${rel.split('/').pop()}`, lines: rows.length ? rows.slice(0, SHOWN).map(r => `⚠ ${itemTitle(r, 60)}`) : ['—'] })
      continue
    }
    if (s.kind === 'list') {
      const items = listItems(s, md)
      if (s.countOnly) m.blocks.push({ key: s.label, summary: `${s.label} · ${items.length}\t${src}`, lines: [] })
      else m.blocks.push({ key: s.label, summary: `${s.label}\t${src}`, lines: items.length ? items.slice(0, SHOWN).map(t => `· ${itemTitle(t, 60)}`) : ['—'] })
      continue
    }
    // table: the roadmap, counted and listed by status.
    const rows = tableRows(s.heading ? under(md, s.heading) : md.split('\n')).filter(r => !r.name.startsWith('~~'))
    const running = rows.filter(r => ROADMAP_RUNNING.test(r.status))
    const alert = rows.filter(r => ROADMAP_ALERT.test(r.status))
    const queued = rows.filter(r => ROADMAP_QUEUED.test(r.status)).length
    const owner = rows.filter(r => ROADMAP_NICK.test(r.status)).length
    const listed = [...alert.map(r => `⚠ ${r.status.split(/[\s(（]/)[0]}:${itemTitle(r.name, 40)}`), ...running.map(r => `▶ ${itemTitle(r.name, 50)}`)]
    m.blocks.push({
      key: s.label,
      summary: `ROADMAP · 进行 ${running.length + alert.length} · 排 ${queued} · 待 ${owner}\t${rel.split('/').pop()}`,
      lines: listed.length ? listed.slice(0, SHOWN) : ['—'],
    })
  }
  const log = await git($, root, ['log', `-${SHOWN}`, '--format=%h %s'])
  const commits = log ? log.split('\n') : []
  m.blocks.push({ key: '最近提交', summary: commits.length ? `最近提交 · ${commits.length}\tgit log` : '最近提交 · —\tgit log', lines: commits })
  const usage = await usageBlock($)
  m.blocks.push(usage)
  if (!sections) m.blocks.push({ key: '#hint', summary: '', lines: [] })
  return m
}

// `3m 前` / `5h 前` / `2d 前`: the E① mockup's short age.
function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s 前`
  if (s < 3600) return `${Math.floor(s / 60)}m 前`
  if (s < 86400 * 2) return `${Math.floor(s / 3600)}h 前`
  return `${Math.floor(s / 86400)}d 前`
}

async function usageBlock($: EngineInterface): Promise<PaneModel['blocks'][number]> {
  const text = await readText($, `${await home($)}/.omd-lite/usage/${usageDay(new Date())}.jsonl`)
  const u = text ? usageRows(parseUsage(text)) : null
  if (!u) return { key: '今日用量', summary: '今日用量 · —\t~/.omd-lite/usage', lines: [] }
  const capRaw = Number(((await $.env.get('PIW_DAILY_FALLBACK_TOKEN_CAP').catch(() => undefined)) ?? '').trim())
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : DEFAULT_DAILY_CAP
  return { key: '今日用量', summary: `今日用量 · ${fmtTokens(u.total)} / ${fmtTokens(cap)}\tusage`, lines: u.models.slice(0, SHOWN).map(x => `${x.model}\t${fmtTokens(x.total)}`) }
}

async function refresh($: EngineInterface): Promise<void> {
  if (await fixtureOf($)) return
  const m = await buildModel($, repoRoot(await $.session.cwd()))
  await update($, model, () => m)
  await update($, at, () => Date.now())
}


// ---------- Plan tool, helper cards and the 500ms clock (slice 5 of docs/plan/2026-10-23-board-unified.md) ----------

const PLAN_TOOL = `mcp__board__${PLAN_TOOL_NAME}`
const MIRRORED = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])
// D-4: one tick per 500ms while a helper works; a tick only moves the frame and the times.
const FRAME_MS = 500
const POLL_MS = 2000
const MAX_CARDS = 6

type Sub = { id: string; type: string; description: string; status: string; startedAt: number; contextTokens?: number; calls: number; ended?: boolean }

// Per session; reset at session.start.
let homeDir = ''
let sid = ''
let planOn = false
let plan: Plan | null = null
let planShown = false
let holdTimer: { cancel: () => void } | null = null
let turnCalls = 0
let turnPlanned = false
let nudged = false
let sincePlan = 0
let staleNudged = false
let subs: Sub[] = []
// agentId → 最近一次请求的上下文 tokens(turn.step 记)。
const agentCtx = new Map<string, number>()
const strangers = new Set<string>()
let runs: RunRef[] = []
let ticks = 0
let ticker: { cancel: () => void } | null = null
let poller: { cancel: () => void } | null = null
// The band above the prompt: the main chat's last effort (D-12), git read at most every GIT_MS.
let effort: string | null = null
let gitAt = -Infinity
let gitInfo = { repo: '', branch: '', dirty: false, ahead: 0 }
const GIT_MS = 10_000

async function gitNow($: EngineInterface, now: number): Promise<typeof gitInfo> {
  if (now - gitAt < GIT_MS) return gitInfo
  gitAt = now
  const root = repoRoot(await $.session.cwd().catch(() => ''))
  if (!root) return gitInfo
  const [branch, status, ahead] = await Promise.all([
    git($, root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, root, ['status', '--porcelain', '--untracked-files=no']),
    git($, root, ['rev-list', '--count', '@{u}..HEAD']),
  ])
  // A git call that comes back empty (busy index, timeout) keeps the last branch: D-3, the branch stays after a turn.
  const repo = root.split('/').pop() ?? ''
  gitInfo = { repo, branch: branch || (repo === gitInfo.repo ? gitInfo.branch : ''), dirty: status !== '', ahead: ahead === '' && repo === gitInfo.repo ? gitInfo.ahead : Number(ahead) || 0 }
  return gitInfo
}

const isDone = (p: Plan | null) => !!p && p.steps.length > 0 && p.steps.every(st => st.status === 'completed')
const nowIso = async ($: EngineInterface) => new Date(await $.clock.now()).toISOString()

async function logLine($: EngineInterface, line: string): Promise<void> {
  try {
    const dir = `${homeDir}/.claude/mods-logs`
    const path = `${dir}/board.log`
    const old = (await readText($, path)) ?? ''
    await $.process.run(['mkdir', '-p', dir])
    await $.fs.write(path, `${old}${new Date().toISOString()} ${line}\n`)
  } catch {
    // Logging must never break the session.
  }
}

/** Main-chat plan only; a write that fails leaves the band drawn from memory. */
async function writePlan($: EngineInterface): Promise<void> {
  if (!plan || !sid || !homeDir) return
  try {
    await $.process.run(['mkdir', '-p', `${homeDir}/.claude/mods-state`])
    const body = {
      title: plan.title,
      steps: plan.steps.map(st => ({ text: st.text, status: st.status, ...(st.doneAt ? { doneAt: st.doneAt } : {}) })),
      updatedAt: plan.updatedAt,
    }
    await $.fs.write(planPath(homeDir, sid), `${JSON.stringify(body, null, 2)}\n`)
  } catch (err) {
    await logLine($, `write plan: ${String(err)}`)
  }
}

async function drawPlan($: EngineInterface): Promise<void> {
  const v: PaneBand | null = plan ? { title: plan.title, steps: plan.steps.map(st => ({ text: st.text, status: st.status })), shown: planShown } : null
  await update($, bandAtom, () => v)
}

/** A finished plan stays at 100% for DONE_HOLD_MS, then the band goes. */
async function setPlan($: EngineInterface, next: Plan): Promise<void> {
  const wasDone = isDone(plan)
  plan = next
  if (!next.steps.length) planShown = false
  else if (isDone(next)) {
    planShown = true
    if (!wasDone) {
      holdTimer?.cancel()
      holdTimer = $.clock.after(DONE_HOLD_MS, () => {
        holdTimer = null
        planShown = false
        void drawPlan($).catch(() => undefined)
      })
    }
  } else {
    planShown = true
    holdTimer?.cancel()
    holdTimer = null
  }
  await writePlan($)
  await drawPlan($)
}

const STATUSES = ['pending', 'in_progress', 'completed']

/** The plan tool's own call: check the input, save it, answer in one line. */
async function planTool($: EngineInterface, args: Record<string, unknown>): Promise<string> {
  if (!Array.isArray(args.steps)) return 'Plan not saved: send steps as a list of { text, status }.'
  for (const st of args.steps as unknown[]) {
    const o = (st && typeof st === 'object' ? st : {}) as Record<string, unknown>
    const text = typeof o.text === 'string' ? o.text.trim() : ''
    if (!text) return 'Plan not saved: every step needs its text.'
    if (!STATUSES.includes(String(o.status))) return `Plan not saved: "${short(text, 40)}" needs a status of pending, in_progress or completed.`
  }
  const next = planFromCall(PLAN_TOOL, args, plan, await nowIso($))
  if (!next) return 'Plan not saved: something went wrong. Carry on.'
  await setPlan($, next)
  return `Plan saved: ${next.steps.filter(st => st.status === 'completed').length} of ${next.steps.length} steps done.`
}

/** TodoWrite / TaskCreate / TaskUpdate feed the same plan; TaskCreate's id comes from its result. */
async function mirror($: EngineInterface, tool: string, args: Record<string, unknown>, r: unknown): Promise<void> {
  const res = (r as { result?: unknown; isError?: boolean; deny?: string } | undefined) ?? {}
  if (res.deny || res.isError) return
  let input = args
  if (tool === 'TaskCreate') {
    const id = (res.result as { task?: { id?: unknown } } | undefined)?.task?.id
    if (typeof id === 'string') input = { ...args, taskId: id }
  }
  const next = planFromCall(tool, input, plan, await nowIso($))
  if (next) await setPlan($, next)
}

async function loadPlan($: EngineInterface): Promise<void> {
  const text = await readText($, planPath(homeDir, sid))
  if (!text) return
  try {
    const json = JSON.parse(text) as { title?: unknown; steps?: unknown; updatedAt?: unknown }
    const steps = (Array.isArray(json.steps) ? (json.steps as Record<string, unknown>[]) : [])
      .filter(st => st && typeof st.text === 'string' && STATUSES.includes(String(st.status)))
      .map(st => ({ text: String(st.text), status: st.status as Plan['steps'][number]['status'], ...(typeof st.doneAt === 'string' ? { doneAt: st.doneAt } : {}) }))
    plan = { title: typeof json.title === 'string' && json.title ? json.title : '计划', steps, updatedAt: typeof json.updatedAt === 'string' ? json.updatedAt : '' }
    planShown = steps.length > 0 && !isDone(plan)
    await drawPlan($)
  } catch (err) {
    await logLine($, `load plan: ${String(err)}`)
  }
}

// A short reminder after a main-chat tool's result, read by the model only: once per turn, once per stale stretch.
function withNudge<R>(r: R): R {
  turnCalls++
  sincePlan++
  const live = !!plan && !isDone(plan) && plan.steps.length > 0
  let note: string | null = null
  if (!nudged) {
    note = nudgeFor({ turnCalls, planned: turnPlanned, sinceUpdate: 0, live })
    if (note) nudged = true
  }
  if (!note && !staleNudged) {
    note = nudgeFor({ turnCalls: 0, planned: true, sinceUpdate: sincePlan, live })
    if (note) staleNudged = true
  }
  if (!note || !r || typeof r !== 'object' || 'deny' in (r as object)) return r
  const had = (r as { context?: readonly string[] }).context ?? []
  return { ...r, context: [...had, note] }
}

// helper 卡第 2 行开头的档名(着档色);ctx 条按 200k 窗口算。
const TIER_WORD: Record<string, string> = { heavy: 'heavy', medium: 'medium', fable: 'fable', careful: 'careful', light: 'light', explore: 'Explore', minimax: 'MiniMax', other: '通用' }
const CTX_WINDOW = 200_000

function helperList(): PaneHelper[] {
  return [
    ...subs.map(a => helperFromAgent({ ...a, contextTokens: agentCtx.get(a.id) })),
    ...runs.map(r => helperFromRun({ id: r.id ?? r.label, label: r.label, executor: r.executor ?? 'other', model: r.model, state: r.state, startedAt: r.startedAt ?? 0, round: r.round, maxRounds: r.maxRounds })),
  ]
}

async function tick($: EngineInterface): Promise<void> {
  ticks += 1
  const now = await $.clock.now()
  await update($, clkAtom, () => ({ tick: ticks, now }))
}

/** The 500ms clock and the 2s poll run only while a helper works (D-4). */
function syncClock($: EngineInterface, list: PaneHelper[]): void {
  if (list.some(h => h.phase === 'working')) {
    ticker ??= $.clock.every(FRAME_MS, () => void tick($).catch(() => undefined))
    poller ??= $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
  } else {
    ticker?.cancel()
    ticker = null
    poller?.cancel()
    poller = null
  }
}

async function publish($: EngineInterface): Promise<void> {
  const list = helperList()
  await update($, helpersAtom, () => list)
  const now = await $.clock.now()
  await update($, clkAtom, () => ({ tick: ticks, now }))
  syncClock($, list)
}

let scanning = false
async function scanRuns($: EngineInterface): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    const list = await delegateRuns($)
    if (!list || JSON.stringify(list) === JSON.stringify(runs)) return
    runs = list
    await publish($)
  } finally {
    scanning = false
  }
}

/**
 * Subagent status comes from $.agent.list() alone (D-4/D-5 of docs/plan/2026-10-23-board-fidelity.md): a subagent's
 * turn ending is not the subagent finishing; it may be waiting on its own background work.
 */
async function syncAgents($: EngineInterface): Promise<void> {
  if (!subs.length) return
  const list = await $.agent.list().catch(() => null)
  if (!list) return
  let changed = false
  const listed = list as Array<{ id: string; status: string; contextTokens?: number }>
  // Gone from the list after a turn of its own ended: the agent is over.
  for (const sub of subs) {
    if (sub.ended && !listed.some(a => a.id === sub.id) && sub.status !== 'completed' && sub.status !== 'failed' && sub.status !== 'killed') {
      sub.status = 'completed'
      changed = true
    }
  }
  for (const a of listed) {
    const sub = subs.find(x => x.id === a.id)
    if (!sub) continue
    if (a.status && a.status !== sub.status) {
      sub.status = a.status
      changed = true
    }
    if (typeof a.contextTokens === 'number' && a.contextTokens !== sub.contextTokens) {
      sub.contextTokens = a.contextTokens
      changed = true
    }
  }
  if (changed) await publish($)
}

async function poll($: EngineInterface): Promise<void> {
  await syncAgents($)
  await scanRuns($)
}

async function addSub($: EngineInterface, id: string, description: string, type: string): Promise<void> {
  const known = subs.find(a => a.id === id)
  if (known) {
    if (description) known.description = description
    if (type) known.type = type
  } else subs.push({ id, type: type || 'subagent', description: description || '子 agent', status: 'running', startedAt: await $.clock.now(), calls: 0 })
  await publish($)
}

/** A subagent whose spawn board missed: take it from $.agent.list(); a running one picks work up again. */
async function noteSub($: EngineInterface, id: string): Promise<void> {
  const sub = subs.find(a => a.id === id)
  if (sub) {
    sub.calls += 1
    sub.status = 'running'
    await publish($)
    return
  }
  if (strangers.has(id)) return
  const a = (await $.agent.list().catch(() => [])).find(x => x.id === id)
  if (!a) {
    strangers.add(id)
    return
  }
  await addSub($, id, a.description, a.type)
}

async function startPanel($: EngineInterface): Promise<void> {
  homeDir = await home($)
  sid = await $.session.id().catch(() => '')
  plan = null
  planShown = false
  holdTimer?.cancel()
  holdTimer = null
  turnCalls = 0
  turnPlanned = false
  nudged = false
  sincePlan = 0
  staleNudged = false
  subs = []
  strangers.clear()
  runs = []
  ticks = 0
  ticker?.cancel()
  ticker = null
  poller?.cancel()
  poller = null
  // helper-desk on: it owns the plan tool and its prompt; board only draws helpers (GWT-1b).
  let enabled: Record<string, unknown> = {}
  try {
    const v = (await $.settings.read({ key: 'enabledPlugins' } as never)) as Record<string, unknown>
    const inner = v && typeof v === 'object' && 'enabledPlugins' in v ? v.enabledPlugins : v
    if (inner && typeof inner === 'object') enabled = inner as Record<string, unknown>
  } catch {
    // Unreadable settings: board takes the plan.
  }
  planOn = enabled['helper-desk@owner-mods'] !== true
  if (planOn) {
    await $.tool
      .register({
        name: PLAN_TOOL_NAME,
        description:
          'Save the plan for the job in front of you: the steps in order, each pending, in_progress or completed. ' +
          'It draws a task bar in the board sidebar. Send the whole list every time, like TodoWrite.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'A short name for the job, a few words.' },
            steps: {
              type: 'array',
              description: 'Every step, in order.',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'The step in a few plain words.' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                },
                required: ['text', 'status'],
              },
            },
          },
          required: ['steps'],
        },
        // In front, not behind ToolSearch: a hidden tool never gets called.
        isDeferred: false,
      })
      .catch(err => logLine($, `register plan tool: ${String(err)}`))
    await loadPlan($)
  }
  await update($, helpersAtom, () => [])
  await update($, clkAtom, () => ({ tick: 0, now: 0 }))
  if (!planOn) await update($, bandAtom, () => null)
  void scanRuns($).catch(() => undefined)
}

// ---------- Drawing helpers ----------

const BAND_H = 24
const TRACK_H = 14
const P_LIGHT = '#c4b5fd'
const P_MID = '#8b5cf6'
const P_DEEP = '#6d28d9'
// D-8 of docs/plan/2026-10-23-board-fidelity.md: the palette of the E① / A mockups.
const GREEN = '#22c55e'
const YELLOW = '#eab308'
const GRAY = '#52525b'
const RED = '#ef4444'
const CARD_BG = '#221a40'
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const CELL = 3
const xml = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const textPx = (t: string, size: number) =>
  [...t].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Zmw@%]/.test(ch) ? 0.72 : 0.56) * size, 0)
const fitPx = (t: string, size: number, max: number) => {
  if (textPx(t, size) <= max) return t
  let out = ''
  for (const ch of t) {
    if (textPx(`${out}${ch}…`, size) > max) break
    out += ch
  }
  return `${out}…`
}
// Fixed noise, so the sparkles sit still between redraws and only their CSS twinkle moves.
const noise = (x: number, y: number) => {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return v - Math.floor(v)
}
const twinkleCss = (slow: boolean) =>
  `.s0,.s1,.s2,.s3{animation:tw ${slow ? 3.2 : 2.1}s ease-in-out infinite}` +
  `.s1{animation-duration:${slow ? 3.8 : 2.7}s;animation-delay:-.7s}.s2{animation-duration:${slow ? 4.4 : 1.8}s;animation-delay:-1.3s}` +
  `.s3{animation-duration:${slow ? 3.5 : 3.1}s;animation-delay:-.4s}` +
  `@keyframes tw{0%,100%{opacity:.95}50%{opacity:${slow ? 0.55 : 0.15}}}`
function sparkles(w: number, h: number, size: number, base: number, rise: number): string {
  const cols = Math.floor(w / CELL)
  const rows = Math.max(1, Math.floor(h / CELL))
  const out: string[] = []
  for (let c = 0; c < cols; c++) {
    const density = base + rise * Math.pow(c / Math.max(1, cols), 1.3)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) out.push(`<rect class="s${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 0.5}" y="${r * CELL + (h - rows * CELL) / 2 + 0.5}" width="${size}" height="${size}"/>`)
    }
  }
  return out.join('')
}

/** helper-desk's task bar: title, purple track, the live step glowing (1.6s), a shimmer sweeping the fill (2.6s). */
function bandSvg(p: PaneBand, W: number): string {
  const n = p.steps.length
  const done = p.steps.filter(st => st.status === 'completed').length
  const ratio = n ? done / n : 0
  const title = fitPx(p.title, 13, Math.max(60, W * 0.35))
  const barX = Math.round(14 + textPx(title, 13) + 12)
  const barW = Math.max(60, W - barX - 44)
  const y0 = (BAND_H - TRACK_H) / 2
  const fillW = Math.round(barW * ratio)
  const live = p.steps.some(st => st.status === 'in_progress')
  const liveW = live ? Math.round((barW * Math.min(n, done + 1)) / n) - fillW : 0
  const ticksSvg: string[] = []
  for (let i = 1; i < n; i++) {
    const x = Math.round((barW * i) / n)
    if (x > fillW + 3) ticksSvg.push(`<rect x="${x}" y="${TRACK_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }
  const label = `任务 ${done}/${n}`
  const pillW = Math.round(18 + textPx(label, 11))
  const pillX = Math.max(0, Math.min(barW - pillW, fillW - pillW))
  const finished = n > 0 && done === n
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${BAND_H}" viewBox="0 0 ${W} ${BAND_H}">
<style>
.tt{fill:#1f1f1f}.pc{fill:#6b6b6b}.k{fill:#ece9fb}.tk{fill:#c9c2f0}
@media (prefers-color-scheme: dark){.tt{fill:#ececec}.pc{fill:#a3a3a3}.k{fill:#2a2640}.tk{fill:#4c4470}}
${twinkleCss(finished)}
.lv{animation:gl 1.6s ease-in-out infinite}@keyframes gl{0%,100%{opacity:.18}50%{opacity:.5}}
.sh{animation:sw 2.6s linear infinite}@keyframes sw{from{transform:translateX(-70px)}to{transform:translateX(${fillW + 70}px)}}
@media (prefers-reduced-motion: reduce){.s0,.s1,.s2,.s3,.lv,.sh{animation:none}}
</style>
<defs>
<linearGradient id="bdb-g" x1="0" x2="1"><stop offset="0" stop-color="${P_LIGHT}"/><stop offset=".55" stop-color="${P_MID}"/><stop offset="1" stop-color="${P_DEEP}"/></linearGradient>
<linearGradient id="bdb-s" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<clipPath id="bdb-c"><rect width="${barW}" height="${TRACK_H}" rx="${TRACK_H / 2}"/></clipPath>
<clipPath id="bdb-f"><rect width="${fillW}" height="${TRACK_H}"/></clipPath>
</defs>
<circle cx="5" cy="${BAND_H / 2}" r="4" fill="${P_DEEP}"/>
<text class="tt" x="14" y="${BAND_H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="600">${xml(title)}</text>
<g transform="translate(${barX},${y0})">
<rect class="k" width="${barW}" height="${TRACK_H}" rx="${TRACK_H / 2}"/>
<g clip-path="url(#bdb-c)">
${liveW > 0 ? `<rect class="lv" x="${fillW}" width="${liveW}" height="${TRACK_H}" fill="${P_MID}"/>` : ''}
${fillW > 0 ? `<rect width="${fillW}" height="${TRACK_H}" fill="url(#bdb-g)"/>` : ''}
<g fill="#ffffff">${sparkles(fillW, TRACK_H, 1.6, 0.12, 0.4)}</g>
${fillW > 0 && !finished ? `<g clip-path="url(#bdb-f)"><rect class="sh" width="70" height="${TRACK_H}" fill="url(#bdb-s)"/></g>` : ''}
<g class="tk">${ticksSvg.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${TRACK_H}" rx="${TRACK_H / 2}" fill="${P_DEEP}"/>
<text x="${pillX + pillW / 2}" y="${TRACK_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(label)}</text>
</g>
<text class="pc" x="${W - 4}" y="${BAND_H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${Math.round(ratio * 100)}%</text>
</svg>`
}

// The tier's colour per costume, as the card's accent.
const COSTUME_COLOR: Record<CostumeKey, string> = {
  fable: '#7F77DD', heavy: '#D85A30', careful: '#BA7517', medium: '#378ADD', light: '#1D9E75', explore: '#E8613C', minimax: '#F23F5D', other: '#D97757',
}
const COSTUME_WORD: Record<CostumeKey, string> = {
  fable: 'fable', heavy: 'heavy', careful: 'careful', medium: 'medium', light: 'light', explore: 'Explore', minimax: 'MiniMax', other: '子 agent',
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

// 缓存 v2 D-6:◷ 段的按钮都交给 cache-clock 自己的命令(board 不碰保温和交接的状态)。
const CACHE_CMD: Record<CacheAction, { command: string; args?: string }> = {
  warm: { command: 'keepwarm' },
  rewarm: { command: 'keepwarm' },
  stop: { command: 'keepwarm', args: 'off' },
  skip: { command: 'cacheclock', args: 'skip' },
  handoff: { command: 'cacheclock', args: 'handoff' },
  'ho-cancel': { command: 'relay', args: 'cancel' },
  'ho-now': { command: 'relay', args: 'now' },
}
async function pressCache($: EngineInterface, a: CacheAction): Promise<void> {
  try {
    await $.command.run(CACHE_CMD[a])
  } catch (err) {
    await logLine($, `cache ${a}: ${String(err)}`)
    $.ui.toast(`board:${a === 'handoff' ? '一键交接' : '保温'}没跑成(cache-clock 没装或没开?)`)
  }
}

/**
 * Line 2 when the ◷ segment has buttons. A Button takes no colours, so each one is drawn twice: the G cells as a Text,
 * and over them, shown only while the pointer is on its keyed Box, a plain Button of the same label (a pointer on an
 * absolute Box belongs to its parent, so the Button has to be on top to take the click).
 */
function line2(ui: { Box: unknown; Text: unknown; Button: unknown }, row: Row, $: EngineInterface): JSX.Element {
  const B = ui.Box as (p: Record<string, unknown>) => JSX.Element
  const Btn = ui.Button as (p: Record<string, unknown>) => JSX.Element
  const X = ui.Text as TextEl
  const out: JSX.Element[] = []
  let run: Row = []
  const flush = () => {
    if (run.length) out.push(<X key={`r${out.length}`}>{segs(ui.Text, run)}</X>)
    run = []
  }
  for (const s of row) {
    if (!s.press) {
      run.push(s)
      continue
    }
    flush()
    const a = s.press
    out.push(
      <B key={`cache-${a}`} position="relative" flexShrink={0}>
        <X color={s.fg} backgroundColor={s.bg} bold={s.b}>
          {s.t}
        </X>
        <B position="absolute" left={0} top={0} display="none" hover={{ display: 'flex' }}>
          <Btn key={`cache-${a}-btn`} plain label={s.t} onPress={() => void pressCache($, a)} />
        </B>
      </B>,
    )
  }
  flush()
  return (
    <B key="hud-2" flexDirection="row" flexWrap="nowrap" overflow="hidden">
      {out}
    </B>
  )
}

type TextEl = (p: { color?: string; backgroundColor?: string; bold?: boolean; children?: unknown }) => JSX.Element
function segs(Text: unknown, row: Row): JSX.Element[] {
  const X = Text as TextEl
  return row.map((s, i) => (
    <X key={`s${i}`} color={s.fg} backgroundColor={s.bg} bold={s.b}>
      {s.t}
    </X>
  ))
}

/** The two lines from the engine, git, the plan, the helpers and cache-clock. */
async function liveHud($: EngineInterface): Promise<Hud> {
  const now = await $.clock.now()
  const [modelId, usage, g, band, list, cc] = await Promise.all([
    $.session.model().catch(() => null),
    $.session.usage().catch(() => null),
    gitNow($, now),
    read($, bandAtom),
    read($, helpersAtom),
    cacheState($),
  ])
  const ho = await relayState($)
  const limits = (usage?.rateLimits ?? []) as Limit[]
  const five = limits.find(l => l.kind === 'five_hour')
  const week = limits.find(l => l.kind === 'seven_day')
  const t = band && band.shown && band.steps.length ? taskText(band.steps) : null
  return {
    model: modelId ? modelShort(modelId) : null,
    effort,
    repo: g.repo,
    branch: g.branch,
    dirty: g.dirty,
    ahead: g.ahead,
    ctx: usage?.context?.percent ?? null,
    fiveH: five ? { pct: five.percentUsed, reset: untilReset(five.resetsAt, now) } : null,
    week: week ? week.percentUsed : null,
    remote: (await $.session.surfaces().catch(() => [] as readonly string[])).some(x => x !== 'terminal'),
    task: t ? { done: t.done, n: t.n, text: t.live } : null,
    dots: list.filter(h => h.phase === 'working').map(h => h.costume),
    cacheMin: cacheMinutes(cc, now),
    cache: handoffView(ho, now) ?? cacheView(cc, now),
  }
}

/** The sidebar's View from the repo's model, the helpers and the plan. */
async function liveView($: EngineInterface): Promise<View> {
  const m: PaneModel = (await read($, model)) ?? { title: '', goal: null, running: [], blocks: [], roadmap: [] }
  const updated = await read($, at)
  const list = await read($, helpersAtom)
  const band = await read($, bandAtom)
  const clk = await read($, clkAtom)
  const now = clk.now || Date.now()
  const [repo = m.title, branch = '?', sha = '', preset = '', nowLine = ''] = m.blocks.find(b => b.key === '#card')?.lines ?? []
  const hasProgress = m.blocks.some(b => !b.key.startsWith('#') && b.key !== '最近提交' && b.key !== '今日用量')
  const sum = m.goal?.groups.reduce((a, g) => ({ done: a.done + g.done, running: a.running + g.running, planned: a.planned + g.planned }), { done: 0, running: 0, planned: 0 })
  const total = sum ? sum.done + sum.running + sum.planned : 0
  const working = list.filter(h => h.phase === 'working')
  const minimaxN = working.filter(h => h.costume === 'minimax').length
  const shown = working.slice(0, MAX_CARDS)
  // 40 列稿：任务条标题 + plan-<会话>.json 放不下，来源不画。
  let plan: View['plan'] = { title: '任务条 · 本会话计划', source: '', none: true }
  if (band && band.shown && band.steps.length) {
    const n = band.steps.length
    const done = band.steps.filter(st => st.status === 'completed').length
    const step = band.steps.find(st => st.status === 'in_progress')?.text ?? band.steps[n - 1]!.text
    plan = { title: plan.title, source: plan.source, fill: done / n, line: `▶ ${step}${/[)）]$/.test(step) ? '' : ' '}· ${done}/${n}` }
  }
  const blocks = m.blocks
    .filter(b => !b.key.startsWith('#'))
    .map(b => {
      const [title = b.key, source = ''] = b.summary.split('\t')
      const roadmap = /^ROADMAP/.test(title)
      let rows: BodyRow[]
      if (b.key === 'GOAL' && m.goal) rows = m.goal.groups.map((g, i) => ({ bar: `§${i + 1} ${g.name}`, done: g.done, running: g.running, planned: g.planned }))
      else if (!b.lines.length) rows = /· —/.test(title) ? [] : [{ dash: true }]
      else
        rows = b.lines.map((l): BodyRow => {
          if (l === '—') return { dash: true }
          const [left = '', right = ''] = l.split('\t')
          if (right) return { left, right }
          const mark = left.slice(0, 2)
          if (mark === '⚠ ') return roadmap ? { alert: left.slice(2) } : { warn: left.slice(2) }
          if (mark === '▶ ') return { run: left.slice(2) }
          if (mark === '· ') return { bullet: left.slice(2) }
          return { text: left }
        })
      return { key: b.key, title, source, rows }
    })
  return {
    card: {
      repo,
      pct: sum && total ? `${Math.round((sum.done / total) * 100)}%` : '—%',
      live: `活 · ${updated ? ago(now - updated) : '0s 前'} · ${branch} ${sha}`,
      now: hasProgress ? nowLine : '没有进度文件',
      bar: sum && total ? sum : { done: 0, running: 0, planned: 1 },
    },
    who: {
      title: `谁在跑 · ${working.length}`,
      source: `子 agent ${working.length - minimaxN} · MiniMax ${minimaxN}`,
      helpers: shown.map(hp => {
        const t = termSprite(hp.costume as CostumeKey, frameOf(clk.tick, hp.phase))
        const took = hp.startedAt ? elapsed(now - hp.startedAt) : '0s'
        // 40 列稿 helper 卡：第 2 行 <档> · <tokens> · <用时>(MiniMax 读不到 tokens:<档> · <用时>),第 3 行档色条 + 尾字(子 agent = ctx 占比,MiniMax = 轮次)。
        if (hp.maxRounds) {
          return { id: hp.id, costume: hp.costume, name: hp.label, meta: `${TIER_WORD[hp.costume] ?? 'MiniMax'} · ${took}`, fill: (hp.round ?? 0) / hp.maxRounds, tail: `${hp.round ?? 0}/${hp.maxRounds} 轮`, rows: t.rows, colors: t.colors }
        }
        const ctxPct = hp.tokens === null ? null : Math.min(100, Math.round((hp.tokens / CTX_WINDOW) * 100))
        return { id: hp.id, costume: hp.costume, name: hp.label, meta: `${TIER_WORD[hp.costume] ?? '通用'}${hp.tokens === null ? '' : ` · ${fmtTokens(hp.tokens)}`} · ${took}`, fill: (ctxPct ?? 0) / 100, tail: ctxPct === null ? '' : `ctx ${ctxPct}%`, rows: t.rows, colors: t.colors }
      }),
      more: working.length - shown.length,
    },
    plan,
    blocks,
    hint: m.blocks.some(b => b.key === '#hint'),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    fixture = undefined
    effort = null
    gitAt = -Infinity
    await $.command.register({
      name: 'board',
      description: '进度板:下一步 · GOAL 进行中 / 规划中 · 待拍板 · TODO · roadmap · 最近提交(纯读文件);open / close 开关侧栏',
      argumentHint: '[仓名|all|open|close|roadmap|goal|todo|next|待拍板 [仓名]]',
    })
    $.clock.every(TICK_MS, () => void refresh($).catch(() => undefined))
    // F 稿 ④:交接倒计时按秒跳，只在 relay 交接进行时重画。
    $.clock.every(1000, () =>
      void (async () => {
        if (handoffView(await relayState($), await $.clock.now())) $.ui.invalidate('ui.render')
      })().catch(() => undefined),
    )
    await startPanel($).catch(err => logLine($, `start: ${String(err)}`))
    // Re-open the sidebar a /clear or restart closed, if owner asked for it.
    if (await $.store.get(WANT_KEY).catch(() => false)) {
      const folded = (await $.store.get(FOLD_KEY).catch(() => true)) !== false
      void update($, foldAtom, p => (p.chosen ? p : { folded, chosen: false }))
        .then(() => refresh($))
        .then(() => $.ui.open({ id: PANE, title: '进度', columns: PANE_COLUMNS }))
        .catch(() => undefined)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const id = e.agentId
    if (!id) {
      void refresh($).catch(() => undefined)
      void scanRuns($).catch(() => undefined)
    } else {
      // Not 'completed': the subagent may be waiting on its own background work; the agent list says which.
      const sub = subs.find(a => a.id === id)
      if (sub) sub.ended = true
      if (sub) void syncAgents($).catch(err => logLine($, `turn: ${String(err)}`))
    }
    return done
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && e.effort !== undefined && String(e.effort) !== effort) {
      effort = String(e.effort)
      $.ui.invalidate('ui.render')
    }
    const r = yield* next(e)
    // 子 agent 每次请求的上下文 tokens(输入 + 缓存读 + 缓存写),helper 卡的 tokens 与 ctx 条用(40 列稿)。
    const u = (r as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null }).usage
    if (e.agentId && u) agentCtx.set(e.agentId, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))
    return r
  })

  // Two lines above the prompt (SDD D-11): where / how much is left, then what is running.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const room = (Number((e.props as { bodyColumns?: number }).bodyColumns) || 200) - 1
    const fx = await fixtureOf($)
    const [l1, l2] = hudLines(fx ? fx.hud : await liveHud($), room)
    return (
      <Box flexDirection="column">
        {rest}
        <Text key="hud-1" wrap="truncate-end">{segs(Text, l1)}</Text>
        {l2.some(s => s.press) ? line2({ Box, Text, Button }, l2, $) : <Text key="hud-2" wrap="truncate-end">{segs(Text, l2)}</Text>}
      </Box>
    )
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = (r as { agentId?: string }).agentId
    if (id) void addSub($, id, e.description ?? '', e.subagentType ?? '').catch(err => logLine($, `spawn: ${String(err)}`))
    return r
  })

  // One unfiltered hook: a typed tool matcher makes tsc recurse through the connector types.
  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string
    const args = e as unknown as Record<string, unknown>
    const id = e.agentId
    if (planOn && tool === PLAN_TOOL) {
      if (id) return { result: 'Only the main chat keeps a plan. Carry on with your task.' } as never
      let said = 'Plan not saved: something went wrong. Carry on.'
      try {
        said = await planTool($, args)
      } catch (err) {
        await logLine($, `plan: ${String(err)}`)
      }
      turnPlanned = true
      sincePlan = 0
      staleNudged = false
      return { result: said } as never
    }
    if (id) {
      void noteSub($, id).catch(() => undefined)
      return next(e)
    }
    if (planOn && MIRRORED.has(tool)) {
      const r = await next(e)
      turnPlanned = true
      sincePlan = 0
      void mirror($, tool, args, r).catch(err => logLine($, `mirror ${tool}: ${String(err)}`))
      return r
    }
    const launch = tool === 'Bash' && /omd-lite|omdl-launch|mcode\.sh/.test(String(args.command ?? ''))
    const r = await next(e)
    if (launch) {
      void scanRuns($).catch(() => undefined)
      $.clock.after(3000, () => void scanRuns($).catch(() => undefined))
    }
    return planOn ? withNudge(r) : r
  })

  // A new prompt is a new task: the plan nudge counts from zero.
  on('prompt.submit', async ($, e, next) => {
    turnCalls = 0
    turnPlanned = false
    nudged = false
    sincePlan = 0
    staleNudged = false
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!planOn || e.traits?.includes('teammate') || e.traits?.includes('bare')) return r
    return { ...r, sections: [...(r.sections ?? []), { id: 'board:plan', text: PLAN_PROMPT, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    if (e.surface === 'terminal') {
      const fx = await fixtureOf($)
      const v = fx ?? (await liveView($))
      const W = Math.max(30, e.props.bodyColumns - 4)
      const folded = (await read($, foldAtom)).folded
      const bodyRows = Number((e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows) || 200
      const drawn = sidebar(v, W, folded, fitCap(v, W, folded, bodyRows))
      // Rows sharing a key (a sprite's five) sit in one keyed Box, so a test or a reader finds the group.
      const groups: Array<{ key: string; rows: Row[] }> = []
      for (const d of drawn) {
        const last = groups[groups.length - 1]
        if (last && last.key === d.key) last.rows.push(d.row)
        else groups.push({ key: d.key, rows: [d.row] })
      }
      return (
        <Box flexDirection="column" width={W + 4}>
          {groups.map(g => (
            <Box key={g.key} flexDirection="column">
              {g.rows.map((r, i) => (
                <Text key={`r${i}`} wrap="truncate-end">
                  {segs(Text, r)}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      )
    }
    // Svg draws on desktop, the editor and mobile; the terminal gets half blocks.
    const Svg = 'Svg' in els ? els.Svg : null
    // Before the first refresh there is no model yet: helpers and the plan still draw, the card waits.
    const m: PaneModel = (await read($, model)) ?? { title: '', goal: null, running: [], blocks: [], roadmap: [] }
    const updated = await read($, at)
    const list = await read($, helpersAtom)
    const band = await read($, bandAtom)
    const clk = await read($, clkAtom)
    const W = Math.max(30, e.props.bodyColumns)

    // Text rows of exactly W cells; the sidebar is drawn as rows so every edge sits on the same column (E-16).
    const now = clk.now || Date.now()
    const padTo = (t: string, n: number) => t + ' '.repeat(Math.max(0, n - cells(t)))
    const titleRow = (key: string, title: string, source: string) => {
      const left = ` ${title}`
      const room = W - cells(left) - 2
      const src = room >= 4 ? cut(source, room) : ''
      return (
        <Text key={key} wrap="truncate-end">
          <Text bold>{left}</Text>
          {' '.repeat(Math.max(1, W - cells(left) - cells(src) - 1))}
          <Text dimColor>{src}</Text>
        </Text>
      )
    }
    const dash = (key: string) => (
      <Text key={key} dimColor>
        {'  —'}
      </Text>
    )
    const sideRow = (key: string, left: string, right: string, leftColor?: string) => {
      const r = cut(right, Math.max(0, W - 6))
      const l = cut(left, Math.max(4, W - cells(r) - 4))
      return (
        <Text key={key} wrap="truncate-end">
          {'  '}
          <Text color={leftColor}>{l}</Text>
          {' '.repeat(Math.max(1, W - 3 - cells(l) - cells(r)))}
          <Text dimColor>{r}</Text>
        </Text>
      )
    }

    // ---- top card: deep purple, rounded, the big percentage in block glyphs (E-1..E-4, H-1, D-7) ----
    const cardBlock = m.blocks.find(b => b.key === '#card')
    const [repo = m.title, branch = '?', sha = '', preset = '', nowLine = ''] = cardBlock?.lines ?? []
    const hasProgress = m.blocks.some(b => !b.key.startsWith('#') && b.key !== '最近提交' && b.key !== '今日用量')
    const sum = m.goal?.groups.reduce((a, g) => ({ done: a.done + g.done, running: a.running + g.running, planned: a.planned + g.planned }), { done: 0, running: 0, planned: 0 })
    const total = sum ? sum.done + sum.running + sum.planned : 0
    const pct = sum && total ? Math.round((sum.done / total) * 100) : null
    const inner = W - 2
    const edge = (t: string) => <Text color={P_MID}>{t}</Text>
    const onCard = (key: string, parts: JSX.Element[], used: number) => (
      <Text key={key} wrap="truncate-end">
        {edge('│')}
        {parts}
        <Text backgroundColor={CARD_BG}>{' '.repeat(Math.max(0, inner - used))}</Text>
        {edge('│')}
      </Text>
    )
    const big = pct === null ? null : bigText(`${pct}%`)
    const bigW = big ? cells(big[0]) : 2
    const leftW = inner - bigW - 3
    const cardLine = (key: string, left: string, opts: { bold?: boolean; dim?: boolean; color?: string }, right: string, rightColor: string) => {
      const l = padTo(cut(left, leftW), leftW)
      return onCard(
        key,
        [
          <Text key="p" backgroundColor={CARD_BG}>{' '}</Text>,
          <Text key="l" backgroundColor={CARD_BG} bold={opts.bold} dimColor={opts.dim} color={opts.color}>{l}</Text>,
          <Text key="g" backgroundColor={CARD_BG}>{' '}</Text>,
          <Text key="r" backgroundColor={CARD_BG} color={rightColor}>{padTo(right, bigW)}</Text>,
        ],
        1 + leftW + 1 + bigW,
      )
    }
    const tri = sum && total ? barCells(sum, inner - 2) : { done: 0, running: 0, planned: inner - 2 }
    const time = updated ? new Date(updated).toTimeString().slice(0, 5) : new Date(now).toTimeString().slice(0, 5)
    const live = `● 活 · ${updated ? ago(now - updated) : '0s 前'} · ${branch} ${sha} · 预设 ${preset || '—'}`
    const cardEl = (
      <Box key="card" flexDirection="column">
        <Text wrap="truncate-end">{edge(`╭${'─'.repeat(inner)}╮`)}</Text>
        {hasProgress
          ? [
              cardLine('c1', repo, { bold: true }, big?.[0] ?? '', P_MID),
              cardLine('c2', live, { color: '#a1a1aa' }, big?.[1] ?? '—%', big ? P_MID : '#a1a1aa'),
              cardLine('c3', nowLine, {}, big?.[2] ?? '', P_MID),
            ]
          : [cardLine('c1', `${repo} · ${branch} ${sha} ${time}`, { bold: true }, '', P_MID), cardLine('c2', '进度 — 没有进度文件', { color: '#a1a1aa' }, '—%', '#a1a1aa')]}
        {onCard(
          'c4',
          [
            <Text key="p" backgroundColor={CARD_BG}>{' '}</Text>,
            <Text key="d" backgroundColor={CARD_BG} color={GREEN}>{'█'.repeat(tri.done)}</Text>,
            <Text key="r" backgroundColor={CARD_BG} color={YELLOW}>{'█'.repeat(tri.running)}</Text>,
            <Text key="o" backgroundColor={CARD_BG} color={GRAY}>{'█'.repeat(tri.planned)}</Text>,
          ],
          1 + inner - 2,
        )}
        <Text wrap="truncate-end">{edge(`╰${'─'.repeat(inner)}╯`)}</Text>
      </Box>
    )

    // ---- 谁在跑: one card per working helper (E-5..E-7); counts are working helpers only (D-4) ----
    const working = list.filter(h => h.phase === 'working')
    const minimaxN = working.filter(h => h.costume === 'minimax').length
    const halfBlocks = (rows: string[], colors: Record<string, string>, key: string) => {
      const lines = []
      for (let y = 0; y < rows.length; y += 2) {
        const top = rows[y] ?? ''
        const bottom = rows[y + 1] ?? ''
        const cs = [...top].map((t, x) => {
          const a = colors[t]
          const b = colors[bottom[x] ?? '.']
          if (a && b) return <Text key={`c${x}`} color={a} backgroundColor={b}>▀</Text>
          if (a) return <Text key={`c${x}`} color={a}>▀</Text>
          if (b) return <Text key={`c${x}`} color={b}>▄</Text>
          return <Text key={`c${x}`}> </Text>
        })
        lines.push(<Text key={`${key}-${y}`}>{cs}</Text>)
      }
      return (
        <Box key={key} flexDirection="column" flexShrink={0}>
          {lines}
        </Box>
      )
    }
    const helperCard = (hp: PaneHelper) => {
      const color = COSTUME_COLOR[hp.costume]
      const steps = `${hp.round ?? 0}/${hp.maxRounds ?? '—'} ${hp.maxRounds ? '轮' : '步'}`
      const meta = `${steps} · ${hp.tokens === null ? '—' : fmtTokens(hp.tokens)} · ${hp.startedAt ? elapsed(now - hp.startedAt) : '0s'}`
      const sprite = Svg ? (
        <Box key={`sprite-${hp.id}`} width={7} flexShrink={0}>
          <Svg source={spriteSvg(hp.costume as CostumeKey, true, 1.5)} alt={`${COSTUME_WORD[hp.costume]} crab`} width={45} height={42} />
        </Box>
      ) : (
        (() => {
          const t = termSprite(hp.costume as CostumeKey, frameOf(clk.tick, hp.phase))
          return halfBlocks(t.rows, t.colors, `sprite-${hp.id}`)
        })()
      )
      return (
        <Box key={`helper-${hp.id}`} flexDirection="row" paddingLeft={2} gap={2}>
          {sprite}
          <Box flexDirection="column" flexGrow={1}>
            <Text wrap="truncate-end" bold color={color}>
              {hp.label}
            </Text>
            <Text wrap="truncate-end" dimColor>
              {meta}
            </Text>
          </Box>
        </Box>
      )
    }
    const shownCards = working.slice(0, MAX_CARDS)
    const whoEl = (
      <Box key="who" flexDirection="column">
        {titleRow('who-h', `谁在跑 · ${working.length}`, `子 agent ${working.length - minimaxN} · MiniMax ${minimaxN}`)}
        {shownCards.length ? shownCards.map(helperCard) : dash('who-none')}
        {working.length > shownCards.length ? <Text key="who-more" dimColor>{`  +${working.length - shownCards.length}`}</Text> : null}
      </Box>
    )

    // ---- 任务条 · 本会话计划 (E-8) ----
    let bandRows: JSX.Element[] = [dash('band-none')]
    if (band && band.shown && band.steps.length) {
      const n = band.steps.length
      const done = band.steps.filter(st => st.status === 'completed').length
      const liveStep = band.steps.find(st => st.status === 'in_progress')
      const step = `▶ ${cut(liveStep?.text ?? band.steps[n - 1]!.text, W - 14)} · ${done}/${n}`
      if (Svg) {
        const px = Math.max(180, Math.min(1600, W * 8 - 16))
        bandRows = [
          <Box key="task-band">
            <Svg source={bandSvg(band, px)} alt={`${band.title}: 任务 ${done}/${n}`} width={px} height={BAND_H} />
          </Box>,
          <Text key="band-step" wrap="truncate-end">{`  ${step}`}</Text>,
        ]
      } else {
        const barW = Math.max(6, W - 4)
        const fill = Math.round((barW * done) / n)
        const liveW = liveStep ? Math.min(barW - fill, Math.max(1, Math.round(barW / n))) : 0
        bandRows = [
          <Box key="task-band">
            <Text wrap="truncate-end">
              {'  '}
              <Text color={P_MID}>{'█'.repeat(fill)}</Text>
              <Text color={P_LIGHT}>{(clk.tick % 2 ? '▓' : '▒').repeat(liveW)}</Text>
              <Text color={GRAY}>{'░'.repeat(barW - fill - liveW)}</Text>
            </Text>
          </Box>,
          <Text key="band-step" wrap="truncate-end">
            <Text color={P_MID}>{'  ▶ '}</Text>
            {step.slice(2)}
          </Text>,
        ]
      }
    }
    const bandEl = (
      <Box key="band" flexDirection="column">
        {titleRow('band-h', '任务条 · 本会话计划', sid ? `plan-${sid.slice(0, 8)}.json` : '')}
        {bandRows}
      </Box>
    )

    // ---- progress blocks, commits, usage; the H hint card when the repo has no progress files ----
    const LABEL = Math.min(16, Math.floor(W / 3))
    const COUNT = 7
    const goalRow = (key: string, name: string, t: { done: number; running: number; planned: number }) => {
      const b = barCells(t, Math.max(6, W - LABEL - COUNT - 4))
      return (
        <Text key={key} wrap="truncate-end">
          {'  ' + padTo(cut(name, LABEL - 1), LABEL)}
          <Text color={GREEN}>{'█'.repeat(b.done)}</Text>
          <Text color={YELLOW}>{'█'.repeat(b.running)}</Text>
          <Text color={GRAY}>{'█'.repeat(b.planned)}</Text>
          <Text dimColor>{`${t.done}/${t.done + t.running + t.planned}`.padStart(COUNT)}</Text>
        </Text>
      )
    }
    const hintEl = () => {
      const hw = W - 4
      const row = (key: string, parts: JSX.Element[], used: number) => (
        <Text key={key} wrap="truncate-end">
          <Text dimColor>{'  ┆'}</Text>
          {parts}
          {' '.repeat(Math.max(0, hw - 2 - used))}
          <Text dimColor>{'┆'}</Text>
        </Text>
      )
      const fileLine = (key: string, pairs: Array<[string, string]>) => {
        const els: JSX.Element[] = [<Text key="b">{' · '}</Text>]
        let used = 3
        pairs.forEach(([f, what], i) => {
          if (i) {
            els.push(<Text key={`s${i}`} dimColor>{' · '}</Text>)
            used += 3
          }
          els.push(<Text key={`f${i}`} bold>{f}</Text>, <Text key={`w${i}`} dimColor>{` → ${what}`}</Text>)
          used += cells(f) + cells(` → ${what}`)
        })
        return row(key, els, used)
      }
      const head = ' 进度块没亮:仓里还没有进度文件。'
      const head2 = ' 建一个就会出现对应块:'
      return (
        <Box key="hint" flexDirection="column">
          <Text dimColor>{`  ╭${'┄'.repeat(hw - 2)}╮`}</Text>
          {row('h0', [<Text key="t" bold>{head.slice(0, 6)}</Text>, <Text key="u" dimColor>{head.slice(6)}</Text>], cells(head))}
          {row('h1', [<Text key="u" dimColor>{head2}</Text>], cells(head2))}
          {fileLine('h2', [['<版本>/GOAL.md', '百分比+各节']])}
          {fileLine('h3', [['docs/ROADMAP.md', 'ROADMAP']])}
          {fileLine('h4', [['docs/plan/TODO.md', 'TODO']])}
          {fileLine('h5', [['_NEXT.md', '下一步']])}
          {fileLine('h6', [['DECISIONS-PENDING.md', '待拍板']])}
          <Text dimColor>{`  ╰${'┄'.repeat(hw - 2)}╯`}</Text>
        </Box>
      )
    }
    // Fit the pane's height: every list block gives up rows evenly (3 → 2 → 1) before anything falls off the bottom.
    const bodyRows = Number((e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows) || 200
    const spriteRows = Svg ? 3 : Math.ceil(termSprite('other', 0).rows.length / 2)
    const fixedRows =
      6 + 1 + (shownCards.length ? shownCards.length * Math.max(2, spriteRows) : 1) + (working.length > shownCards.length ? 1 : 0) + 1 + bandRows.length
    const listed = m.blocks.filter(b => b.key !== '#card')
    const rowsAt = (cap: number) =>
      listed.reduce((n, b) => n + (b.key === '#hint' ? 9 : 1 + (b.key === 'GOAL' && m.goal ? m.goal.groups.length : Math.min(cap, Math.max(b.lines.length, /· —/.test(b.summary) ? 0 : 1)))), fixedRows)
    let cap = SHOWN
    while (cap > 1 && rowsAt(cap) > bodyRows) cap--
    const blockEls = listed
      .map(b => ({ ...b, lines: b.lines.slice(0, cap), summary: b.key === '最近提交' && b.lines.length ? b.summary.replace(/· \d+/, `· ${Math.min(cap, b.lines.length)}`) : b.summary }))
      .map(b => {
        if (b.key === '#hint') return hintEl()
        const [title = b.key, source = ''] = b.summary.split('\t')
        const roadmap = /^ROADMAP/.test(title)
        let rows: JSX.Element[]
        if (b.key === 'GOAL' && m.goal) rows = m.goal.groups.map((g, i) => goalRow(`g${i}`, `§${i + 1} ${g.name}`, g))
        else if (!b.lines.length) rows = /· —/.test(title) ? [] : [dash(`${b.key}-none`)]
        else
          rows = b.lines.map((l, i) => {
            const key = `${b.key}${i}`
            if (l === '—') return dash(key)
            const [left = '', right = ''] = l.split('\t')
            if (right) return sideRow(key, left, right)
            const mark = left.slice(0, 2)
            const tone = mark === '⚠ ' ? (roadmap ? RED : YELLOW) : mark === '▶ ' ? YELLOW : null
            if (tone)
              return (
                <Text key={key} wrap="truncate-end">
                  {'  '}
                  <Text color={tone}>{mark}</Text>
                  {cut(left.slice(2), W - 5)}
                </Text>
              )
            if (mark === '· ')
              return (
                <Text key={key} wrap="truncate-end">
                  <Text dimColor>{'  · '}</Text>
                  {cut(left.slice(2), W - 5)}
                </Text>
              )
            const sha = b.key === '最近提交' ? left.match(/^([0-9a-f]{7,}) (.*)$/) : null
            if (sha)
              return (
                <Text key={key} wrap="truncate-end">
                  {'  '}
                  <Text color={P_LIGHT}>{sha[1]}</Text>
                  {` ${cut(sha[2]!, W - 4 - sha[1]!.length)}`}
                </Text>
              )
            return <Text key={key} wrap="truncate-end">{`  ${cut(left, W - 3)}`}</Text>
          })
        return (
          <Box key={`b-${b.key}`} flexDirection="column">
            {titleRow(`${b.key}-h`, title, source)}
            {rows}
          </Box>
        )
      })

    return (
      <Box flexDirection="column" width={W}>
        {cardBlock ? cardEl : null}
        {whoEl}
        {bandEl}
        {blockEls}
      </Box>
    )
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    const [word = '', repo = ''] = e.args.trim().split(/\s+/)
    const h = await home($)
    if (SECTION_WORDS[word.toLowerCase()]) {
      const root = repo ? `${h}/repos/${repo}` : repoRoot(await $.session.cwd())
      if (repo && !(await exists($, root))) return { text: `board:没有 ~/repos/${repo}` }
      return { text: await fullSection($, root, word.toLowerCase()) }
    }
    const arg = word
    if (arg === 'all') return { text: await allBoards($, h) }
    if (arg === 'open') {
      const folded = repo !== 'all'
      await $.store.set(WANT_KEY, true)
      await $.store.set(FOLD_KEY, folded)
      await update($, foldAtom, () => ({ folded, chosen: true }))
      await refresh($)
      let r = await $.ui.open({ id: PANE, title: '进度', columns: PANE_COLUMNS })
      // 已经开着的 id 再 open 只改标题，不会换到前面(10.23 事件日志：别的面板后开就占住侧栏,/board open 后仍是它)。
      // owner 打了 /board open 就要看到 board:不在前面就关了重开，宿主让最新打开的那个占侧栏。
      const shown = async () => (await $.ui.panes().catch(() => null))?.find(p => p.id === PANE)?.isShown !== false
      if (r.isPlaced && !(await shown())) {
        await $.ui.close({ id: PANE }).catch(() => undefined)
        r = await $.ui.open({ id: PANE, title: '进度', columns: PANE_COLUMNS })
        await logLine($, `/board open: 原来在标签后面，关了重开 → isShown ${String(await shown())}`)
      }
      const wide = e.presentation.isFullscreen && e.presentation.columns >= PANE_MIN_COLUMNS
      return { text: r.isPlaced ? `board:侧栏已打开${wide ? '' : '(终端不是 ≥110 列全屏,会显示在输入框上方)'};clear 后自动重开,/board close 关` : 'board:侧栏没放上,终端变宽后再试' }
    }
    if (arg === 'close') {
      await $.store.set(WANT_KEY, false)
      await $.ui.close({ id: PANE }).catch(() => undefined)
      return { text: 'board:侧栏已关,不再自动打开' }
    }
    const here = repoRoot(await $.session.cwd())
    const root = arg ? `${h}/repos/${arg}` : here
    if (arg && !(await exists($, root))) return { text: `board:没有 ~/repos/${arg}` }
    return { text: await fullBoard($, root, root === here) }
  })
}
