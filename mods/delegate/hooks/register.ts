// delegate: the lead's cockpit for omd-lite runs (docs/plan/2026-10-10-lead-harness.md, slice 4).
// A deterministic harness: it scans runs, guards launches, wraps gates in gate-slot.sh, wakes the
// lead when runs end and cleans a merged run's worktree. It never slices work, writes briefs or
// picks executors (D-1).
import type { EngineInterface, Register } from 'claude-code'

import {
  briefGaps,
  allowedPaths,
  combinedGateNote,
  findLaunches,
  findMerges,
  fullGatesVerdict,
  isMeasure,
  runsSliceGate,
  isTestPath,
  mentionsRuns,
  overlap,
  rewriteLaunches,
  runsTable,
  toDelegateRun,
  wakeText,
  type Launch,
  type RepoConfig,
  type ScanRun,
} from './logic'

type $ = EngineInterface

/** One wake per this window (D-21 ②). */
const WAKE_WINDOW_MS = 60_000
const DISK_CACHE_MS = 60_000
const CONFIG_CACHE_MS = 10_000
// On PATH by default; userConfig omdLitePath may be absolute or ~/-relative.
const DEFAULT_OMD_LITE = 'omd-lite'

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const dirname = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

// Module state, rebuilt by a scan after a reload; what must survive one is in $.store (WakeBook).
let cache: ScanRun[] = []
let sessionId = ''
let scanning: Promise<ScanRun[]> | null = null
let windowTimer: { cancel: () => void } | null = null
const diskCache = new Map<string, { at: number; usedKB: number; freeKB: number }>()
let configCache: { cwd: string; at: number; cfg: RepoConfig } | null = null

let opts = {
  launchSpacingSeconds: 10,
  diskBudgetGB: 40,
  minFreeGB: 50,
  omdLitePath: DEFAULT_OMD_LITE,
}

// ── scanning and the wake ────────────────────────────────────────────────────────────

async function scan($: $): Promise<ScanRun[]> {
  if (!sessionId) return cache
  const out = await $.process.run(['node', `${$.plugin.root}/bin/scan.mjs`, sessionId], { timeoutMs: 15_000 })
  if (out.exitCode !== 0) return cache
  try {
    return JSON.parse(out.stdout) as ScanRun[]
  } catch {
    return cache
  }
}

/** One scan at a time; every caller gets the scan in flight. */
function refresh($: $): Promise<ScanRun[]> {
  scanning ??= (async () => {
    try {
      const runs = await scan($)
      cache = runs
      await noteEnded($, runs)
      return runs
    } finally {
      scanning = null
    }
  })()
  return scanning
}

/** What the wake must remember across a reload, per session: `$.store` key `wake:<session id>`. */
type WakeBook = { known: Record<string, string>; pending: string[]; at: number }
const STALE_BOOK_MS = 2 * 24 * 3600 * 1000

async function readBook($: $): Promise<WakeBook | undefined> {
  return (await $.store.get(`wake:${sessionId}`)) as WakeBook | undefined
}

async function writeBook($: $, book: Omit<WakeBook, 'at'>) {
  await $.store.set(`wake:${sessionId}`, { ...book, at: await $.clock.now() })
}

/** Other sessions' books untouched for two days. */
async function pruneBooks($: $) {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('wake:') || key === `wake:${sessionId}`) continue
    const book = (await $.store.get(key)) as WakeBook | undefined
    if (!book || now - book.at > STALE_BOOK_MS) await $.store.delete(key)
  }
}

/** Runs seen running (or never seen) and now ended join the wake; the first scan only sets the baseline. */
async function noteEnded($: $, runs: ScanRun[]) {
  const book = await readBook($)
  const before = book?.known ?? {}
  const ended = book ? runs.filter(r => r.state !== 'running' && (before[r.label] === 'running' || before[r.label] === undefined)) : []
  const waiting = [...new Set([...(book?.pending ?? []), ...ended.map(r => r.label)])]
  await writeBook($, { known: Object.fromEntries(runs.map(r => [r.label, r.state])), pending: waiting })
  if (!waiting.length) return
  // Nothing left running: no reason to hold the window open.
  if (!runs.some(r => r.state === 'running')) await wake($)
  else windowTimer ??= $.clock.after(WAKE_WINDOW_MS, () => void wake($).catch(() => undefined))
}

/** One message for every run that ended in the window (GWT-15). */
async function wake($: $) {
  windowTimer?.cancel()
  windowTimer = null
  const book = await readBook($)
  if (!book?.pending.length) return
  await writeBook($, { known: book.known, pending: [] })
  const runs = book.pending.flatMap(l => cache.filter(r => r.label === l))
  if (runs.length) await $.prompt.submit({ text: wakeText(runs) })
}

