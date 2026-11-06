// delegate: the lead's cockpit for omd-lite runs (docs/plan/2026-10-10-lead-harness.md, slice 4).
// A deterministic harness: it scans runs, guards launches, wakes the
// lead when runs end and cleans a merged run's worktree. It never slices work, writes briefs or
// picks executors (D-1).
import { atom, read, update } from 'claude-code'
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
  leadTouches,
  mentionsRuns,
  overlap,
  rewriteLaunches,
  runsTable,
  toDelegateRun,
  wakeText,
  looksLikeLaunch,
  RUN_NAMES,
  resolveNames,
  runsDirOf,
  launchLogDirOf,
  type BriefLintOpts,
  type RunNames,
  detachedArgv,
  nextLabel,
  resumeArgs,
  redispatchArgs,
  redispatchVerdict,
  redispatchLabel,
  type Orphan,
  type Launch,
  type RepoConfig,
  type ScanRun,
} from './logic'

type $ = EngineInterface

/** One wake per this window (D-21 ②). */
/** The runner CLI. `piw` is the new name; until `~/repos/omd-lite` is renamed only the old path exists (it stays as a symlink after). */
const DEFAULT_PIW = '/home/user/repos/piw/bin/piw'
const DEFAULT_OMD_LITE = '/home/user/repos/omd-lite/bin/omd-lite'
const WAKE_WINDOW_MS = 60_000
const DISK_CACHE_MS = 60_000
const CONFIG_CACHE_MS = 10_000
/** G-4: a failure that ended longer ago than this is not redispatched (a reload finding old news). */
const REDISPATCH_FRESH_MS = 2 * 3600 * 1000

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const dirname = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

// Module state, rebuilt by a scan after a reload; what must survive one is in $.store (WakeBook).
let cache: ScanRun[] = []
let sessionId = ''
/** Earlier session ids of this conversation: a /clear renames the session, runs launched before it keep the old id (G-1). */
let prior: string[] = []
const MAX_PRIOR = 4
/** A /clear is under way (session.end reason clear, or classic.SessionStart source clear): the next new id extends the lineage. */
let isClearing = false
let syncing: Promise<void> | null = null
let scanning: Promise<ScanRun[]> | null = null
/** G-5: `$.delegate.allRuns()` is built before any engine exists; session.start hands it the scan to run (a closure over its `$`). */
let scanEverySession: (() => Promise<ScanRun[]>) | null = null
let allCache: ScanRun[] = []
let allAt = -Infinity
let scanningAll: Promise<ScanRun[]> | null = null
/** A caller asking for every session's runs gets the last answer if it is this fresh (relay's /ops asks rarely; two asks must not scan twice). */
const ALL_TTL_MS = 2000
let windowTimer: { cancel: () => void } | null = null
/** S17: one wake in flight at a time, like `scanning`. */
let waking: Promise<void> | null = null
const diskCache = new Map<string, { at: number; usedKB: number; freeKB: number }>()
let configCache: { cwd: string; at: number; cfg: RepoConfig } | null = null
/** G-4: labels whose redispatch was tried in this load (won or lost): a poll every 2 s must not try the lock again. */
const redispatchTried = new Set<string>()

let opts = {
  launchSpacingSeconds: 10,
  diskBudgetGB: 40,
  minFreeGB: 50,
  /** Set only when the person configured it (`piwPath`, or the old `omdLitePath`); empty = pick by what exists (`cliPath`). */
  piwPath: '',
  redispatch: true,
  /** G-7: CLI names, runs dir, branch and worktree prefixes. */
  names: RUN_NAMES as RunNames,
}

/** The runner to call: the configured path, else `piw` if its directory has been renamed, else the old path. */
async function cliPath($: $): Promise<string> {
  if (opts.piwPath) return opts.piwPath
  try {
    return (await $.fs.exists(DEFAULT_PIW)) ? DEFAULT_PIW : DEFAULT_OMD_LITE
  } catch {
    return DEFAULT_OMD_LITE
  }
}

