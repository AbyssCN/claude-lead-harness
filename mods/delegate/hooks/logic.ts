// delegate's pure parts: reading a Bash command for launches and merges, the brief check (C-1b),
// path overlap (GWT-8), the gate rewrite (C-5) and the wake text (GWT-15 / INV-8). No `$` here.
import type { DelegateRun } from '../types/index'
// F1a: the brief parser itself lives in the factory (factory/lib/brief.mjs); this is its byte-identical copy,
// because a plugin installed under ~/.claude/plugins/cache cannot import across directories.
// `node factory/bin/brief-sync.mjs --check` is what keeps the two apart.
import { parseBrief } from './brief.mjs'

/** What bin/scan.mjs prints per run: the C-0 fields plus what the guard and the wake need. */
export type ScanRun = DelegateRun & {
  repo: string
  worktree: string
  branch: string
  spec: string
  allowed: string[] | null
  diffstat: string
  gateTail: string[]
  failedGate: string
  error: string
  /** The session that launched it (meta.claude_session). */
  claudeSession?: string
  /** piw's own failure class from meta.json / result.json (G-4): quota | auth | stream | request | gate. Not C-0's `failureClass`. */
  piwFailure?: string
  /** The coordinates piw saw fail, for `--skip-coord`. */
  failedCoords?: string[]
  /** How to start the same brief again; scan.mjs only attaches it to quota / stream failures. */
  launch?: Omit<Orphan, 'label' | 'startedAt'>
}

/** The repo's `.claude/delegate.json`; every field optional. */
export type RepoConfig = {
  launch?: string
  launchArgs?: string[]
  merge?: string
  gate?: string
  envFile?: string
  executor?: string
  model?: string
  fullGates?: string
  // D-18 三级闸门。sliceGate:片闸脚本(批合并后带批前 sha 跑一次 = 组合片闸);
  // layerGates:改动路径命中正则就要加跑的层闸;fullGatesSummary:全量结果汇总文件,{sha} 换成 `git rev-parse --short HEAD`;
  // measure:独占量测命令的正则,跑之前要求当前 HEAD 的全量全绿。四项都不写 = 这部分不启用。
  sliceGate?: string
  layerGates?: { pattern: string; cmd: string }[]
  fullGatesSummary?: string
  measure?: string[]
  // M2 G-B:起片前的任务书 lint(见 briefGaps)。sensitivePaths:相对 --repo 的敏感路径清单(每行一个 bash 模式,
  // `#` 开头与空行忽略,同 myapp scripts/dev/sensitive-paths.txt),碰了就必须有「## 安全面」节;
  // briefDeny:整篇任务书里都不许出现的引用(个人数据 / 凭证 / 生产库)。两项都不写 = 这部分不启用。
  sensitivePaths?: string
  briefDeny?: BriefDeny[]
  // F6:对外动作策略表(push · 发信 · 部署 · 生产写 · 外部发帖,默认 hold,见 docs/process/external-actions.md)。
  // 任务书正文写了表里某一类的命令就拒起;不写 = 这部分不启用,没配表的仓行为不变。
  externalActions?: ExternalAction[]
}

export const toDelegateRun = (r: ScanRun): DelegateRun => {
  const out: DelegateRun = { label: r.label, runDir: r.runDir, executor: r.executor, state: r.state, startedAt: r.startedAt }
  if (r.model !== undefined) out.model = r.model
  if (r.round !== undefined) out.round = r.round
  if (r.maxRounds !== undefined) out.maxRounds = r.maxRounds
  if (r.endedAt !== undefined) out.endedAt = r.endedAt
  if (r.wallSeconds !== undefined) out.wallSeconds = r.wallSeconds
  if (r.stuck !== undefined) out.stuck = r.stuck
  if (r.outside !== undefined) out.outside = r.outside
  if (r.failureClass !== undefined) out.failureClass = r.failureClass
  if (r.tool !== undefined) out.tool = r.tool
  if (r.tokens !== undefined) out.tokens = r.tokens
  if (r.costUsd !== undefined) out.costUsd = r.costUsd
  return out
}

// ── runs that died without a result (G-3) ───────────────────────────────────────────────

/** What bin/scan.mjs --orphans prints per run: enough to start it again where it stopped. */
export type Orphan = {
  label: string; repo: string; base: string; worktree: string; branch: string; spec: string; prompt: string
  gates: string[]; maxRounds?: number; role?: string; executor?: string; model?: string
  context: boolean; claudeSession?: string; startedAt: number
}

/** `x` → `x-r2`, `x-r2` → `x-r3`. */
export const nextLabel = (label: string) => {
  const m = /^(.*)-r(\d+)$/.exec(label)
  return m ? `${m[1]}-r${Number(m[2]) + 1}` : `${label}-r2`
}

/**
 * The argv after the CLI for taking a dead run up again in its own worktree (Q12): the same task book, gates and
 * model (or role), a new name, `--reuse-worktree` the old worktree. omd-lite's flag for the name is `--name`
 * (the SDD wrote `--label`, which the CLI does not have). Null when the run left too little to start from.
 */
export function resumeArgs(o: Orphan): string[] | null {
  if (!o.repo || !o.base || !o.spec || !o.worktree || !o.gates.length || (!o.role && !o.model)) return null
  return [
    'run',
    '--repo', o.repo,
    '--base', o.base,
    '--spec', o.spec,
    '--prompt', o.prompt,
    ...o.gates.flatMap(g => ['--gate', g]),
    ...(o.role ? ['--role', o.role] : ['--model', o.model as string]),
    ...(o.executor && o.executor !== 'pi' ? ['--executor', o.executor] : []),
    ...(o.maxRounds ? ['--max-rounds', String(o.maxRounds)] : []),
    ...(o.context ? [] : ['--no-context']),
    '--name', nextLabel(o.label),
    '--reuse-worktree', o.worktree,
  ]
}

// ── a provider failure, once more (G-4) ─────────────────────────────────────────────────

/** The only piw failure classes another provider can cure; gate / request / auth are not the provider's to retry. */
export const REDISPATCH_CLASSES: readonly string[] = ['quota', 'stream']
/** A label that is, or was resumed from, an automatic redispatch. */
const REDISPATCHED = /-p2(-r\d+)?$/
export const isRedispatch = (label: string) => REDISPATCHED.test(label)
export const redispatchLabel = (label: string) => `${label}-p2`
const REVIEW_RUN = /-review-[a-z0-9]+(-\d+)?$/