// ── the launch guard ─────────────────────────────────────────────────────────────────

async function repoConfig($: $): Promise<{ cwd: string; cfg: RepoConfig }> {
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  if (configCache && configCache.cwd === cwd && now - configCache.at < CONFIG_CACHE_MS) return configCache
  let cfg: RepoConfig = {}
  const file = `${cwd}/.claude/delegate.json`
  if (await $.fs.exists(file)) {
    try {
      cfg = JSON.parse(await $.fs.read(file)) as RepoConfig
    } catch {
      cfg = {}
    }
  }
  configCache = { cwd, at: now, cfg }
  return configCache
}

async function resolvePath($: $, p: string, cwd: string) {
  if (p.startsWith('~/')) return `${(await $.env.get('HOME')) ?? ''}/${p.slice(2)}`
  return p.startsWith('/') ? p : `${cwd}/${p}`
}

async function diskUse($: $, parent: string) {
  const now = await $.clock.now()
  const hit = diskCache.get(parent)
  if (hit && now - hit.at < DISK_CACHE_MS) return hit
  const script = 'du -skc "$1"/omdl-* 2>/dev/null | tail -1 | cut -f1; df -Pk "$1" | tail -1 | awk \'{print $4}\''
  const out = await $.process.run(['sh', '-c', script, 'sh', parent], { timeoutMs: 120_000 })
  const [used = '0', free = '0'] = out.stdout.trim().split('\n')
  const row = { at: now, usedKB: Number(used) || 0, freeKB: Number(free) || 0 }
  diskCache.set(parent, row)
  return row
}

/** Every reason a launch must not start; empty when it may. */
async function judge($: $, launches: Launch[], cwd: string): Promise<string[]> {
  const problems: string[] = []
  const mine: { label: string; paths: string[] }[] = []
  for (const l of launches) {
    const label = l.name ?? '(无 --name)'
    const repo = await resolvePath($, l.repo ?? '.', cwd)
    if (!l.spec) {
      problems.push(`${label}:没找到 --spec`)
      continue
    }
    const specPath = await resolvePath($, l.spec, repo)
    let text: string
    try {
      text = await $.fs.read(specPath)
    } catch {
      problems.push(`${label}:读不到任务书 ${specPath}`)
      continue
    }
    for (const gap of briefGaps(text)) problems.push(`${label}:任务书${gap}(C-1b)`)
    const paths = allowedPaths(text) ?? []
    for (const p of paths) {
      if (p.isNew || isTestPath(p.path)) continue
      if (!(await $.fs.exists(await resolvePath($, p.path, repo)))) problems.push(`${label}:「允许改动」里的 ${p.path} 不存在,也没标(新建)`)
    }
    mine.push({ label, paths: paths.map(p => p.path) })
  }

  // GWT-8: no two live runs may share a path they are allowed to change.
  const live = (await refresh($)).filter(r => r.state === 'running' && r.allowed?.length)
  for (const [k, m] of mine.entries()) {
    for (const r of live) {
      const shared = overlap(m.paths, r.allowed ?? [])
      if (shared.length) problems.push(`${m.label}:「允许改动」与在跑的 ${r.label} 重叠:${shared.join(' ')}`)
    }
    for (const other of mine.slice(k + 1)) {
      const shared = overlap(m.paths, other.paths)
      if (shared.length) problems.push(`${m.label}:「允许改动」与同一条命令里的 ${other.label} 重叠:${shared.join(' ')}`)
    }
  }

  // GWT-9: launches spaced (vt IPC socket, provider bursts). No concurrency cap (D-16).
  const spacing = opts.launchSpacingSeconds
  if (spacing > 0) {
    if (launches.length > 1) problems.push(`一条命令起了 ${launches.length} 个 run:分开起,间隔 ≥ ${spacing} s`)
    const last = Number((await $.store.get('lastLaunchAt')) ?? 0)
    const ago = ((await $.clock.now()) - last) / 1000
    if (last && ago < spacing) problems.push(`距上次 launch 仅 ${Math.floor(ago)} s,间隔须 ≥ ${spacing} s(launchSpacingSeconds),${Math.ceil(spacing - ago)} s 后再起`)
  }

  // GWT-13 / D-17 ③: the disk budget.
  const repos = new Set<string>()
  for (const l of launches) repos.add(dirname(await resolvePath($, l.repo ?? '.', cwd)))
  for (const parent of repos) {
    const d = await diskUse($, parent)
    const usedGB = d.usedKB / 1048576
    const freeGB = d.freeKB / 1048576
    if (usedGB > opts.diskBudgetGB) {
      problems.push(`${parent}/omdl-* worktree 共 ${usedGB.toFixed(1)} GB,超预算 ${opts.diskBudgetGB} GB:先合并收尾,再 omd-lite gc --apply(或 omd-lite clean <label>)`)
    }
    if (freeGB < opts.minFreeGB) problems.push(`盘余 ${freeGB.toFixed(1)} GB < ${opts.minFreeGB} GB:先 omd-lite gc --apply 清 worktree`)
  }
  return problems
}