/** G-7: scan.mjs knows the default runs dir and CLI names; hand it only what the options override. */
async function scanArgv($: $, args: string[]) {
  const argv = ['node', `${$.plugin.root}/bin/scan.mjs`, ...args]
  if (opts.names.runsDir !== RUN_NAMES.runsDir) argv.push(runsDirOf((await $.env.get('HOME')) ?? '', opts.names))
  const env = opts.names.cliNames.join(',') === RUN_NAMES.cliNames.join(',') ? undefined : { DELEGATE_CLI_NAMES: opts.names.cliNames.join(',') }
  return { argv, init: { timeoutMs: 15_000, ...(env ? { env } : {}) } }
}

const launchLogDir = async ($: $) => launchLogDirOf((await $.env.get('HOME')) ?? '', opts.names)

// ── scanning and the wake ────────────────────────────────────────────────────────────

async function scan($: $): Promise<ScanRun[]> {
  await syncSession($)
  if (!sessionId) return cache
  const call = await scanArgv($, [[sessionId, ...prior].join(',')])
  const out = await $.process.run(call.argv, call.init)
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

/** G-5: every session's runs (`scan.mjs --all`), cached for ALL_TTL_MS. Never feeds the wake, the guard or the redispatch: those are this session's. */
function refreshAll($: $): Promise<ScanRun[]> {
  scanningAll ??= (async () => {
    try {
      const at = await $.clock.now()
      if (at - allAt < ALL_TTL_MS) return allCache
      const call = await scanArgv($, ['--all'])
      const out = await $.process.run(call.argv, call.init)
      const parsed: unknown = out.exitCode === 0 ? JSON.parse(out.stdout) : null
      if (Array.isArray(parsed)) allCache = parsed as ScanRun[]
      allAt = at
      return allCache
    } catch {
      return allCache
    } finally {
      scanningAll = null
    }
  })()
  return scanningAll
}

/** What the wake must remember across a reload, per session: `$.store` key `wake:<session id>`. */
type WakeBook = { known: Record<string, string>; pending: string[]; at: number; prior?: string[] }
const STALE_BOOK_MS = 2 * 24 * 3600 * 1000

async function readBook($: $): Promise<WakeBook | undefined> {
  return (await $.store.get(`wake:${sessionId}`)) as WakeBook | undefined
}

async function writeBook($: $, book: Omit<WakeBook, 'at' | 'prior'>) {
  await $.store.set(`wake:${sessionId}`, { ...book, prior, at: await $.clock.now() })
}

/**
 * G-1: /clear does not fire session.start, so the id read once there goes stale and runs started after the
 * clear carry a new one. Every scan (and the clear hooks) read `$.session.id()` again; when it changed, the
 * wake book moves to the new id and the old id stays in the lineage so runs launched before the clear still show.
 * An id that changed without a clear (another conversation resumed) starts a fresh lineage instead.
 */
function syncSession($: $, hint?: string): Promise<void> {
  syncing ??= (async () => {
    try {
      const id = hint || (await $.session.id().catch(() => ''))
      if (!id || id === sessionId) return
      const old = sessionId
      const oldPrior = prior
      sessionId = id
      if (old && isClearing) {
        prior = [old, ...oldPrior].filter(x => x !== id).slice(0, MAX_PRIOR)
        await moveBook($, old, id)
      } else {
        prior = ((await readBook($))?.prior ?? []).filter(x => x !== id)
      }
      isClearing = false
    } finally {
      syncing = null
    }
  })()
  return syncing
}

/** The wake book of the old id becomes the new id's (union with what the new one already holds). */
async function moveBook($: $, from: string, to: string) {
  const a = (await $.store.get(`wake:${from}`)) as WakeBook | undefined
  const b = (await $.store.get(`wake:${to}`)) as WakeBook | undefined
  if (!a) return
  await $.store.set(`wake:${to}`, {
    known: { ...a.known, ...(b?.known ?? {}) },
    pending: [...new Set([...a.pending, ...(b?.pending ?? [])])],
    prior,
    at: await $.clock.now(),
  })
  await $.store.delete(`wake:${from}`)
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

/**
 * S17: send the wake without anyone waiting for it. A submit made while a turn runs resolves only once the
 * session is idle (engine: "runs once it is idle"); awaited inside the refresh singleton it held judge's
 * refresh past the guard's 10 s budget (measured 18.10 02:44). Nothing on the refresh chain may await it.
 */
function kick($: $): void {
  waking ??= wake($)
    .catch(err => $.ui.toast(`delegate:叫醒出错:${err instanceof Error ? err.message : String(err)}`))
    .finally(() => { waking = null })
}

/** Runs seen running (or never seen) and now ended join the wake; the first scan only sets the baseline. */
async function noteEnded($: $, runs: ScanRun[]) {
  let book: WakeBook | undefined
  try {
    book = await readBook($)
  } catch {
    // Unreadable: neither the bookkeeping nor the note goes in. The run ends again on the next scan (宁重复不丢).
    $.ui.toast('delegate:叫醒账本读不到,这次不记也不发')
    return
  }
  const before = book?.known ?? {}
  const ended = book ? runs.filter(r => r.state !== 'running' && (before[r.label] === 'running' || before[r.label] === undefined)) : []
  // G-4: a run that failed on its provider is started again elsewhere; the lead hears only when the chain is used up.
  const handled = await redispatchFailed($, ended, runs)
  const waiting = [...new Set([...(book?.pending ?? []), ...ended.filter(r => !handled.has(r.label)).map(r => r.label)])]
  await writeBook($, { known: Object.fromEntries(runs.map(r => [r.label, r.state])), pending: waiting })
  if (!waiting.length) return
  // Nothing left running: no reason to hold the window open. S17: the send is kicked off, not awaited.
  if (!runs.some(r => r.state === 'running')) kick($)
  else windowTimer ??= $.clock.after(WAKE_WINDOW_MS, () => { windowTimer = null; kick($) })
}

/**
 * One message for every run that ended in the window (GWT-15). S17: pending is dropped only after the submit
 * landed, so a submit the engine refused (a /clear in flight) costs a later wake instead of the note.
 */
async function wake($: $) {
  windowTimer?.cancel()
  windowTimer = null
  let book: WakeBook | undefined
  try {
    book = await readBook($)
  } catch {
    // Nothing is sent and nothing is cleared: the next kick sends the same labels again.
    $.ui.toast('delegate:叫醒账本读不到,这次不发')
    return
  }
  if (!book?.pending.length) return
  const sent = book.pending
  const runs = sent.flatMap(l => cache.filter(r => r.label === l))
  // A label the scan cannot name (another session's, its run dir already gone): no empty note, pending stays.
  if (!runs.length) return
  await $.prompt.submit({ text: wakeText(runs) })
  // 宁重复不丢: a submit that rejects leaves pending as it was (kick's catch); here only this send's labels go,
  // and what ended while it was in flight stays for the next window.
  try {
    const after = await readBook($)
    await writeBook($, { known: after.known, pending: after.pending.filter(l => !sent.includes(l)) })
  } catch {
    $.ui.toast('delegate:叫醒账本写不回,可能重复叫醒一次')
  }
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

/**
 * The repo's sensitive-path globs (`cfg.sensitivePaths`, relative to `--repo`), same file shape as myapp's
 * scripts/dev/sensitive-paths.txt. Unset, unreadable or empty = the 安全面 check is off: the list is opt-in per
 * repo, and a missing list is not something to refuse a launch over.
 */
async function sensitiveGlobs($: $, repo: string, cfg: RepoConfig): Promise<string[]> {
  if (!cfg.sensitivePaths) return []
  try {
    const text = await $.fs.read(await resolvePath($, cfg.sensitivePaths, repo))
    return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  } catch {
    return []
  }
}

/**
 * The method cards the repo a run is dispatched against carries: the stem of every `docs/methods/*.yaml` there.
 * No directory, unreadable or no card = undefined, so briefGaps skips only the slug-existence check (the card's own
 * four lines and its 判官 are still judged). A repo with no cards is not something to refuse a launch over — the
 * same posture sensitiveGlobs takes for a missing path list.
 */
async function methodSlugs($: $, repo: string): Promise<string[] | undefined> {
  try {
    const out: string[] = []
    for (const e of await $.fs.list(`${repo}/docs/methods`)) {
      const m = /^(.+)\.ya?ml$/.exec(e.name)
      if (e.kind !== 'dir' && m) out.push(m[1] as string)
    }
    return out.length ? out : undefined
  } catch {
    return undefined
  }
}

async function diskUse($: $, parent: string) {
  const now = await $.clock.now()
  const hit = diskCache.get(parent)
  if (hit && now - hit.at < DISK_CACHE_MS) return hit
  const script = 'du -skc "$1"/"$2"* 2>/dev/null | tail -1 | cut -f1; df -Pk "$1" | tail -1 | awk \'{print $4}\''
  const out = await $.process.run(['sh', '-c', script, 'sh', parent, opts.names.wtPrefix], { timeoutMs: 120_000 })
  const [used = '0', free = '0'] = out.stdout.trim().split('\n')
  const row = { at: now, usedKB: Number(used) || 0, freeKB: Number(free) || 0 }
  diskCache.set(parent, row)
  return row
}

/** The executors omd-lite spawns by name; any other `--executor` value is not ours to check. */
const EXECUTOR_BIN: Record<string, string> = { pi: 'pi', mcode: 'mcode', claude: 'claude' }

/**
 * G-2: is the executor's binary there? 7 days of runs had 14 `spawn mcode ENOENT`, each a run set up, a worktree
 * made and nothing done. `pi` is also looked for where piw resolves it (PIW_PI_BIN, the fnm default alias), since
 * the hook's PATH may be a temporary fnm one. A fault in the check itself lets the launch through.
 */
async function hasExecutor($: $, name: string): Promise<boolean> {
  const bin = EXECUTOR_BIN[name]
  if (!bin) return true
  const script =
    'command -v "$1" >/dev/null 2>&1 && exit 0; ' +
    '[ "$1" = pi ] && { [ -n "$PIW_PI_BIN" ] && [ -x "$PIW_PI_BIN" ] && exit 0; [ -x "${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin/pi" ] && exit 0; }; exit 1'
  try {
    return (await $.process.run(['sh', '-c', script, 'sh', bin], { timeoutMs: 10_000 })).exitCode === 0
  } catch {
    return true
  }
}

/** Every reason a launch must not start; empty when it may. */
async function judge($: $, launches: Launch[], cwd: string, cfg: RepoConfig): Promise<string[]> {
  const problems: string[] = []
  const mine: { label: string; paths: string[] }[] = []
  for (const l of launches) {
    const label = l.name ?? '(无 --name)'
    if (l.kind === 'omd-lite') {
      const executor = l.executor ?? cfg.executor ?? 'pi'
      if (!(await hasExecutor($, executor))) {
        problems.push(`${label}:执行器 ${executor} 不在(command -v ${EXECUTOR_BIN[executor]} 找不到),启动会 spawn ENOENT 白跑一个 worktree;先装好,或 --executor 换一个`)
      }
    }
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
    const brief: BriefLintOpts = {}
    if (cfg.briefDeny?.length) brief.deny = cfg.briefDeny
    if (cfg.externalActions?.length) brief.externalActions = cfg.externalActions
    const globs = await sensitiveGlobs($, repo, cfg)
    if (globs.length) brief.sensitive = globs
    const methods = await methodSlugs($, repo)
    if (methods) brief.methods = methods
    for (const gap of briefGaps(text, brief)) problems.push(`${label}:任务书${gap}(C-1b)`)
    const paths = allowedPaths(text) ?? []
    for (const p of paths) {
      if (p.isNew || isTestPath(p.path)) continue
      // $.fs.exists 对会话目录以外的路径一律 false(20.10 从 myapp 会话起 otherapp 片,已在的 format.ts 被判不存在);存在性问 test -e
      // 基线是分支时，文件可能只在那条分支上(24.10 mr3 基线 lead/mg-integ):先问基线 ref,再问工作树
      const atBase = l.base ? (await $.process.run(['git', '-C', repo, 'cat-file', '-e', `${l.base}:${p.path.replace(/^\.\//, '')}`], { timeoutMs: 5000 })).exitCode === 0 : false
      if (!atBase && (await $.process.run(['test', '-e', await resolvePath($, p.path, repo)], { timeoutMs: 5000 })).exitCode !== 0) problems.push(`${label}:「允许改动」里的 ${p.path} 不存在,也没标(新建)`)
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
  // A short gap is not a refusal any more (D1 · 18.10): the caller waits out the rest of it before the head; two runs
  // in one command still are, because a sleep cannot order them.
  const spacing = opts.launchSpacingSeconds
  if (spacing > 0 && launches.length > 1) problems.push(`一条命令起了 ${launches.length} 个 run:分开起,间隔 ≥ ${spacing} s`)

  // GWT-13 / D-17 ③: the disk budget.
  const repos = new Set<string>()
  for (const l of launches) repos.add(dirname(await resolvePath($, l.repo ?? '.', cwd)))
  for (const parent of repos) {
    const d = await diskUse($, parent)
    const usedGB = d.usedKB / 1048576
    const freeGB = d.freeKB / 1048576
    if (usedGB > opts.diskBudgetGB) {
      problems.push(`${parent}/${opts.names.wtPrefix}* worktree 共 ${usedGB.toFixed(1)} GB,超预算 ${opts.diskBudgetGB} GB:先合并收尾,再 omd-lite gc --apply(或 omd-lite clean <label>)`)
    }
    if (freeGB < opts.minFreeGB) problems.push(`盘余 ${freeGB.toFixed(1)} GB < ${opts.minFreeGB} GB:先 omd-lite gc --apply 清 worktree`)
  }
  return problems
}

/**
 * GWT-9: the seconds a launch still has to wait out before its head (0 = it may start now). D1 · 18.10: the caller
 * prefixes `sleep N; ` to the command and records the launch at now + N, so a short gap costs the launch a wait
 * instead of a refusal. No `lastLaunchAt` (or none to parse) = nothing to space against, so no wait.
 */
async function spacingWait($: $, spacing: number): Promise<number> {
  if (spacing <= 0) return 0
  const last = Number((await $.store.get('lastLaunchAt')) ?? 0)
  if (!last) return 0
  const ago = ((await $.clock.now()) - last) / 1000
  return ago >= spacing ? 0 : Math.ceil(spacing - ago)
}

/** G-8: where a launch without setsid / nohup is sent to log; null when the dir cannot be made (then it is not rewritten). */
async function detachTo($: $): Promise<{ logDir: string } | undefined> {
  const logDir = await launchLogDir($)
  try {
    // Beside runs/, not in it: omd-lite refuses a run dir that already exists.
    return (await $.process.run(['mkdir', '-p', logDir], { timeoutMs: 5000 })).exitCode === 0 ? { logDir } : undefined
  } catch {
    return undefined
  }
}

// ── dead runs (G-3) ──────────────────────────────────────────────────────────────────

/**
 * Dead runs the person has not dismissed or resumed yet; the band above the prompt draws from it. A PluginState atom,
 * so resuming or dismissing redraws the band at once.
 */
const deadRuns = atom({ plugin: 'delegate', key: 'orphans' } as const, [] as Orphan[])

/** Every session's runs that died with no result and whose worktree is still there, newest first. */
async function listOrphans($: $): Promise<Orphan[]> {
  const call = await scanArgv($, ['--orphans'])
  const out = await $.process.run(call.argv, call.init)
  if (out.exitCode !== 0) return []
  try {
    return JSON.parse(out.stdout) as Orphan[]
  } catch {
    return []
  }
}

/**
 * Starts a dead run again: `<cli> run … --name <label>-r2 --reuse-worktree <its worktree>` through D-SPAWN (setsid -f,
 * stdio off the hook, log beside runs/). Returns what to tell the person.
 */
async function resumeOrphan($: $, o: Orphan): Promise<string> {
  const args = resumeArgs(o)
  if (!args) return `${o.label}:run 留下的信息不够续跑(缺 repo / base / spec / 闸 / 模型),请手动起`
  const name = nextLabel(o.label)
  const log = `${await launchLogDir($)}/${name}.log`
  const out = await $.process.run(detachedArgv([await cliPath($), ...args]), {
    timeoutMs: 5000,
    // The new run files itself under this conversation, so the wake and /runs see it.
    env: { LOG: log, ...(sessionId ? { CLAUDE_CODE_SESSION_ID: sessionId } : {}) },
  })
  if (out.exitCode !== 0) return `${o.label}:续跑没起来(exit ${out.exitCode}):${out.stderr.slice(0, 200)}`
  await $.store.set('lastLaunchAt', await $.clock.now())
  return `${o.label}:已在原 worktree 续跑为 ${name}(日志 ${log})`
}

// ── provider failure: once more on another provider (G-4) ──────────────────────────────

/**
 * Runs that just ended on a pure provider failure (piw's `failureClass` quota / stream, never a gate failure) are
 * started again once: `<cli> run --role worker --skip-coord <each failed coordinate> --name <label>-p2` through D-SPAWN.
 * The lock is `mkdir <run dir>/.redispatch.lock` (atomic; `$.store` has no compare-and-set and two loads of delegate
 * would race on it): whoever makes it dispatches, a non-zero exit means someone already has. Only the session that
 * launched the run dispatches. Returns the labels the lead need not hear about now (their `-p2` will report).
 */
async function redispatchFailed($: $, ended: ScanRun[], all: ScanRun[]): Promise<Set<string>> {
  const handled = new Set<string>()
  if (!opts.redispatch) return handled
  const now = await $.clock.now()
  const mine = new Set([sessionId, ...prior].filter(Boolean))
  for (const r of ended) {
    if (!redispatchVerdict(r).ok) continue
    if (!r.claudeSession || !mine.has(r.claudeSession)) continue
    if (now - (r.endedAt ?? now) > REDISPATCH_FRESH_MS) continue
    const name = redispatchLabel(r.label)
    // Already out (an earlier load of this session got the lock and started it): its end is what the lead hears.
    if (all.some(x => x.label === name)) {
      handled.add(r.label)
      continue
    }
    if (redispatchTried.has(r.label)) continue
    redispatchTried.add(r.label)
    try {
      const note = await dispatchAgain($, r, name)
      if (note.started) handled.add(r.label)
      $.ui.toast(note.text)
    } catch {
      // a fault here must not cost the wake: the lead is told as for any other end
    }
  }
  return handled
}

async function dispatchAgain($: $, r: ScanRun, name: string): Promise<{ started: boolean; text: string }> {
  const args = redispatchArgs(r)
  if (!args) return { started: false, text: `${r.label}:provider 失败,但 run 留下的信息不够重派,请手动换 provider 重跑` }
  const lock = await $.process.run(['mkdir', `${r.runDir}/.redispatch.lock`], { timeoutMs: 5000 })
  // Held already: another load of this session is dispatching it (its -p2 will wake the lead), or it was dispatched once before.
  if (lock.exitCode !== 0) return { started: true, text: `${r.label}:已有人在重派(${r.runDir}/.redispatch.lock),本次不派` }
  const log = `${await launchLogDir($)}/${name}.log`
  const out = await $.process.run(detachedArgv([await cliPath($), ...args]), {
    timeoutMs: 5000,
    env: { LOG: log, ...(sessionId ? { CLAUDE_CODE_SESSION_ID: sessionId } : {}) },
  })
  if (out.exitCode !== 0) return { started: false, text: `${r.label}:provider 失败,自动重派没起来(exit ${out.exitCode}):${out.stderr.slice(0, 200)}` }
  await $.store.set('lastLaunchAt', await $.clock.now())
  return { started: true, text: `${r.label}:provider 失败(${r.piwFailure}),已自动重派一次为 ${name}(跳过 ${r.failedCoords?.join(' ')};日志 ${log})` }
}

// ── after a merge (D-17 ②) ───────────────────────────────────────────────────────────

const REGEN = /(^|\/)(node_modules|\.next|\.venv[^/]*|\.turbo|\.cache|coverage|__pycache__|\.expo|dist|\.vitest|\.pytest_cache)(\/|$)|\.tsbuildinfo$/

async function cleanMerged($: $, label: string, cwd: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  let meta: { repo?: string; worktree?: string; branch?: string }
  try {
    meta = JSON.parse(await $.fs.read(`${runsDirOf(home, opts.names)}/${label}/meta.json`)) as typeof meta
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
  const out = await $.process.run([await cliPath($), 'clean', label], { timeoutMs: 120_000 })
  return out.exitCode === 0
    ? `${label}:已合并,omd-lite clean 删了 worktree ${worktree} 与分支 ${branch}`
    : `${label}:omd-lite clean 失败(exit ${out.exitCode}):${out.stderr.slice(0, 200)}`
}

// ── D-18:批合并后的组合片闸、独占量测前的全量 ─────────────────────────────────────

/** 这批的账:批前 sha 与已合并的片;组合片闸绿了就删。按仓库目录分开。 */
type Batch = { base: string; labels: string[]; at: number }

/** actor:lead 事件经 bin/events.mjs(factory 的逐字副本)追加:hooks 模块碰不了 node:fs,而 $.fs 只有整份写，别的写者并发追加时会丢行。 */
async function leadEvents($: $, events: object[]): Promise<void> {
  const src = `import { appendEvent } from ${JSON.stringify(`${$.plugin.root}/bin/events.mjs`)}; for (const e of JSON.parse(process.argv[1])) appendEvent(e)`
  await $.process.run(['node', '--input-type=module', '-e', src, JSON.stringify(events)], { timeoutMs: 5_000 }).catch(() => undefined)
}

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
    ? `delegate 拦下独占量测:当前 HEAD ${sha} 还没有全量结果(${file})。D-18:独占量测前先在 main 跑一次全量 13 闸,全绿再量。`
    : `delegate 拦下独占量测:HEAD ${sha} 的全量没有全绿(${v.red.join(' ')} 红,共 ${v.count} 道)。先修,红的那道重跑绿了再量。`
}

/** relay's handoff state (relay/types: Handoff); null when relay is not installed or unreadable. */
async function relayHandoff($: $): Promise<{ phase: string; path: string } | null> {
  try {
    const { value } = await $.state.get({ plugin: 'relay', key: 'handoff' } as const)
    return (value as { phase: string; path: string } | undefined) ?? null
  } catch {
    return null
  }
}

export const register: Register = (on, options) => {
  opts = {
    launchSpacingSeconds: num(options.launchSpacingSeconds, 10),
    diskBudgetGB: num(options.diskBudgetGB, 40),
    minFreeGB: num(options.minFreeGB, 50),
    // `omdLitePath` is the pre-rename key, still read (G-6/G-7); `piwPath` wins.
    piwPath: [options.piwPath, options.omdLitePath].find((v): v is string => typeof v === 'string' && v !== '') ?? '',
    redispatch: options.redispatch !== false,
    names: resolveNames(options),
  }

  // C-0: `$.delegate.runs()`, answered from the last scan (2 s old at most while a run is live).
  on('engine.create', async (_, e, next) => {
    const built = await next(e)
    return {
      ...built,
      delegate: {
        runs: async () => cache.map(toDelegateRun),
        // G-5: before session.start there is nothing to scan with: nothing to report yet.
        allRuns: async () => (scanEverySession ? (await scanEverySession()).map(toDelegateRun) : []),
      },
    }
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    scanEverySession = () => refreshAll($)
    allCache = []
    allAt = -Infinity
    await $.command.register({ name: 'runs', description: 'omd-lite runs launched from this session, with state (read-only)' })
    await syncSession($)
    await pruneBooks($)
    let ticks = 0
    // Every 2 s while a run is live, every 10 s otherwise.
    $.clock.every(2000, () => {
      ticks += 1
      if (cache.some(r => r.state === 'running') || ticks % 5 === 0) refresh($).catch(() => undefined)
    })
    await refresh($)
    // S17: a book left pending by a refused submit goes out now.
    kick($)
    // G-3: dead runs from any session, offered above the prompt (band.tsx). A fault here must not fail the start.
    try {
      const found = await listOrphans($)
      await update($, deadRuns, () => found)
    } catch {
      // no band this time
    }
    return started
  })

  // G-1: /clear fires no session.start. Both hooks below only re-read the id and move the wake book;
  // every scan does the same, so a missed event costs at most one poll.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      if (!sessionId) sessionId = e.sessionId
      isClearing = true
      await syncSession($).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      isClearing = true
      await syncSession($, e.session_id).catch(() => undefined)
      refresh($).then(() => kick($)).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'runs' }, async $ => {
    const runs = await refresh($)
    return { text: runsTable(runs, await $.clock.now()) }
  })

  // G-3: the dead runs above the prompt, a resume button each. (Built with h(): this module is .ts, $ never crosses a file.)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    const dead = await read($, deadRuns)
    if (('hasSurvey' in e.props && e.props.hasSurvey) || !dead.length) return theirs

    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = dead.slice(0, 3)
    const resume = (label: string) => async () => {
      const o = dead.find(x => x.label === label)
      if (!o) return
      const note = await resumeOrphan($, o)
      await update($, deadRuns, list => list.filter(x => x.label !== label))
      $.ui.toast(note)
    }
    const head = `delegate · ${dead.length} 个 run 断了(driver 已死、没有 result、worktree 还在)${dead.length > shown.length ? `,先列 ${shown.length} 个` : ''}`
    const mine = h(
      Box,
      { key: 'delegate-orphans', flexDirection: 'column' },
      h(Text, { dimColor: true }, head),
      ...shown.map(o => h(Button, { key: `resume-${o.label}`, plain: true, onPress: resume(o.label) }, `续跑 ${o.label} → ${nextLabel(o.label)} `, h(Text, { dimColor: true }, o.spec))),
      h(Button, { key: 'orphans-dismiss', plain: true, label: '忽略', onPress: async () => { await update($, deadRuns, () => []); $.ui.toast('delegate:已忽略断档 run 提示') } }),
    )
    return theirs ? h(Box, { flexDirection: 'column' }, theirs, mine) : mine
  })

  // The handoff gate (owner 10.11): relay /clears only once no subagent is out, so a dispatch after
  // the handoff began keeps the clear waiting. Refuse new ones; the ones already out still return.
  // Relay not installed / unreadable → no gate.
  for (const tool of ['Agent', 'Workflow', 'SendMessage'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const h = await relayHandoff($)
      if (h?.phase !== 'armed' && h?.phase !== 'ready') return next(e)
      return {
        deny:
          `delegate:relay 已开始交接(${h.phase}),不再派新的子 agent / Workflow / SendMessage —— 它们会让自动 /clear 一直等。` +
          `在跑的照常收;收完把结果并进交接 ${h.path},最后一行单独写 HANDOFF-READY。新的派遣留给清空后的 session。`,
      }
      // A fault in the gate itself must not stop every dispatch.
    }).catch(($, e, next) => next(e))
  }

  // The launch guard (INV-7, INV-11, C-1b), the gate rewrite (C-5), the clean-up after a merge.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = String(e.command ?? '')
    const { cwd, cfg } = await repoConfig($)
    // `--dry-run` only prints the plan: it neither starts a run nor needs a brief, a slot or disk, so it is not a launch.
    const launches = findLaunches(cmd, cfg, opts.names).filter(l => !l.dryRun)
    const merges = findMerges(cmd, cfg, opts.names)
    const batchKey = `batch:${cwd}`
    const batch = (await $.store.get(batchKey)) as Batch | undefined
    const measuring = isMeasure(cmd, cfg.measure)
    const combined = batch !== undefined && runsSliceGate(cmd, cfg.sliceGate ?? '', batch.base)
    const touches = leadTouches(cmd, cfg, opts.names)
    if (!launches.length && !merges.length && !touches.length && !mentionsRuns(cmd, opts.names) && !measuring && !combined) return next(e)

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
      const problems = await judge($, launches, cwd, cfg)
      if (problems.length) return { deny: `delegate 拒绝启动 omd-lite run:\n- ${problems.join('\n- ')}\n补法:从被执行仓 docs/methods/<slug>.yaml 抄四行进任务书;普通片可写一行「借的方法:豁免 -- <理由>」` }
      // D1:不足的那段间隔补在命令前面(`sleep N; `),起片照常;lastLaunchAt 记成 now + N,下一次从真起片那刻起算。
      const wait = await spacingWait($, opts.launchSpacingSeconds)
      await $.store.set('lastLaunchAt', (await $.clock.now()) + wait * 1000)
      const rewritten = rewriteLaunches(cmd, launches, cfg, launches.some(l => l.kind === 'omd-lite' && !l.detached && !l.isPiped) ? await detachTo($) : undefined)
      call = { ...e, command: wait > 0 ? `sleep ${wait}; ${rewritten}` : rewritten }
    }

    const ran = await next(call)
    if (ran.deny === undefined && touches.length) await leadEvents($, touches.map(t => ({ repo: cwd, run: t.run, phase: t.phase, status: ran.isError ? 'fail' : t.phase === 'launch' ? 'dispatch' : 'pass', actor: 'lead', evidence: cmd.slice(0, 200) })))
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
    const isLaunch = looksLikeLaunch(String(e.command ?? ''), opts.names)
    if (next.error.kind === 're-entry') return isLaunch ? { deny: 'delegate: 守卫重入,拒绝启动' } : next(e)
    return next.called ? next(e) : isLaunch ? { deny: `delegate: 守卫出错(${next.error.kind}),拒绝启动` } : next(e)
  })
}