/**
 * Whether a run that ended may be redispatched, and if not, why. Pure provider failures only: quota / stream from
 * piw's own record, never a gate failure (scope violation, stuck gate), and never a run that is itself a redispatch
 * (each label gets one; the second failure goes to the lead).
 */
export function redispatchVerdict(r: ScanRun): { ok: true } | { ok: false; why: string } {
  if (r.state !== 'fail' && r.state !== 'not-run') return { ok: false, why: 'not a failed end' }
  if (!r.piwFailure || !REDISPATCH_CLASSES.includes(r.piwFailure)) return { ok: false, why: `failureClass ${r.piwFailure ?? '-'} is not a provider failure` }
  if (r.stuck || r.outside?.length) return { ok: false, why: 'gate failure' }
  if (isRedispatch(r.label)) return { ok: false, why: 'already a redispatch' }
  // --role worker 会落到别的家族,名字和判词文件却还是原家族的:两家审变成一家
  if (REVIEW_RUN.test(r.label)) return { ok: false, why: '审查不跨家族重派' }
  if (!r.failedCoords?.length) return { ok: false, why: 'no failed coordinates to skip' }
  if (!r.launch) return { ok: false, why: 'no launch recipe' }
  return { ok: true }
}

/**
 * The argv after the CLI for a fresh run of the same brief on another provider: `--role worker` with every
 * coordinate that failed skipped, a new worktree under `<label>-p2`. Null when the run left too little to start from.
 */
export function redispatchArgs(r: ScanRun): string[] | null {
  const l = r.launch
  if (!l || !r.failedCoords?.length || !l.repo || !l.base || !l.spec || !l.gates.length) return null
  return [
    'run',
    '--repo', l.repo,
    '--base', l.base,
    '--spec', l.spec,
    '--prompt', l.prompt,
    ...l.gates.flatMap(g => ['--gate', g]),
    '--role', 'worker',
    ...r.failedCoords.flatMap(c => ['--skip-coord', c]),
    ...(l.maxRounds ? ['--max-rounds', String(l.maxRounds)] : []),
    ...(l.context ? [] : ['--no-context']),
    '--name', redispatchLabel(r.label),
  ]
}

/** D-SPAWN: the argv for `$.process.run` that starts `argv` in its own session with stdio off the hook; LOG comes in env. */
export const detachedArgv = (argv: readonly string[]): string[] => [
  'sh',
  '-c',
  'mkdir -p "${LOG%/*}" && setsid -f "$@" </dev/null >>"$LOG" 2>&1',
  '_',
  ...argv,
]

// ── shell words ────────────────────────────────────────────────────────────────────────

export type Token = { kind: 'word' | 'op' | 'redir'; value: string; start: number; end: number; isRedirTarget?: boolean }

const REDIR = /^(\d*)(<<-?|>>|>&|&>|>|<)(&\d+|&-)?/

/** Splits a command into words (quotes and backslashes resolved), operators and redirections, keeping each span.
 *  A heredoc body is text, not commands: `<<WORD` / `<<'WORD'` / `<<-WORD` runs to the line that is WORD and
 *  nothing there is lexed (D1 · 18.10: writing a brief that quotes `piw run` must not look like starting one). */
export function tokenize(cmd: string): Token[] {
  const out: Token[] = []
  let i = 0
  let expectTarget = false
  let expectHeredoc = false
  /** Delimiters of the heredocs whose bodies start after the line being read ends, in the order they were written. */
  let bodies: string[] = []
  /** The body we are inside, '' = none. */
  let body = ''
  while (i < cmd.length) {
    const c = cmd[i] as string
    if (body) {
      const nl = cmd.indexOf('\n', i)
      const end = nl < 0 ? cmd.length : nl
      // The terminator ends this body; the next `<<` of the same line has its body right behind it.
      if (cmd.slice(i, end).trim() === body) body = bodies.shift() ?? ''
      i = nl < 0 ? cmd.length : nl + 1
      continue
    }
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(cmd[i - 1] as string))) {
      while (i < cmd.length && cmd[i] !== '\n') i++
      continue
    }
    const two = cmd.slice(i, i + 2)
    const redir = REDIR.exec(cmd.slice(i))
    if (redir) {
      out.push({ kind: 'redir', value: redir[0], start: i, end: i + redir[0].length })
      expectTarget = !redir[3]
      expectHeredoc = redir[2] === '<<' || redir[2] === '<<-'
      i += redir[0].length
      continue
    }
    if (two === '&&' || two === '||' || two === ';;') {
      out.push({ kind: 'op', value: two, start: i, end: i + 2 })
      i += 2
      continue
    }
    if (';|&\n()'.includes(c)) {
      out.push({ kind: 'op', value: c, start: i, end: i + 1 })
      // The bodies of this line's heredocs follow the newline.
      if (c === '\n' && bodies.length) body = bodies.shift() as string
      i++
      continue
    }
    const start = i
    let value = ''
    while (i < cmd.length) {
      const ch = cmd[i] as string
      if (' \t\n;|&()<>'.includes(ch)) break
      if (ch === "'") {
        const close = cmd.indexOf("'", i + 1)
        const stop = close < 0 ? cmd.length : close
        value += cmd.slice(i + 1, stop)
        i = stop + 1
      } else if (ch === '"') {
        i++
        while (i < cmd.length && cmd[i] !== '"') {
          if (cmd[i] === '\\' && '"\\$`\n'.includes(cmd[i + 1] ?? '')) i++
          value += cmd[i] ?? ''
          i++
        }
        i++
      } else if (ch === '\\') {
        value += cmd[i + 1] ?? ''
        i += 2
      } else {
        value += ch
        i++
      }
    }
    out.push({ kind: 'word', value, start, end: Math.min(i, cmd.length), ...(expectTarget ? { isRedirTarget: true } : {}) })
    if (expectTarget && expectHeredoc) bodies.push(value)
    expectTarget = false
    expectHeredoc = false
  }
  return out
}

