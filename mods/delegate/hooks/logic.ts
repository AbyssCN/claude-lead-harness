// delegate's pure parts: reading a Bash command for launches and merges, the brief check (C-1b),
// path overlap (GWT-8), the gate rewrite (C-5) and the wake text (GWT-15 / INV-8). No `$` here.
import type { DelegateRun } from '../types/index'

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
  return out
}

// ── shell words ────────────────────────────────────────────────────────────────────────

export type Token = { kind: 'word' | 'op' | 'redir'; value: string; start: number; end: number; isRedirTarget?: boolean }

const REDIR = /^(\d*)(>>|>&|&>|>|<)(&\d+|&-)?/

/** Splits a command into words (quotes and backslashes resolved), operators and redirections, keeping each span. */
export function tokenize(cmd: string): Token[] {
  const out: Token[] = []
  let i = 0
  let expectTarget = false
  while (i < cmd.length) {
    const c = cmd[i] as string
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
    expectTarget = false
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

/** The simple commands of a line: its words between operators, redirections and their targets left out. */
function simpleCommands(tokens: Token[]): Token[][] {
  const out: Token[][] = [[]]
  for (const t of tokens) {
    if (t.kind === 'op') out.push([])
    else if (t.kind === 'word' && !t.isRedirTarget) out.at(-1)?.push(t)
  }
  return out.filter(c => c.length)
}

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

// ── launches ───────────────────────────────────────────────────────────────────────────

export type Launch = {
  kind: 'omd-lite' | 'script'
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
}

const DEFAULT_LAUNCH_ARGS = ['name', 'base', 'spec', 'gate...']

/** Every `omd-lite run` and every call of the repo's launch script in a command. */
export function findLaunches(cmd: string, cfg: RepoConfig = {}): Launch[] {
  const launches: Launch[] = []
  const script = cfg.launch ? basename(cfg.launch) : ''
  const hasEnvFile = /\bOMD_LITE_ENV_FILE=/.test(cmd)
  for (const words of simpleCommands(tokenize(cmd))) {
    for (let i = 0; i < words.length; i++) {
      const w = words[i] as Token
      const base = basename(w.value)
      if (base === 'omd-lite' && words[i + 1]?.value === 'run') {
        const l: Launch = { kind: 'omd-lite', head: w, anchor: words[i + 1] as Token, hasEnvFile, gates: [] }
        for (let j = i + 2; j < words.length; j++) {
          const a = (words[j] as Token).value
          if (!a.startsWith('--')) continue
          if (a === '--no-context') continue
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
        const l: Launch = { kind: 'script', head: w, anchor: w, hasEnvFile, gates: [] }
        const order = cfg.launchArgs ?? DEFAULT_LAUNCH_ARGS
        const args = words.slice(i + 1)
        order.forEach((slot, k) => {
          if (slot === 'gate...') l.gates.push(...args.slice(k))
          else if (args[k]) (l as Record<string, unknown>)[slot] = (args[k] as Token).value
        })
        launches.push(l)
        break
      }
    }
  }
  return launches
}

/** True when a command mentions omd-lite or an omdl-* wrapper script: worth a rescan. */
export const mentionsRuns = (cmd: string) => /omd-lite|omdl-/.test(cmd)

/**
 * The command with each launch's gates run through gate-slot.sh (C-5), and the repo's
 * defaults (executor, model, gate, env file) filled in where an omd-lite run leaves them out.
 */
export function rewriteLaunches(cmd: string, launches: Launch[], slotPath: string, cfg: RepoConfig = {}): string {
  const edits: { start: number; end: number; text: string }[] = []
  const wrap = (gate: string) => `${slotPath} ${shellQuote(gate)}`
  for (const l of launches) {
    for (const g of l.gates) {
      if (g.value.includes('gate-slot.sh')) continue
      edits.push({ start: g.start, end: g.end, text: shellQuote(wrap(g.value)) })
    }
    if (l.kind !== 'omd-lite') continue
    const extra: string[] = []
    if (!l.executor && cfg.executor) extra.push(`--executor ${shellQuote(cfg.executor)}`)
    if (!l.model && cfg.model) extra.push(`--model ${shellQuote(cfg.model)}`)
    if (!l.gates.length && cfg.gate) extra.push(`--gate ${shellQuote(wrap(cfg.gate))}`)
    if (extra.length) edits.push({ start: l.anchor.end, end: l.anchor.end, text: ` ${extra.join(' ')}` })
    if (cfg.envFile && !l.hasEnvFile) edits.push({ start: l.head.start, end: l.head.start, text: `env OMD_LITE_ENV_FILE=${shellQuote(cfg.envFile)} ` })
  }
  let out = cmd
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

// ── merges ─────────────────────────────────────────────────────────────────────────────

/** The run labels a command merges: the repo's merge script's first argument, or `git merge … omdl/<label>`. */
export function findMerges(cmd: string, cfg: RepoConfig = {}): string[] {
  const labels: string[] = []
  const script = cfg.merge ? basename(cfg.merge) : ''
  for (const words of simpleCommands(tokenize(cmd))) {
    const values = words.map(w => w.value)
    const at = values.findIndex(v => script !== '' && basename(v) === script)
    if (at >= 0 && values[at + 1]) {
      labels.push(values[at + 1] as string)
      continue
    }
    const git = values.indexOf('git')
    const merge = values.indexOf('merge', git)
    if (git >= 0 && merge > git) for (const v of values.slice(merge + 1)) if (v.startsWith('omdl/')) labels.push(v.slice(5))
  }
  return [...new Set(labels)]
}

// ── the brief (C-1b) ───────────────────────────────────────────────────────────────────

export type BriefPath = { path: string; isNew: boolean }

/** The 允许改动 line → paths, each marked when the brief says it is new (`(新建)`). */
export function allowedPaths(text: string): BriefPath[] | null {
  const line = text
    .split('\n')
    .map(l => l.replace(/\*\*/g, '').trim())
    .find(l => /^允许改动\s*[::]/.test(l))
  if (line === undefined) return null
  const out: BriefPath[] = []
  for (const raw of line.replace(/^允许改动\s*[::]/, '').split(/[,,、\s]+/)) {
    const s = raw.replace(/[`'"]/g, '').trim()
    if (!s) continue
    if (/^[((]?新建[))]?$/.test(s)) {
      const last = out.at(-1)
      if (last) last.isNew = true
      continue
    }
    const isNew = /[((]新建[))]$/.test(s)
    out.push({ path: s.replace(/[((]新建[))]$/, ''), isNew })
  }
  return out
}

export const isTestPath = (p: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]*\.py$/.test(p)

/** What a brief lacks of C-1b's three lines; paths not yet checked for existence. */
export function briefGaps(text: string): string[] {
  const gaps: string[] = []
  const lines = text.split('\n').map(l => l.replace(/\*\*/g, '').trim())
  if (!lines.some(l => /^原始目标原文/.test(l))) gaps.push('缺「原始目标原文」行(逐字引用户原话)')
  const allowed = allowedPaths(text)
  if (allowed === null) gaps.push('缺「允许改动:」行')
  else if (!allowed.length) gaps.push('「允许改动:」行没有路径')
  if (!lines.some(l => /^#{1,6}\s*成功判据/.test(l))) gaps.push('缺「## 成功判据」节')
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
    if (r.failureClass === 'provider') {
      lines.push(`  ${PROVIDER_ADVICE}`)
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
    `delegate · 这批已合并 ${labels.length} 片(${labels.join(' ')}),批前 ${base.slice(0, 9)},共改 ${files.length} 个文件。D-18:收这批前在 main 上跑组合片闸${layers.length ? '和这批碰到的层闸' : ''},全量闸留到独占量测前 / GOAL 收尾 / 发版:`,
    `- ${cfg.sliceGate} ${base.slice(0, 9)}`,
    ...layers.map(c => `- ${c}`),
    '用日志判红绿;红了先修,不往上叠新片。组合片闸绿了这批就清账。',
  ].join('\n')
}