// ── after a merge (D-17 ②) ───────────────────────────────────────────────────────────

const REGEN = /(^|\/)(node_modules|\.next|\.venv[^/]*|\.turbo|\.cache|coverage|__pycache__|\.expo|dist|\.vitest|\.pytest_cache)(\/|$)|\.tsbuildinfo$/

async function cleanMerged($: $, label: string, cwd: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  let meta: { repo?: string; worktree?: string; branch?: string }
  try {
    meta = JSON.parse(await $.fs.read(`${home}/.omd-lite/runs/${label}/meta.json`)) as typeof meta
  } catch {
    return `${label}:没有 run 记录,worktree 未动`
  }
  const { repo, worktree, branch } = meta
  if (!repo || !worktree || !branch) return `${label}:meta 缺 repo / worktree / branch,未动`
  if (!(await $.fs.exists(worktree))) return `${label}:worktree 已不在`
  const merged = await Promise.all(
    [cwd, repo].map(async dir => (await $.process.run(['git', '-C', dir, 'merge-base', '--is-ancestor', branch, 'HEAD'])).exitCode === 0),
  )
  if (!merged.some(Boolean)) return `${label}:${branch} 还不在 HEAD 里,worktree 未动`
  const status = await $.process.run(['git', '-C', worktree, 'status', '--porcelain', '--ignored'])
  const lines = status.stdout.split('\n').filter(Boolean)
  const dirty = lines.filter(l => !l.startsWith('!! '))
  const kept = lines.filter(l => l.startsWith('!! ')).map(l => l.slice(3)).filter(p => !REGEN.test(p))
  if (dirty.length) return `${label}:worktree 还有 ${dirty.length} 处未提交改动,未删(${worktree})`
  if (kept.length) return `${label}:worktree 有被忽略的非缓存文件(${kept.slice(0, 3).join(' ')}),未删`
  const bin = opts.omdLitePath.startsWith('~/') ? await resolvePath($, opts.omdLitePath, cwd) : opts.omdLitePath
  const out = await $.process.run([bin, 'clean', label], { timeoutMs: 120_000 })
  return out.exitCode === 0
    ? `${label}:已合并,omd-lite clean 删了 worktree ${worktree} 与分支 ${branch}`
    : `${label}:omd-lite clean 失败(exit ${out.exitCode}):${out.stderr.slice(0, 200)}`
}

// ── D-18:批合并后的组合片闸、独占量测前的全量 ─────────────────────────────────────

/** 这批的账:批前 sha 与已合并的片;组合片闸绿了就删。按仓库目录分开。 */
type Batch = { base: string; labels: string[]; at: number }

async function git($: $, cwd: string, ...args: string[]): Promise<string> {
  const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 15_000 })
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

/** 量测命令前:当前 HEAD 的 full-gates 汇总必须全绿,否则说明拦下的原因。 */
async function measureBlock($: $, cwd: string, cfg: RepoConfig): Promise<string | null> {
  if (!cfg.fullGatesSummary) return null
  const sha = await git($, cwd, 'rev-parse', '--short', 'HEAD')
  const file = cfg.fullGatesSummary.replace('{sha}', sha)
  let summary: string | null = null
  try {
    summary = await $.fs.read(file)
  } catch {
    summary = null
  }
  const v = fullGatesVerdict(summary)
  if (v.isGreen) return null
  return summary === null
    ? `delegate 拦下独占量测:当前 HEAD ${sha} 还没有全量结果(${file})。D-18:独占量测前先在 main 跑一次全量闸,全绿再量。`
    : `delegate 拦下独占量测:HEAD ${sha} 的全量没有全绿(${v.red.join(' ')} 红,共 ${v.count} 道)。先修,红的那道重跑绿了再量。`
}