/** Quotes a string for bash, as plainly as it allows. */
export function shellQuote(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s
  if (!s.includes("'")) return `'${s}'`
  if (!/["\\$`!]/.test(s)) return `"${s}"`
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** A simple command with everything it holds (redirections and their targets too) and the operators on both sides. */
type Command = { tokens: Token[]; prevOp: string; nextOp: string }

function commandsOf(tokens: Token[]): Command[] {
  const out: Command[] = [{ tokens: [], prevOp: '', nextOp: '' }]
  for (const t of tokens) {
    if (t.kind === 'op') {
      ;(out.at(-1) as Command).nextOp = t.value
      out.push({ tokens: [], prevOp: t.value, nextOp: '' })
    } else (out.at(-1) as Command).tokens.push(t)
  }
  return out.filter(c => c.tokens.length)
}

const wordsOf = (c: Command) => c.tokens.filter(t => t.kind === 'word' && !t.isRedirTarget)

/** The simple commands of a line: its words between operators, redirections and their targets left out. */
function simpleCommands(tokens: Token[]): Token[][] {
  return commandsOf(tokens).map(wordsOf).filter(c => c.length)
}

/** Which file descriptors a redirection token (`>`, `2>&`, `&>`, `<` ...) rewires. */
function redirFds(v: string): number[] {
  const m = /^(\d*)(>>|>&|&>|>|<)/.exec(v)
  if (!m) return []
  if (m[2] === '&>') return [1, 2]
  return [m[1] ? Number(m[1]) : m[2] === '<' ? 0 : 1]
}

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

/** `VAR=value` — an assignment standing in front of a command, not the command. */
const isAssignment = (v: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)

/** The wrappers a command may stand behind; the word after one (past `setsid -f`, `env A=1`) is its command. */
const WRAPPERS = new Set(['bash', 'sh', 'setsid', 'nohup', 'vt', 'env'])

/**
 * The indexes of a simple command's words that hold its command rather than one of its arguments (D1 · 18.10).
 * A launch script, a merge script or `piw run` counts only here: named as an argument of another command
 * (`sed -n 1,30p scripts/dev/omdl-launch.sh`, `git diff scripts/dev/omdl-merge.sh …`) it is a read, not a launch.
 */
function commandPositions(words: readonly Token[]): number[] {
  const at: number[] = []
  let i = 0
  while (i < words.length) {
    const w = words[i] as Token
    if (isAssignment(w.value)) {
      i++
      continue
    }
    at.push(i)
    if (!WRAPPERS.has(basename(w.value))) break
    i++
    // past the wrapper's own option (`setsid -f`) and assignments (`env A=1`)
    while (i < words.length && (/^-[A-Za-z]$/.test((words[i] as Token).value) || isAssignment((words[i] as Token).value))) i++
  }
  return at
}

// ── launches ───────────────────────────────────────────────────────────────────────────

export type Launch = {
  kind: 'omd-lite' | 'script'
  /** `--dry-run`: the CLI only prints what it would do (no worktree, no model call); nothing here guards it. */
  dryRun: boolean
  /** The word that names omd-lite or the launch script. */
  head: Token
  /** `run` (omd-lite) or the head again (script): where flags are inserted after. */
  anchor: Token
  name?: string
  spec?: string
  repo?: string
  base?: string
  executor?: string
  model?: string
  hasEnvFile: boolean
  gates: Token[]
  /** `setsid` / `nohup` stands before the head in the same simple command: it already outlives the hook (G-8). */
  detached: boolean
  /** Part of a pipeline (`| tee`): cannot be detached by a rewrite. */
  isPiped: boolean
  /** Where `setsid -f` goes: the first word of its simple command that is not a `NAME=value` assignment. Before any
   *  wrapper (`vt`, `timeout`), not at the head: inside `vt` the run keeps vt's pty, which hangs up when vt exits. */
  detachAt: number
  /** Where its simple command ends (after its last redirection), and the file descriptors that command already redirects. */
  tail: number
  fds: number[]
}

const DEFAULT_LAUNCH_ARGS = ['name', 'base', 'spec', 'gate...']

/**
 * G-7: the names the runner answers to, in one table so a rename touches one place. `piw` is omd-lite's new name; both
 * stay (the old name is a symlink to the new one, and old runs, branches and worktrees keep the old prefixes until
 * `piw gc` has cleared them). `runsDir` is under $HOME unless absolute. Every field can be overridden by plugin options
 * (`cliNames` comma-separated, `runsDir`, `branchPrefix`, `wtPrefix`); see `resolveNames`.
 */
export type RunNames = { cliNames: readonly string[]; runsDir: string; branchPrefix: string; wtPrefix: string }
export const RUN_NAMES: RunNames = { cliNames: ['piw', 'omd-lite'], runsDir: '.omd-lite/runs', branchPrefix: 'omdl/', wtPrefix: 'omdl-' }

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
export function resolveNames(options: Record<string, unknown> = {}): RunNames {
  const cli = Array.isArray(options.cliNames) ? options.cliNames.map(String) : nonEmpty(options.cliNames) ? options.cliNames.split(',') : []
  const cliNames = cli.map(x => x.trim()).filter(Boolean)
  return {
    cliNames: cliNames.length ? cliNames : RUN_NAMES.cliNames,
    runsDir: nonEmpty(options.runsDir) ? options.runsDir.trim() : RUN_NAMES.runsDir,
    branchPrefix: nonEmpty(options.branchPrefix) ? options.branchPrefix.trim() : RUN_NAMES.branchPrefix,
    wtPrefix: nonEmpty(options.wtPrefix) ? options.wtPrefix.trim() : RUN_NAMES.wtPrefix,
  }
}
/** The runs directory for a given $HOME. */
export const runsDirOf = (home: string, n: RunNames = RUN_NAMES) => (n.runsDir.startsWith('/') ? n.runsDir : `${home}/${n.runsDir}`)
/** Beside runs/, not in it: the runner refuses a run dir that already exists. */
export const launchLogDirOf = (home: string, n: RunNames = RUN_NAMES) => `${runsDirOf(home, n).replace(/\/[^/]*$/, '')}/launch`

const reEscape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alt = (xs: readonly string[]) => xs.map(reEscape).join('|')

/** The CLI names whose `run` is a launch (the default table's). */
export const LAUNCH_CLIS: readonly string[] = RUN_NAMES.cliNames
/** Flags of `run` that take no value: the parser must not read the next word as theirs. */
const BOOLEAN_FLAGS = new Set(['--no-context', '--dry-run', '--full'])

/** Every `omd-lite run` / `piw run` and every call of the repo's launch script in a command. */
export function findLaunches(cmd: string, cfg: RepoConfig = {}, names: RunNames = RUN_NAMES): Launch[] {
  const launches: Launch[] = []
  const script = cfg.launch ? basename(cfg.launch) : ''
  const hasEnvFile = /\b(?:PIW|OMD_LITE)_ENV_FILE=/.test(cmd)
  // `cd <仓> && scripts/dev/omdl-launch.sh …`:被执行仓是 cd 进去的那个仓，不是会话 cwd(24.10 从 myapp 起 otherapp 片，相对路径的起片脚本被按 myapp 判)
  let cdDir: string | undefined
  for (const command of commandsOf(tokenize(cmd))) {
    const words = wordsOf(command)
    if (words[0]?.value === 'cd' && words[1] && command.nextOp !== '|') { cdDir = words[1].value; continue }
    const heads = new Set(commandPositions(words))
    const where = {
      isPiped: command.prevOp === '|' || command.nextOp === '|',
      detachAt: (words.find(x => !isAssignment(x.value)) ?? words[0])?.start ?? 0,
      tail: Math.max(...command.tokens.map(t => t.end)),
      fds: command.tokens.filter(t => t.kind === 'redir').flatMap(t => redirFds(t.value)),
    }
    for (let i = 0; i < words.length; i++) {
      if (!heads.has(i)) continue
      const w = words[i] as Token
      const base = basename(w.value)
      if (names.cliNames.includes(base) && words[i + 1]?.value === 'run') {
        const detached = words.slice(0, i).some(x => ['setsid', 'nohup'].includes(basename(x.value)))
        const l: Launch = { kind: 'omd-lite', dryRun: false, head: w, anchor: words[i + 1] as Token, hasEnvFile, gates: [], detached, ...where }
        for (let j = i + 2; j < words.length; j++) {
          const a = (words[j] as Token).value
          if (!a.startsWith('--')) continue
          if (a === '--dry-run') l.dryRun = true
          if (BOOLEAN_FLAGS.has(a)) continue
          const v = words[j + 1]
          if (!v) break
          j++
          if (a === '--gate') l.gates.push(v)
          else if (a === '--spec') l.spec = v.value
          else if (a === '--name') l.name = v.value
          else if (a === '--repo') l.repo = v.value
          else if (a === '--base') l.base = v.value
          else if (a === '--executor') l.executor = v.value
          else if (a === '--model') l.model = v.value
        }
        launches.push(l)
        break
      }
      if (script && base === script) {
        // The repo's launch script detaches itself; only its gates are wrapped.
        const l: Launch = { kind: 'script', dryRun: false, head: w, anchor: w, hasEnvFile, gates: [], detached: true, ...where }
        const order = cfg.launchArgs ?? DEFAULT_LAUNCH_ARGS
        const args = words.slice(i + 1)
        order.forEach((slot, k) => {
          if (slot === 'gate...') l.gates.push(...args.slice(k))
          else if (args[k]) (l as Record<string, unknown>)[slot] = (args[k] as Token).value
        })
        // 绝对路径起别的仓的起片脚本(/r/otherapp/scripts/dev/omdl-launch.sh):被执行仓就是那个仓根,不是本会话的 cwd
        const tail = `/${cfg.launch!.replace(/^\.\//, '')}`
        if (w.value.startsWith('/') && w.value.endsWith(tail)) l.repo = w.value.slice(0, -tail.length)
        else if (cdDir && !w.value.startsWith('/')) l.repo = cdDir
        launches.push(l)
        break
      }
    }
  }
  return launches
}

/** A bare command carries no repo config, so looksLikeLaunch reads the myapp-style launch script by name. */
const OMDL_LAUNCH_SCRIPT = 'omdl-launch.sh'

/**
 * For when the guard itself failed: does this command look like a real launch (a dry run does not)?
 * The script name is read by findLaunches, so the command position is the same rule there and here —
 * `cat …/omdl-launch.sh` is a read, not a launch (15.10 三次误拦 · D1 18.10 再犯)。
 */
export function looksLikeLaunch(cmd: string, names: RunNames = RUN_NAMES): boolean {
  try {
    return findLaunches(cmd, { launch: OMDL_LAUNCH_SCRIPT }, names).some(l => !l.dryRun)
  } catch {
    // findLaunches itself failed: a loose text match is what is left, command position or not.
    return new RegExp(`(?:${alt(names.cliNames)})\\s+run\\b|omdl-launch(?:\\.sh)?`).test(cmd) && !/--dry-run\b/.test(cmd)
  }
}

/** True when a command mentions the runner (either name) or a myapp-style omdl- wrapper: worth a rescan. */
export const mentionsRuns = (cmd: string, names: RunNames = RUN_NAMES) =>
  new RegExp(`${names.cliNames.map(x => (/^\w+$/.test(x) ? `\\b${reEscape(x)}\\b` : reEscape(x))).join('|')}|${reEscape(names.wtPrefix)}`).test(cmd)

/**
 * The command with the repo's defaults (executor, model, gate, env file) filled in where an omd-lite run
 * leaves them out. Gates pass through unchanged: the repos' gate-slice.sh queue for memory themselves (D-11).
 */
export function rewriteLaunches(
  cmd: string,
  launches: Launch[],
  cfg: RepoConfig = {},
  /** G-8: where a launch that is not detached logs to (`<logDir>/<name>.log`); absent = no detaching. */
  detach?: { logDir: string },
): string {
  const edits: { start: number; end: number; text: string }[] = []
  for (const l of launches) {
    if (l.kind !== 'omd-lite') continue
    const extra: string[] = []
    if (!l.executor && cfg.executor) extra.push(`--executor ${shellQuote(cfg.executor)}`)
    if (!l.model && cfg.model) extra.push(`--model ${shellQuote(cfg.model)}`)
    if (!l.gates.length && cfg.gate) extra.push(`--gate ${shellQuote(cfg.gate)}`)
    if (extra.length) edits.push({ start: l.anchor.end, end: l.anchor.end, text: ` ${extra.join(' ')}` })
    if (cfg.envFile && !l.hasEnvFile) edits.push({ start: l.head.start, end: l.head.start, text: `env OMD_LITE_ENV_FILE=${shellQuote(cfg.envFile)} ` })
    // G-8 (D-SPAWN): without setsid / nohup the run dies with the session. `setsid -f` before the head (and before the
    // env prefix above: edits at one spot land in reverse order), stdin / stdout / stderr off the hook's pipes.
    if (detach && !l.detached && !l.isPiped && /^[\w.-]+$/.test(l.name ?? '')) {
      edits.push({ start: l.detachAt, end: l.detachAt, text: 'setsid -f ' })
      const redirects = [
        l.fds.includes(0) ? '' : ' </dev/null',
        l.fds.includes(1) ? '' : ` >>${shellQuote(`${detach.logDir}/${l.name}.log`)}`,
        l.fds.includes(2) ? '' : ' 2>&1',
      ].join('')
      if (redirects) edits.push({ start: l.tail, end: l.tail, text: redirects })
    }
  }
  let out = cmd
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

// ── merges ─────────────────────────────────────────────────────────────────────────────

/** The run labels a command merges: the repo's merge script's first argument, or `git merge … omdl/<label>`. */
export function findMerges(cmd: string, cfg: RepoConfig = {}, names: RunNames = RUN_NAMES): string[] {
  const labels: string[] = []
  const script = cfg.merge ? basename(cfg.merge) : ''
  for (const words of simpleCommands(tokenize(cmd))) {
    const values = words.map(w => w.value)
    const at = commandPositions(words).find(i => script !== '' && basename(values[i] as string) === script) ?? -1
    if (at >= 0 && values[at + 1]) {
      labels.push(values[at + 1] as string)
      continue
    }
    const git = values.indexOf('git')
    const merge = values.indexOf('merge', git)
    if (git >= 0 && merge > git) for (const v of values.slice(merge + 1)) if (v.startsWith(names.branchPrefix)) labels.push(v.slice(names.branchPrefix.length))
  }
  return [...new Set(labels)]
}

// 只读的命令:带着 worktree 路径也不改片的状态(20.10)。不在表里的一律当写 —— 宁多记,不靠放宽定义变绿。
const READ_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'stat', 'du', 'df', 'rg', 'grep', 'find', 'bfs', 'diff', 'wc', 'jq', 'readlink', 'realpath', 'file', 'echo', 'printf', 'test', '[', 'true', 'pwd', 'sort', 'uniq', 'cut', 'tr', 'basename', 'dirname', 'tree', 'md5sum', 'sha256sum', 'sed', 'timeout', 'date'])
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'merge-base', 'cat-file', 'branch', 'for-each-ref', 'describe', 'blame', 'grep', 'rev-list', 'worktree', 'shortlog', 'name-rev'])

