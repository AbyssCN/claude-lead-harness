import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BoardSection, PaneModel } from '../types'
import { age, barCells, byVersionDesc, checklistGroups, fitCells, render, renderFull, roadmapLayers, short } from './parse'

// Built-in layouts (SDD D-3), picked by which file a repo has; `.claude/board.json` overrides.
const PRESETS: ReadonlyArray<{ probe: string; sections: BoardSection[] }> = [
  {
    // next-md layout: _NEXT.md at the root, versioned docs/plan/<ver>/GOAL.md, DECISIONS-PENDING / TODO, docs/ROADMAP.md table.
    probe: '_NEXT.md',
    sections: [
      { kind: 'list', label: '下一步', file: '_NEXT.md', heading: '^## 现在', after: '^\\*\\*下一步\\*\\*', stamp: '^最近更新[:：](.*)$' },
      { kind: 'checklist', label: 'GOAL', file: 'docs/plan/*/GOAL.md', group: '###', titles: true },
      { kind: 'pending', label: '待拍板', file: 'docs/plan/DECISIONS-PENDING.md' },
      { kind: 'checklist', label: 'TODO', file: 'docs/plan/TODO.md', group: '##' },
      { kind: 'table', label: 'ROADMAP', file: 'docs/ROADMAP.md', show: '^(进行中|已排|待(?!核))', count: '^(候选|待核)' },
    ],
  },
  {
    // status-next layout: docs/status/NEXT.md plus a docs/ops/roadmap.md with 现在 / 接下来 status tables
    // and a numbered「待 <owner>」section.
    probe: 'docs/status/NEXT.md',
    sections: [
      { kind: 'list', label: '下一步', file: 'docs/status/NEXT.md', heading: '^## ▶️ 下一步', stamp: '^## 🧭 现状[(（]([^)）]+)' },
      { kind: 'list', label: '待拍板(roadmap)', file: 'docs/ops/roadmap.md', heading: '^## \\d+\\. 待' },
      { kind: 'list', label: 'NEXT 里的待办 / 待裁', file: 'docs/status/NEXT.md', heading: '^## 🙋', countOnly: true },
      { kind: 'table', label: 'ROADMAP 现在 + 接下来', file: 'docs/ops/roadmap.md', heading: '^### (现在|接下来)', show: '^(At Risk|Blocked|On Track|Not Started)', count: '^(Done)', alert: 'At Risk|Blocked' },
    ],
  },
]

const PANE = 'board'
const PANE_MIN_COLUMNS = 110
const TICK_MS = 60_000
// Wanted across sessions (a /clear starts a new one): set by /board open, cleared by /board close.
const WANT_KEY = 'paneOpen'
const model = atom({ plugin: 'board', key: 'model' } as const, null)
const at = atom({ plugin: 'board', key: 'at' } as const, 0)
// Which sidebar blocks are expanded, by key; the GOAL sections and running items always show.
const open = atom({ plugin: 'board', key: 'open' } as const, {})

// userConfig reposDir (`~/` allowed), default ~/repos: where `/board <name>` and `/board all` look.
let reposDirOption = ''

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME').catch(() => undefined)) || '.'
}

async function reposDir($: EngineInterface): Promise<string> {
  const p = reposDirOption
  if (p === '~' || p.startsWith('~/')) return `${await home($)}${p.slice(1)}`
  return p || `${await home($)}/repos`
}

// The repo the session is in: <reposDir>/<name> when cwd is under reposDir, else cwd itself.
async function repoRoot($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const rd = await reposDir($)
  if (!cwd.startsWith(`${rd}/`)) return cwd
  return `${rd}/${cwd.slice(rd.length + 1).split('/')[0]}`
}

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

// Absent noun (delegate not installed): the call throws, caught here.
async function delegateRuns($: EngineInterface): Promise<Array<{ label: string; state: string; executor?: string }> | null> {
  try {
    const runs = await $.delegate!.runs()
    return Array.isArray(runs) ? runs : null
  } catch {
    return null
  }
}