export const register: Register = (on, options) => {
  opts = {
    launchSpacingSeconds: num(options.launchSpacingSeconds, 10),
    diskBudgetGB: num(options.diskBudgetGB, 40),
    minFreeGB: num(options.minFreeGB, 50),
    omdLitePath: typeof options.omdLitePath === 'string' && options.omdLitePath.trim() ? options.omdLitePath.trim() : DEFAULT_OMD_LITE,
  }

  // C-0: `$.delegate.runs()`, answered from the last scan (2 s old at most while a run is live).
  on('engine.create', async (_, e, next) => {
    const built = await next(e)
    return { ...built, delegate: { runs: async () => cache.map(toDelegateRun) } }
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'runs', description: 'omd-lite runs launched from this session, with state (read-only)' })
    sessionId = await $.session.id()
    await pruneBooks($)
    let ticks = 0
    // Every 2 s while a run is live, every 10 s otherwise.
    $.clock.every(2000, () => {
      ticks += 1
      if (cache.some(r => r.state === 'running') || ticks % 5 === 0) refresh($).catch(() => undefined)
    })
    await refresh($)
    return started
  })

  on('command.run', { command: 'runs' }, async $ => {
    const runs = await refresh($)
    return { text: runsTable(runs, await $.clock.now()) }
  })

  // The launch guard (INV-7, INV-11, C-1b), the gate rewrite (C-5), the clean-up after a merge.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = String(e.command ?? '')
    const { cwd, cfg } = await repoConfig($)
    const launches = findLaunches(cmd, cfg)
    const merges = findMerges(cmd, cfg)
    const batchKey = `batch:${cwd}`
    const batch = (await $.store.get(batchKey)) as Batch | undefined
    const measuring = isMeasure(cmd, cfg.measure)
    const combined = batch !== undefined && runsSliceGate(cmd, cfg.sliceGate ?? '', batch.base)
    if (!launches.length && !merges.length && !mentionsRuns(cmd) && !measuring && !combined) return next(e)

    if (measuring) {
      const block = await measureBlock($, cwd, cfg)
      if (block) return { deny: block }
      if (!launches.length && !merges.length) return next(e)
    }
    if (combined && !launches.length && !merges.length) {
      const done = await next(e)
      if (done.deny === undefined && !done.isError) {
        await $.store.delete(batchKey)
        return { ...done, context: [...(done.context ?? []), `delegate · 组合片闸已跑(批前 ${batch.base.slice(0, 9)}),这批 ${batch.labels.length} 片清账。以日志为准判红绿。`] }
      }
      return done
    }
    // 第一片合并前记下批前 sha(同一批后续的合并沿用)。
    const baseBefore = merges.length && cfg.sliceGate && !batch ? await git($, cwd, 'rev-parse', 'HEAD') : ''

    let call = e
    if (launches.length) {
      const problems = await judge($, launches, cwd)
      if (problems.length) return { deny: `delegate 拒绝启动 omd-lite run:\n- ${problems.join('\n- ')}` }
      await $.store.set('lastLaunchAt', await $.clock.now())
      call = { ...e, command: rewriteLaunches(cmd, launches, `${$.plugin.root}/bin/gate-slot.sh`, cfg) }
    }

    const ran = await next(call)
    refresh($).catch(() => undefined)
    if (launches.length) $.clock.after(3000, () => void refresh($).catch(() => undefined))

    const result = ran.result as { backgroundTaskId?: string } | undefined
    if (!merges.length || ran.deny !== undefined || ran.isError || result?.backgroundTaskId) return ran
    const notes: string[] = []
    for (const label of merges) notes.push(await cleanMerged($, label, cwd))
    $.ui.toast(notes.join(' · '))
    const context = [...(ran.context ?? []), `delegate 合并后清理:\n${notes.join('\n')}`]
    if (cfg.sliceGate) {
      const base = batch?.base ?? baseBefore
      if (base) {
        const nextBatch: Batch = { base, labels: [...new Set([...(batch?.labels ?? []), ...merges])], at: await $.clock.now() }
        await $.store.set(batchKey, nextBatch)
        const files = (await git($, cwd, 'diff', '--name-only', `${base}..HEAD`)).split('\n').filter(Boolean)
        context.push(combinedGateNote(base, nextBatch.labels, files, cfg))
      }
    }
    return { ...ran, context }
  }).catch(($, e, next) => {
    // A failure judging a launch refuses it; any other command goes on untouched.
    const isLaunch = /omd-lite\s+run\b|omdl-launch/.test(String(e.command ?? ''))
    if (next.error.kind === 're-entry') return isLaunch ? { deny: 'delegate: 守卫重入,拒绝启动' } : next(e)
    return next.called ? next(e) : isLaunch ? { deny: `delegate: 守卫出错(${next.error.kind}),拒绝启动` } : next(e)
  })
}