function isRead(words: readonly Token[]): boolean {
  const pos = commandPositions(words)
  let at = pos.at(-1) ?? 0
  const v = words.map(w => w.value)
  // `timeout 100 du …`:看被它包着的那条
  while (basename(v[at] ?? '') === 'timeout') at += /^\d/.test(v[at + 1] ?? '') ? 2 : 1
  const cmd = basename(v[at] ?? '')
  const args = v.slice(at + 1)
  if (cmd === 'sed') return !args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))
  if (cmd === 'git') {
    let i = 0
    while (i < args.length && /^-[Cc]$/.test(args[i] as string)) i += 2
    const sub = args[i] ?? ''
    if (sub === 'branch') return !args.some(a => /^-[a-zA-Z]*[dDmMcC]/.test(a) || /^--(delete|move|copy|force)/.test(a))
    if (sub === 'worktree') return args[i + 1] === 'list'
    return GIT_READS.has(sub)
  }
  if (cmd === 'tar') return args.some(a => /^-?[a-z]*t/.test(a)) && !args.some(a => /^-?[a-z]*x/.test(a))
  return READ_CMDS.has(cmd)
}

/**
 * The runs a lead command acts on, one phase each: a launch, `collect.mjs <run>`, `git merge omdl/<run>`, or a write
 * inside the run's worktree (a non-read command naming it or run after `cd` into it, an output redirection into it).
 * Reading it (`ls`, `stat`, `git -C <wt> status` …) changes nothing and is not a round (20.10).
 * These become `actor: lead` events, the only source of S11's lead rounds per slice.
 * The merge script is left out: omdl-merge writes its own merge event and counting it here would count it twice.
 */