async function header($: EngineInterface, root: string): Promise<string> {
  const branch = await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = await git($, root, ['rev-parse', '--short', 'HEAD'])
  return `${root.split('/').pop()} · ${branch || '?'} ${head}`
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

async function allBoards($: EngineInterface, rd: string): Promise<string> {
  const out: string[] = []
  for (const d of await $.fs.list(rd).catch(() => [])) {
    if (d.kind !== 'dir') continue
    const root = `${rd}/${d.name}`
    // Main checkouts only: a worktree's .git is a file.
    if ((await $.fs.stat(`${root}/.git`).catch(() => null))?.kind !== 'dir') continue
    const sections = await sectionsOf($, root)
    if (!sections) continue
    out.push(await header($, root), ...(await board($, root, sections, true)), '')
  }
  return out.join('\n').trim() || `board:${rd} 下没有带进度文件的仓`
}

// The sidebar's model for the repo this session works in.
async function buildModel($: EngineInterface, root: string): Promise<PaneModel | null> {
  const sections = await sectionsOf($, root)
  if (!sections) return null
  const m: PaneModel = { title: await header($, root), goal: null, running: [], blocks: [], roadmap: [] }
  for (const s of sections) {
    const f = await resolveFile($, root, s.file)
    const md = f ? await readText($, f.path) : null
    if (!f || md === null) {
      m.blocks.push({ key: s.label, summary: `${s.label}:读不到`, lines: [s.file] })
      continue
    }
    if (s.kind === 'checklist' && s.titles && !m.goal) {
      const groups = checklistGroups(md, s.group)
      m.goal = {
        tag: `${s.label}${f.tag}`,
        groups: groups.map(g => ({ name: g.name, done: g.done, running: g.running.length, planned: g.planned.length })),
      }
      m.running = groups.flatMap(g => g.running)
      continue
    }
    if (s.kind === 'table') m.roadmap = roadmapLayers(md)
    const r = render({ ...s, label: `${s.label}${f.tag}` }, md)
    const st = await $.fs.stat(f.path).catch(() => null)
    const full = s.kind === 'table' ? r.detail : renderFull(s, md).filter(Boolean)
    m.blocks.push({ key: s.label, summary: `${r.summary}${st ? ` · ${age(Date.now() - st.mtimeMs)}` : ''}`, lines: full.slice(0, 15) })
  }
  const runs = await delegateRuns($)
  const live = (runs ?? []).filter(r => r.state === 'running')
  if (runs) m.blocks.push({ key: '在跑的片', summary: `在跑的片 ${live.length}`, lines: live.map(r => `${r.label}${r.executor ? `(${r.executor})` : ''}`) })
  const log = await git($, root, ['log', '-5', '--format=%h %s'])
  if (log) m.blocks.push({ key: '最近提交', summary: '最近提交', lines: log.split('\n') })
  return m
}

async function refresh($: EngineInterface): Promise<void> {
  const m = await buildModel($, await repoRoot($))
  await update($, model, () => m)
  await update($, at, () => Date.now())
}

export const register: Register = (on, options) => {
  reposDirOption = String(options.reposDir ?? '').trim()
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'board',
      description: '进度板:下一步 · GOAL 进行中 / 规划中 · 待拍板 · TODO · roadmap · 最近提交(纯读文件);open / close 开关侧栏',
      argumentHint: '[仓名|all|open|close|roadmap|goal|todo|next|待拍板 [仓名]]',
    })
    $.clock.every(TICK_MS, () => void refresh($).catch(() => undefined))
    // Re-open the sidebar a /clear or restart closed, if the user asked for it.
    if (await $.store.get(WANT_KEY).catch(() => false)) {
      void refresh($)
        .then(() => $.ui.open({ id: PANE, title: '进度' }))
        .catch(() => undefined)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) void refresh($).catch(() => undefined)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, model)
    const expanded = await read($, open)
    const updated = await read($, at)
    const W = Math.max(30, e.props.bodyColumns)
    if (!m) return <Text dimColor>board:这个仓没有可读的进度文件</Text>

    // A row: fixed-width label, a done / running / planned bar, a count.
    const LABEL = Math.min(14, Math.floor(W / 3))
    const COUNT = 7
    const barRow = (key: string, name: string, t: { done: number; running: number; planned: number }) => {
      const b = barCells(t, Math.max(6, W - LABEL - COUNT - 3))
      return (
        <Text key={key} wrap="truncate-end">
          {' ' + fitCells(name, LABEL) + ' '}
          <Text color="success">{'█'.repeat(b.done)}</Text>
          <Text color="warning">{'█'.repeat(b.running)}</Text>
          <Text dimColor>{'░'.repeat(b.planned)}</Text>
          <Text dimColor>{' ' + `${t.done}/${t.done + t.running + t.planned}`.padStart(COUNT - 1)}</Text>
        </Text>
      )
    }
    const toggle = (key: string) => async () => {
      await update($, open, o => ({ ...o, [key]: !o[key] }))
    }
    const sum = m.goal?.groups.reduce((a, g) => ({ done: a.done + g.done, running: a.running + g.running, planned: a.planned + g.planned }), { done: 0, running: 0, planned: 0 })
    const pct = sum ? Math.round((sum.done / Math.max(1, sum.done + sum.running + sum.planned)) * 100) : 0
    const time = updated ? new Date(updated).toTimeString().slice(0, 5) : '—'

    return (
      <Box flexDirection="column" width={W}>
        <Box borderStyle="round" borderColor="claude" flexDirection="column" paddingX={1}>
          <Text wrap="truncate-end">
            <Text bold>{m.title}</Text>
            <Text dimColor>{'  ' + time}</Text>
          </Text>
          {m.goal && sum ? (
            <Text wrap="truncate-end">
              <Text bold>{`${m.goal.tag}  ${sum.done}/${sum.done + sum.running + sum.planned}  `}</Text>
              <Text color="success">{`完成 ${pct}%`}</Text>
              <Text color="warning">{`  进行中 ${sum.running}`}</Text>
              <Text dimColor>{`  规划中 ${sum.planned}`}</Text>
            </Text>
          ) : null}
        </Box>

        {m.running.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="warning">{` ▶ 进行中 (${m.running.length})`}</Text>
            {m.running.map((r, i) => (
              <Box key={`run${i}`} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color="warning">{' ┃ '}</Text>
                  <Text bold>{r.title}</Text>
                </Text>
                {r.runs ? (
                  <Text wrap="truncate-end">
                    <Text color="warning">{' ┃ '}</Text>
                    <Text dimColor>{r.runs}</Text>
                  </Text>
                ) : null}
              </Box>
            ))}
          </Box>
        ) : null}

        {m.goal ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{' GOAL 各节'}</Text>
            {m.goal.groups.map((g, i) => barRow(`g${i}`, g.name.replace('/', ' '), g))}
          </Box>
        ) : null}

        {m.roadmap.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{' ROADMAP'}</Text>
            {m.roadmap.map((t, i) => barRow(`r${i}`, t.name, t))}
          </Box>
        ) : null}

        <Box flexDirection="column" marginTop={1}>
          {m.blocks.map(b => {
            const isOpen = !!expanded[b.key]
            return (
              <Box key={`b-${b.key}`} flexDirection="column">
                <Button plain label={b.summary} onPress={toggle(b.key)}>
                  <Text wrap="truncate-end">
                    <Text color="claude">{isOpen ? ' ▾ ' : ' ▸ '}</Text>
                    {fitCells(b.summary, W - 4).trimEnd()}
                  </Text>
                </Button>
                {isOpen
                  ? b.lines.map((l, i) => (
                      <Text key={`${b.key}${i}`} wrap="truncate-end" dimColor={!/^\s*▶/.test(l)} color={/^\s*▶/.test(l) ? 'warning' : undefined}>
                        {'   ' + l}
                      </Text>
                    ))
                  : null}
              </Box>
            )
          })}
        </Box>

        <Text dimColor wrap="truncate-end">
          {'\n '}
          <Text color="success">{'██'}</Text>
          {' 完成  '}
          <Text color="warning">{'██'}</Text>
          {' 进行中  '}
          {'░░ 规划中 · 点 ▸ 展开'}
        </Text>
      </Box>
    )
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    const [word = '', repo = ''] = e.args.trim().split(/\s+/)
    const rd = await reposDir($)
    if (SECTION_WORDS[word.toLowerCase()]) {
      const root = repo ? `${rd}/${repo}` : await repoRoot($)
      if (repo && !(await exists($, root))) return { text: `board:没有 ${rd}/${repo}` }
      return { text: await fullSection($, root, word.toLowerCase()) }
    }
    const arg = word
    if (arg === 'all') return { text: await allBoards($, rd) }
    if (arg === 'open') {
      await $.store.set(WANT_KEY, true)
      await refresh($)
      const r = await $.ui.open({ id: PANE, title: '进度' })
      const wide = e.presentation.isFullscreen && e.presentation.columns >= PANE_MIN_COLUMNS
      return { text: r.isPlaced ? `board:侧栏已打开${wide ? '' : '(终端不是 ≥110 列全屏,会显示在输入框上方)'};clear 后自动重开,/board close 关` : 'board:侧栏没放上,终端变宽后再试' }
    }
    if (arg === 'close') {
      await $.store.set(WANT_KEY, false)
      await $.ui.close({ id: PANE }).catch(() => undefined)
      return { text: 'board:侧栏已关,不再自动打开' }
    }
    const here = await repoRoot($)
    const root = arg ? `${rd}/${arg}` : here
    if (arg && !(await exists($, root))) return { text: `board:没有 ${rd}/${arg}` }
    return { text: await fullBoard($, root, root === here) }
  })
}