export function leadTouches(cmd: string, cfg: RepoConfig = {}, names: RunNames = RUN_NAMES): { run: string; phase: string }[] {
  const out = new Map<string, string>()
  const add = (run: string | undefined, phase: string) => { if (run && !out.has(run)) out.set(run, phase) }
  for (const l of findLaunches(cmd, cfg, names)) if (!l.dryRun) add(l.name, 'launch')
  const script = cfg.merge ? basename(cfg.merge) : ''
  const wt = new RegExp(`(?:^|/)${reEscape(names.wtPrefix)}([\\w-]+)(?:/|$)`)
  let inside: string | null = null
  for (const command of commandsOf(tokenize(cmd))) {
    const words = wordsOf(command)
    if (!words.length) continue
    const v = words.map(w => w.value)
    if (script && commandPositions(words).some(i => basename(v[i] as string) === script)) continue
    if (v[0] === 'cd') {
      inside = wt.exec(v[1] ?? '')?.[1] ?? null
      continue
    }
    const git = v.indexOf('git')
    const merge = v.indexOf('merge', git)
    if (git >= 0 && merge > git) for (const x of v.slice(merge + 1)) if (x.startsWith(names.branchPrefix)) add(x.slice(names.branchPrefix.length), 'merge')
    const c = v.findIndex(x => /(^|\/)collect\.mjs$/.test(x))
    if (c >= 0 && v[c + 1] && !v[c + 1]!.startsWith('-') && !v.includes('--dry-run')) add(v[c + 1], 'collect')
    command.tokens.forEach((t, i) => {
      const prev = command.tokens[i - 1]
      if (t.isRedirTarget && prev?.kind === 'redir' && />/.test(prev.value) && !/>&\d/.test(prev.value)) add(wt.exec(t.value)?.[1], 'round')
    })
    if (isRead(words)) continue
    for (const x of v) add(wt.exec(x)?.[1], 'round')
    if (inside) add(inside, 'round')
  }
  return [...out].map(([run, phase]) => ({ run, phase }))
}

// ── the brief (C-1b) ───────────────────────────────────────────────────────────────────

export type BriefPath = { path: string; isNew: boolean }

/**
 * The 允许改动 line → paths, each marked when the brief says it is new (`(新建)`). The parsing rules are the
 * factory's (F1a), not ours: a frontmatter brief is read from its `---` block, a legacy one from the body line
 * exactly as before. Null when the brief names no such key at all.
 */
export function allowedPaths(text: string): BriefPath[] | null {
  return parseBrief(text).allowed
}

export const isTestPath = (p: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]*\.py$/.test(p)

/** One thing a brief must not hand the executor: a regex over the whole text, and why it is off-limits. */
export type BriefDeny = { re: string; why: string }

/**
 * One class of external action the repo holds by default (F6, docs/process/external-actions.md): `push` · 发信 · 部署 ·
 * 生产写 · 外部发帖. `cmd` is matched against the brief's **body** — a brief whose body has the executor run it is one
 * this repo does not dispatch without owner clearing that class in the frontmatter. `why` is what a refusal reads out.
 * `paths` is the same table's other column; the collector is its reader (切片 10), delegate does not look at it.
 */
export type ExternalAction = { class: string; cmd: string; paths?: string; why: string }

/** 「对外动作已放行: push owner 18.10」 — the one key that clears a class, and only in the frontmatter. */
const CLEARED = /^对外动作已放行\s*[:：]\s*(.+)$/

/**
 * The brief in the two parts the external-action table reads: the `---` block's lines, and the body after it. The
 * fence rule is brief.mjs's (a block on the first lines, no closing fence = no block), repeated here because
 * parseBrief hands back fields rather than text and a plugin under the cache cannot import across directories.
 */
function splitBrief(text: string): { frontmatter: string[]; body: string } {
  const lines = text.split('\n')
  const end = lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1
  return end < 0 ? { frontmatter: [], body: text } : { frontmatter: lines.slice(1, end), body: lines.slice(end + 1).join('\n') }
}

/** Every class the frontmatter clears: `对外动作已放行: push owner 18.10` clears `push`; the rest of the line is 出处. */
const clearedClasses = (frontmatter: string[]): string[] => {
  const out: string[] = []
  for (const raw of frontmatter) {
    for (const c of (CLEARED.exec(raw.replace(/\*\*/g, '').trim())?.[1] ?? '').split(/[,，]/)) {
      const cls = c.trim().split(/\s+/)[0]
      if (cls) out.push(cls)
    }
  }
  return out
}

/**
 * What briefGaps checks beyond C-1b. `sensitive`, `deny` and `externalActions` come from the repo's `.claude/delegate.json`;
 * `methods` is the stem of every `docs/methods/*.yaml` in the repo the run is dispatched against (absent = that repo has no
 * cards, so only the slug-existence check is off; see methodSection).
 */
export type BriefLintOpts = { sensitive?: string[]; deny?: BriefDeny[]; methods?: string[]; externalActions?: ExternalAction[] }

/** One sensitive-path bash glob → its anchored regex, plus the literal head in front of the first `*` / `?`. */
const globParts = (glob: string) => {
  const literal = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let re = ''
  let head = ''
  let wild = false
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '\\' && i + 1 < glob.length) {
      const lit = glob[++i] as string
      re += literal(lit)
      if (!wild) head += lit
    } else if (c === '*' || c === '?') {
      wild = true
      re += c === '*' ? '.*' : '.' // bash `*` crosses `/`
    } else {
      re += literal(c)
      if (!wild) head += c
    }
  }
  return { re: new RegExp(`^${re}$`), head, wild }
}

/**
 * The paths a sensitive-path list covers, same meaning as the shell's `[[ "$f" == $g ]]`: the glob matches the
 * whole path, or the path is a directory the glob's literal head reaches into — 「允许改动:packages/」 hands over
 * everything under it, so it hits whatever the head covers. Deduped, in input order.
 */
export function sensitiveHits(paths: string[], patterns: string[]): string[] {
  const globs = patterns.map(globParts)
  const out: string[] = []
  for (const p of paths) {
    if (globs.some(g => g.re.test(p) || (p.endsWith('/') && (g.head.startsWith(p) || (g.wild && p.startsWith(g.head)))))) {
      if (!out.includes(p)) out.push(p)
    }
  }
  return out
}

// ── 「借的方法」节(10.17 ambition-framework §3.3)────────────────────────────────────

/** The heading of the section, and its slug: `## 借的方法(reconcile-money)`; half- and full-width parens both count. */
const METHOD_HEAD = /^#{1,6}\s*借的方法\s*[（(]([^)）]+)[)）]/
/** One of the four lines the card is copied into; half- and full-width colons both count. */
const METHOD_LINE = /^(原始材料|照做|禁止|判官)\s*[:：]\s*(.*)$/
/** 判官 has to be a command a machine runs; the prefixes a repo's own gates and tests are written with. */
const JUDGE_CMD = /^(?:node --test|node scripts\/|bash scripts\/|npx |npm run |bun test)/
/** 「照做:无」, with or without a trailing stop: a money slice that writes it has borrowed no method at all. */
const NONE_LINE = /^无[。.]?$/

/** The lines under a heading matched at index `at`, up to the next heading of any level. */
function under(lines: string[], at: number): string[] {
  const out: string[] = []
  for (let i = at + 1; i < lines.length && !/^#{1,6}\s/.test(lines[i] as string); i++) out.push(lines[i] as string)
  return out
}

/** The brief's lines the way every reader of a brief reads them: `**` gone, both ends trimmed. */
const briefLines = (text: string) => text.split('\n').map(l => l.replace(/\*\*/g, '').trim())

/**
 * The brief's 「借的方法」 section: which card it borrows, and the four lines it copied out of that card. Null when
 * the brief has no such heading — an ordinary slice may borrow no method, so the caller decides whether that is a
 * gap (only a slice that touches money or permissions may not).
 */
export function methodSection(text: string): { slug: string; lines: Record<string, string> } | null {
  const lines = briefLines(text)
  const at = lines.findIndex(l => METHOD_HEAD.test(l))
  if (at < 0) return null
  const slug = (METHOD_HEAD.exec(lines[at] as string)?.[1] ?? '').trim()
  const out: Record<string, string> = {}
  for (const l of under(lines, at)) {
    const m = METHOD_LINE.exec(l)
    if (!m) continue
    const key = m[1] as string
    if (!(key in out)) out[key] = (m[2] as string).trim().replace(/^`(.*)`$/, '$1')
  }
  return { slug, lines: out }
}

/**
 * The 「借的方法:豁免 -- <理由>」 line: this slice borrows no method, and here is why. Null when the brief has no such
 * line. It only excuses an ordinary slice — one that touches money or permissions may not write it (briefGaps).
 */
export function methodExemption(text: string): string | null {
  for (const l of briefLines(text)) {
    const m = /^借的方法\s*[:：]\s*豁免\s*--\s*(.+)$/.exec(l)
    if (m) return (m[1] as string).trim()
  }
  return null
}

/** What a brief lacks of C-1b's three lines and G-B's four; paths not yet checked for existence. */
export function briefGaps(text: string, opts: BriefLintOpts = {}): string[] {
  const gaps: string[] = []
  const lines = text.split('\n').map(l => l.replace(/\*\*/g, '').trim())
  if (!lines.some(l => /^原始目标原文/.test(l))) gaps.push('缺「原始目标原文」行(逐字引 owner 原话)')
  const allowed = allowedPaths(text)
  if (allowed === null) gaps.push('缺「允许改动:」行')
  else if (!allowed.length) gaps.push('「允许改动:」行没有路径')
  if (!lines.some(l => /^#{1,6}\s*成功判据/.test(l))) gaps.push('缺「## 成功判据」节')
  // G-B 四项。任务书整篇发给执行体,所以:写死的期望值不许执行体照抄(lead 重算过没有)· 冻结的接口不许临场改 ·
  // 碰敏感路径的片必须先写安全面 · 个人数据 / 凭证 / 生产引用根本不进任务书。
  if (!text.includes('已重算') && !lines.some(l => /^期望值\s*[:\uFF1A]\s*无/.test(l))) gaps.push('缺「lead 已重算」标记(写死的期望值要标;没有期望值就写一行「期望值:无」)')
  if (!lines.some(l => /^#{1,6}\s*对外(签名|接口)/.test(l) || /^对外(签名|接口)\s*[:\uFF1A]/.test(l))) gaps.push('缺「对外签名」节(冻结的接口名与签名照抄;没有就写一行「对外签名:无」)')
  // 10.19:回流追加在末尾、原裁定没改写,判官每轮把两段当矛盾报(b1 · gate-preflight · s9c);签名行写「下面写明的…」
  // 却一个没列(b1)。回流直接改写原裁定,来由写进提交说明;签名逐个写出名字与参数。
  if (lines.some(l => /^#{1,6}\s*(r\d+\s*)?回流/.test(l))) gaps.push('有「回流」节:回流要直接改写原裁定那一条,来由写进提交说明,任务书里不留回流节')
  if (lines.some(l => /^对外(签名|接口)\s*[:：]/.test(l) && /(下面|下文|以下|如下)(写明|列出|列明|所列|列的|给出)/.test(l))) gaps.push('对外签名行用「下面写明…」指代,没逐个写出导出名与参数')
  const touched = allowed ? sensitiveHits(allowed.map(p => p.path), opts.sensitive ?? []) : []
  if (touched.length && !lines.some(l => /^#{1,6}\s*安全面/.test(l))) gaps.push(`允许改动碰敏感路径(${touched.join('、')}),缺「## 安全面」节(格式见 docs/process/SECURITY.md §1)`)
  // 10.17 §3.3:把任务书里的「名词」换成「动词」的那一节 —— 借顶级专家的方法论与视角,不搞角色扮演。有节就要对
  // (卡在仓里 · 四行齐 · 判官是命令且在成功判据里);碰钱与权限的片强制;普通片两种都不写就当没这回事(能起片)。
  const method = methodSection(text)
  const atCriteria = lines.findIndex(l => /^#{1,6}\s*成功判据/.test(l))
  const criteria = atCriteria < 0 ? '' : under(lines, atCriteria).join('\n')
  if (method) {
    if (opts.methods?.length && !opts.methods.includes(method.slug)) gaps.push(`「借的方法」的 ${method.slug} 在 docs/methods/ 里不存在`)
    const missing = (['照做', '判官'] as const).filter(k => !(method.lines[k] ?? '').trim())
    if (missing.length) gaps.push(`「借的方法」节缺${missing.map(k => `「${k}」`).join('与')}`)
    const judge = (method.lines['判官'] ?? '').trim()
    if (judge && !JUDGE_CMD.test(judge)) gaps.push('「借的方法」的判官不是命令(模型不算判官)')
    else if (judge && !criteria.includes(judge)) gaps.push('「借的方法」的判官命令没列在「成功判据」里')
    if (touched.length && NONE_LINE.test((method.lines['照做'] ?? '').trim())) gaps.push('钱与权限的片「借的方法」不许写「无」')
  } else if (touched.length) {
    gaps.push(`允许改动碰敏感路径(${touched.join('、')}),缺「## 借的方法(<slug>)」节(方法卡见被执行仓 docs/methods/)`)
    const exempt = methodExemption(text)
    if (exempt) gaps.push(`「借的方法:豁免」对碰钱与权限的片不许豁免(理由:${exempt})`)
  }
  for (const d of opts.deny ?? []) {
    let re: RegExp
    try {
      re = new RegExp(d.re)
    } catch {
      // 仓配置里的正则编不出来 = 这条拦等于没拦。守卫在 judge() 里抛出去会让每次起片都拒(无标签),
      // 所以点名报出来,让人去修配置。
      gaps.push(`「briefDeny」里有编不出来的正则(这条等于没拦):${d.re}`)
      continue
    }
    if (re.test(text)) gaps.push(`引用了不许交给执行体的内容:${d.why}`)
  }
  // F6:仓配置的对外动作策略表,默认 hold。任务书正文写了某类的命令就拒起,理由念出 class 与 why。只扫正文 ——
  // frontmatter 的「不许碰」里写一条 git push 说的是不许碰,不是要做这件事;放行只认 frontmatter 的
  // 「对外动作已放行」键,正文里写「已放行」不算。键不是数组(配错了)当空表,跟没配一样不拒。
  const table = Array.isArray(opts.externalActions) ? opts.externalActions : []
  if (table.length) {
    const { frontmatter, body } = splitBrief(text)
    const cleared = clearedClasses(frontmatter)
    for (const [i, a] of table.entries()) {
      let re: RegExp
      try {
        re = new RegExp(a.cmd)
      } catch (e) {
        // 仓配置里的正则编不出来 = 这一条等于没拦。和 briefDeny 一样点名报出来,不抛:抛出去每次起片都无标签地拒。
        gaps.push(`externalActions 第 ${i} 项正则写错:${(e as Error).message}`)
        continue
      }
      if (cleared.includes(a.class)) continue
      if (re.test(body)) gaps.push(`对外动作(${a.class}):${a.why} —— 默认 hold,见 docs/process/external-actions.md`)
    }
  }
  return gaps
}

// ── overlap (GWT-8) ────────────────────────────────────────────────────────────────────

const norm = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '')

/** Paths two allow-lists share: equal, or one a directory holding the other. */
export function overlap(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = []
  for (const x of a.map(norm)) {
    for (const y of b.map(norm)) {
      if (x === y || x.startsWith(`${y}/`)) out.push(x)
      else if (y.startsWith(`${x}/`)) out.push(y)
    }
  }
  return [...new Set(out)]
}

// ── the wake (GWT-15, INV-8) ───────────────────────────────────────────────────────────

export const PROVIDER_ADVICE = 'provider 失败,换供应商或等窗口,不要回灌给执行方(换 provider 重跑同一任务书即可)'

/** One message listing every run that ended in the window. */
export function wakeText(runs: readonly ScanRun[]): string {
  const lines = [`delegate:${runs.length} 个 omd-lite run 结束。`]
  for (const r of runs) {
    const head = [r.label, r.state, r.round !== undefined ? `第 ${r.round}/${r.maxRounds ?? '?'} 轮` : '', r.failureClass ?? '']
    lines.push('', `- ${head.filter(Boolean).join(' · ')}`)
    if (r.diffstat) lines.push(`  diff:${r.diffstat}`)
    if (r.outside?.length) lines.push(`  越界:${r.outside.join(' ')}`)
    if (r.failureClass === 'provider' || REDISPATCH_CLASSES.includes(r.piwFailure ?? '')) {
      lines.push(`  ${PROVIDER_ADVICE}`)
      if (isRedispatch(r.label)) lines.push('  这是自动重派(-p2)的结果,同一 label 不再自动重派:由你决定换供应商、等窗口还是改任务书')
      if (r.error) lines.push(`  报错:${r.error.replace(/\s+/g, ' ').slice(0, 160)}`)
      continue
    }
    if (r.stuck) lines.push(`  stuck:${r.stuck}`)
    if (r.state !== 'pass' && r.gateTail.length) {
      lines.push(`  闸日志末 ${r.gateTail.length} 行${r.failedGate ? `(${r.failedGate})` : ''}:`, '  ```', ...r.gateTail.map(l => `  ${l}`), '  ```')
    }
    lines.push(`  产物:${r.runDir}`)
  }
  lines.push('', '读 diff 对任务书,再决定合并 / 重派。')
  return lines.join('\n')
}

/** The /runs table. */
export function runsTable(runs: readonly ScanRun[], now: number): string {
  if (!runs.length) return '本会话没有 omd-lite run。'
  const rows = [['label', 'state', 'round', 'class', 'min', 'diff']]
  for (const r of runs) {
    const mins = ((r.endedAt ?? now) - r.startedAt) / 60000
    rows.push([r.label, r.state, r.round !== undefined ? `${r.round}/${r.maxRounds ?? '?'}` : '-', r.failureClass ?? r.stuck ?? '-', mins.toFixed(0), r.diffstat.replace(/ changed|\(\+\)|\(-\)/g, '') || '-'])
  }
  const widths = (rows[0] as string[]).map((_, k) => Math.max(...rows.map(row => (row[k] ?? '').length)))
  return rows.map(row => row.map((c, k) => c.padEnd(widths[k] ?? 0)).join('  ').trimEnd()).join('\n')
}

// ── D-18 三级闸门:合并后的组合片闸提醒、独占量测前查全量 ─────────────────────────────

// 改动文件命中的层闸命令(去重,按配置顺序)。
export function layerGatesFor(files: readonly string[], layers: RepoConfig['layerGates'] = []): string[] {
  const out: string[] = []
  for (const l of layers) {
    let re: RegExp
    try {
      re = new RegExp(l.pattern)
    } catch {
      continue
    }
    if (files.some(f => re.test(f)) && !out.includes(l.cmd)) out.push(l.cmd)
  }
  return out
}

// 这条命令跑的是片闸,且基线参数是 base(sha 前缀互相包含即算)。
export function runsSliceGate(cmd: string, script: string, base: string): boolean {
  if (!script || !base) return false
  const name = basename(script)
  for (const words of simpleCommands(tokenize(cmd))) {
    const values = words.map(w => w.value)
    const at = values.findIndex(v => basename(v) === name)
    const arg = at >= 0 ? values[at + 1] : undefined
    if (arg && arg.length >= 7 && (base.startsWith(arg) || arg.startsWith(base))) return true
  }
  return false
}

export function isMeasure(cmd: string, patterns: readonly string[] = []): boolean {
  return patterns.some(p => {
    try {
      return new RegExp(p).test(cmd)
    } catch {
      return false
    }
  })
}

// full-gates.sh 的 summary.txt:每行 `NN-name rc=N Ns`。至少一行且全部 rc=0 才算绿;红的列出来。
export function fullGatesVerdict(summary: string | null): { isGreen: boolean; red: string[]; count: number } {
  const rows = (summary ?? '').split('\n').map(l => l.trim()).filter(l => /\brc=\d+/.test(l))
  const red = rows.filter(l => !/\brc=0\b/.test(l)).map(l => l.split(/\s+/)[0] ?? l)
  return { isGreen: rows.length > 0 && red.length === 0, red, count: rows.length }
}

export function combinedGateNote(base: string, labels: readonly string[], files: readonly string[], cfg: RepoConfig): string {
  const layers = layerGatesFor(files, cfg.layerGates)
  return [
    `delegate · 这批已合并 ${labels.length} 片(${labels.join(' ')}),批前 ${base.slice(0, 9)},共改 ${files.length} 个文件。D-18:收这批前在 main 上跑组合片闸${layers.length ? '和这批碰到的层闸' : ''},全量 13 闸留到独占量测前 / GOAL 收尾 / 发版:`,
    `- ${cfg.sliceGate} ${base.slice(0, 9)}`,
    ...layers.map(c => `- ${c}`),
    '用日志判红绿;红了先修,不往上叠新片。组合片闸绿了这批就清账。',
  ].join('\n')
}
