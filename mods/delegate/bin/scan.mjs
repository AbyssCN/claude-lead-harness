#!/usr/bin/env node
// omd-lite runs launched from one Claude Code session, as delegate reads them.
// Usage: scan.mjs <claude-session-id[,older-id...]> [runs-dir]
//        scan.mjs --all [runs-dir]        every session's runs (G-5, behind $.delegate.allRuns)
//        scan.mjs --orphans [runs-dir]    dead drivers with no result (G-3)
// Prints a JSON array of ScanRun: the C-0 DelegateRun fields (types/index.d.ts) plus what the
// launch guard and the wake text need (repo, worktree, spec, allowed, diffstat, gateTail, ...).
// Pure read: never writes into the runs dir. Only node's standard library.
// Ported from savvy-progress/bin/omd-scan.mjs; state per D-8 (ended = meta.wall_seconds set).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// G-7: the names the runner answers to (hooks/logic.ts RUN_NAMES is the mod's copy). `piw` is the runner's new name; the old
// one, omd-lite, stays a symlink to it. DELEGATE_CLI_NAMES (comma-separated) overrides the CLI names, the runs-dir argument
// overrides the directory.
export const NAMES = {
  cliNames: (process.env.DELEGATE_CLI_NAMES || 'piw,omd-lite').split(',').map(x => x.trim()).filter(Boolean),
  runsDir: path.join('.omd-lite', 'runs'),
}
const defaultRunsDir = () => path.join(os.homedir(), NAMES.runsDir)

// A run dir untouched this long is not one of this session's live runs.
const RECENT_MS = 2 * 24 * 3600 * 1000
// A running run whose files have not changed this long is reported as stuck (a gate may run 15 min).
const QUIET_MS = 20 * 60 * 1000
const GATE_TAIL = 20
// Provider failures (INV-8): rate limit, overload, MiniMax Token Plan cap, 5xx, a dropped stream.
const PROVIDER = /\b(429|529|5\d\d)\b|2056|rate_limit|overloaded|Stream ended without finish_reason|Connection error|Bad Gateway|Request timed out/i

const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const readText = file => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
const readLines = file => readText(file).split('\n')
// The last `n` bytes of a file, as lines (the first, likely cut, dropped).
function tailLines(file, n = 262144) {
  try {
    const size = fs.statSync(file).size
    if (size <= n) return readLines(file)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(n)
    fs.readSync(fd, buf, 0, n, size - n)
    fs.closeSync(fd)
    return buf.toString('utf8').split('\n').slice(1)
  } catch {
    return []
  }
}

const escapeRe = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Does this /proc cmdline (NUL-separated argv) belong to the runner under any of its names? A word that IS the name or ends
// in /<name>: `node /home/user/repos/piw/bin/piw run ...`, `node .../omd-lite run ...`. A path that merely passes through a
// directory of that name (`.../repos/piw/lib/x.js`) is not it.
export function isRunnerCmdline(cmdline, names = NAMES.cliNames) {
  const re = new RegExp(`(?:^|[/\\0\\s])(?:${names.map(escapeRe).join('|')})(?:[\\0\\s]|$)`)
  return re.test(cmdline)
}

// The driver is alive and still the runner (a reused pid is someone else). `procRoot` is for tests (a /proc fixture).
export function isAlive(pid, { names = NAMES.cliNames, procRoot = '/proc' } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (err) {
    if (err.code !== 'EPERM') return false
  }
  try {
    return isRunnerCmdline(fs.readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8'), names)
  } catch {
    return true // no /proc (macOS): trust the signal check
  }
}

const brief = input => {
  if (!input || typeof input !== 'object') return ''
  const v = input.command ?? input.path ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? ''
  return String(v).replace(/\s+/g, ' ').trim().slice(0, 80)
}
const parseLine = line => {
  if (!line || line[0] !== '{') return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

// One mcode round's event stream → tool in flight, tokens, model, and how the round ended.
export function parseMcode(lines) {
  const out = { lastTool: '', tokens: 0, model: '', isRoundDone: false, status: '', error: '' }
  for (const e of lines.map(parseLine)) {
    if (!e) continue
    const item = e.item
    if (e.type === 'item.started' && item?.type === 'tool_call') {
      const call = item.toolCall ?? {}
      out.lastTool = [call.name, brief(call.input)].filter(Boolean).join(': ')
    } else if (e.type === 'turn.completed') {
      const u = e.usage ?? {}
      out.tokens += (u.inputTokens || 0) + (u.cacheReadTokens || u.cachedInputTokens || 0) + (u.outputTokens || 0)
      if (e.model?.modelId) out.model = e.model.modelId
    } else if (e.type === 'exec.completed') {
      out.isRoundDone = true
      out.status = e.result?.status ?? ''
      const err = e.result?.error
      out.error = err ? [err.code, err.message].filter(Boolean).join(' ').slice(0, 300) : ''
    }
  }
  return out
}

// claude -p --output-format stream-json
export function parseClaude(lines) {
  const out = { lastTool: '', tokens: 0, model: '', isRoundDone: false, status: '', error: '' }
  for (const e of lines.map(parseLine)) {
    if (!e) continue
    if (e.type === 'system' && e.model) out.model = e.model
    else if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) if (c.type === 'tool_use') out.lastTool = [c.name, brief(c.input)].filter(Boolean).join(': ')
    } else if (e.type === 'result') {
      const u = e.usage ?? {}
      out.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      out.isRoundDone = true
      out.status = e.is_error ? 'failed' : 'succeeded'
      out.error = e.is_error ? String(e.result ?? e.subtype ?? 'error').slice(0, 300) : ''
    }
  }
  return out
}

// pi --mode json: the tool in flight, tokens and dollars (each assistant message_end's usage), and the last agent_end's stopReason / errorMessage.
export function parsePi(lines) {
  const out = { lastTool: '', tokens: 0, cost: 0, model: '', stopReason: '', error: '' }
  for (const e of lines.map(parseLine)) {
    if (!e) continue
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      out.tokens += e.message.usage?.totalTokens || 0
      out.cost += e.message.usage?.cost?.total || 0
    }
    else if (e.type === 'tool_execution_start') out.lastTool = [e.toolName, brief(e.args)].filter(Boolean).join(': ')
    else if (e.type === 'agent_end') {
      const m = e.messages?.at?.(-1)
      out.stopReason = m?.stopReason ?? ''
      out.error = m?.errorMessage ?? ''
      if (m?.model) out.model = m.model
    }
  }
  return out
}

// A pi.jsonl runs to tens of MB and a scan is a fresh process every 2 s: the sums are kept beside it, in
// ~/.cache/delegate-scan, and only the bytes written since the last scan are read.
export function piUsage(file, key, cacheDir = path.join(os.homedir(), '.cache', 'delegate-scan')) {
  const cacheFile = path.join(cacheDir, `${key}.json`)
  let c = { size: 0, tokens: 0, cost: 0 }
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    // A sum written before dollars were counted starts over, or the cost would miss the bytes it covered.
    if ('cost' in j) c = j
  } catch {}
  let size = 0
  try { size = fs.statSync(file).size } catch { return { tokens: 0, cost: 0 } }
  if (size < c.size) c = { size: 0, tokens: 0, cost: 0 }
  if (size === c.size) return { tokens: c.tokens, cost: c.cost }
  const buf = Buffer.alloc(size - c.size)
  const fd = fs.openSync(file, 'r')
  fs.readSync(fd, buf, 0, buf.length, c.size)
  fs.closeSync(fd)
  const end = buf.lastIndexOf(10) + 1
  const usage = parsePi(buf.subarray(0, end).toString('utf8').split('\n').filter(l => l.startsWith('{"type":"message_end"')))
  c = { size: c.size + end, tokens: c.tokens + usage.tokens, cost: c.cost + usage.cost }
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify(c))
  } catch {}
  return { tokens: c.tokens, cost: c.cost }
}

// The 允许改动 line of a brief (C-1b) → paths; null when the brief has none.
// Accepts `**允许改动:**` (bold) and backticked paths; a `(新建)` mark is dropped here.
export function allowedFromBrief(text) {
  const line = String(text ?? '')
    .split('\n')
    .map(l => l.replace(/\*\*/g, '').trim())
    .find(l => /^允许改动\s*[::]/.test(l))
  if (line === undefined) return null
  return line
    .replace(/^允许改动\s*[::]/, '')
    .split(/[,,、\s]+/)
    .map(s => s.replace(/[`'"]/g, '').replace(/[((]新建[))]$/, '').trim())
    .filter(s => s && !/^[((]?新建[))]?$/.test(s))
}

const roundsOf = (files, prefix, ext) =>
  files.flatMap(f => {
    const m = f.match(new RegExp(`^${prefix}-round-(\\d+)\\.${ext}$`))
    return m ? [Number(m[1])] : []
  })

const executorOf = (meta, files) => {
  const ex = meta.executor ?? (files.some(f => f.startsWith('mcode-round-')) ? 'mcode' : 'pi')
  if (ex === 'mcode' || ex === 'claude') return ex
  if (ex === 'pi') return /minimax/i.test(String(meta.model ?? '')) ? 'minimax' : 'pi'
  return 'other'
}

// What a finished, failed run failed of: 'provider' first (INV-8: never fed back to the executor).
function failureOf(result, exec, state) {
  if (state === 'pass' || state === 'running') return undefined
  const providerText = [exec.stopReason === 'error' || exec.status === 'failed' ? exec.error : '', exec.stopReason].join(' ')
  if ((exec.stopReason === 'error' || exec.status === 'failed') && PROVIDER.test(providerText)) return 'provider'
  if (/^(429|529)$/.test(String(exec.stopReason))) return 'provider'
  if (state === 'interrupted') return 'interrupted'
  if (!result) return 'not-run'
  if (result.error === 'red-check-green-on-base') return 'red-check'
  if (result.stuck) return result.stuck
  if (result.timed_out) return 'timeout'
  if (result.gates === 'fail' && /^越界改动检查/.test(String(result.failed_gate ?? ''))) return 'outside'
  if (result.gates === 'fail') return 'gate'
  if (exec.status === 'failed' || exec.status === 'timeout' || exec.stopReason === 'error') return 'executor'
  return result.gates === 'not-run' ? 'not-run' : 'unknown'
}

// What it takes to start a run again from its meta.json: the orphans list (G-3) and the provider-failure redispatch (G-4) share it.
function launchInfo(meta) {
  return {
    repo: meta.repo ?? '',
    base: meta.base_sha || meta.base || '',
    worktree: meta.worktree ?? '',
    branch: meta.branch ?? '',
    spec: meta.spec ?? '',
    prompt: meta.prompt_arm ?? 'omd-leaf',
    gates: Array.isArray(meta.gates) ? meta.gates : [],
    ...(meta.max_rounds ? { maxRounds: meta.max_rounds } : {}),
    ...(meta.role ? { role: meta.role } : {}),
    ...(meta.executor ? { executor: meta.executor } : {}),
    ...(meta.model && meta.model !== 'default' ? { model: meta.model } : {}),
    context: meta.context !== false,
    ...(meta.claude_session ? { claudeSession: meta.claude_session } : {}),
  }
}

// G-4: piw writes `failureClass` (quota|auth|stream|request|gate|null) and `failedCoords` to meta.json and result.json when a
// run ends. Read from there, never from stderr. Only the two classes a different provider can cure carry a launch recipe.
const REDISPATCHABLE = new Set(['quota', 'stream'])

// piw's own failure record, kept apart from `failureClass` above (that one is C-0's, read by relay and the wake).
function piwFailure(meta, result, isEnded) {
  const cls = meta.failureClass ?? result?.failureClass
  const coords = meta.failedCoords ?? result?.failedCoords
  return {
    ...(meta.claude_session ? { claudeSession: meta.claude_session } : {}),
    ...(isEnded && typeof cls === 'string' ? { piwFailure: cls } : {}),
    ...(isEnded && Array.isArray(coords) && coords.length ? { failedCoords: coords.filter(c => typeof c === 'string') } : {}),
    ...(isEnded && REDISPATCHABLE.has(cls) ? { launch: launchInfo(meta) } : {}),
  }
}

export function summarise(dir, meta, now = Date.now()) {
  const files = fs.readdirSync(dir)
  const executor = executorOf(meta, files)
  const kind = meta.executor === 'mcode' || meta.executor === 'claude' ? meta.executor : 'pi'
  const gateRounds = roundsOf(files, 'gate', 'log')
  const execRounds = kind === 'pi' ? [] : roundsOf(files, kind, 'jsonl')
  const round = Math.max(1, ...execRounds, ...gateRounds.map(n => (kind === 'pi' ? n + 1 : n)))
  let exec
  let tokens = 0
  let cost = 0
  if (kind === 'pi') {
    const fb = path.join(dir, 'fallback', 'pi.jsonl')
    const file = fs.existsSync(fb) ? fb : path.join(dir, 'pi.jsonl')
    exec = parsePi(tailLines(file))
    // A run that fell back to another provider spent the main log's tokens too.
    const main = piUsage(path.join(dir, 'pi.jsonl'), path.basename(dir))
    const back = fs.existsSync(fb) ? piUsage(fb, `${path.basename(dir)}.fallback`) : { tokens: 0, cost: 0 }
    tokens = main.tokens + back.tokens
    cost = main.cost + back.cost
  } else {
    const parse = kind === 'claude' ? parseClaude : parseMcode
    exec = parse([])
    for (const n of execRounds.sort((a, b) => a - b)) {
      const r = parse(readLines(path.join(dir, `${kind}-round-${n}.jsonl`)))
      tokens += r.tokens
      exec = r
    }
  }
  const metaTokens = meta.tokens ? (meta.tokens.input || 0) + (meta.tokens.output || 0) + (meta.tokens.cacheRead || 0) : 0
  tokens = Math.max(tokens, metaTokens)
  cost = Math.max(cost, meta.tokens?.cost || 0)

  const result = readJson(path.join(dir, 'result.json'))
  const isEnded = meta.wall_seconds !== undefined && meta.wall_seconds !== null
  const isDriverAlive = meta.driver_pid === undefined ? true : isAlive(meta.driver_pid)
  let state
  if (isEnded || (!isDriverAlive && result)) {
    state = result?.gates === 'pass' ? 'pass' : result?.gates === 'fail' ? 'fail' : 'not-run'
  } else state = isDriverAlive ? 'running' : 'interrupted'

  const startedAt = (meta.start_epoch ?? 0) * 1000 || fs.statSync(path.join(dir, 'meta.json')).mtimeMs
  const lastWrite = Math.max(...files.map(f => fs.statSync(path.join(dir, f)).mtimeMs))
  const endedAt = state === 'running' ? undefined : meta.end_epoch ? meta.end_epoch * 1000 : lastWrite
  let stuck
  if (state === 'running' && now - lastWrite > QUIET_MS) stuck = `无输出 ${Math.round((now - lastWrite) / 60000)} min`
  else if (state !== 'running' && result?.stuck) stuck = String(result.stuck)

  const lastGate = Math.max(0, ...gateRounds)
  const gateLog = lastGate ? readLines(path.join(dir, `gate-round-${lastGate}.log`)) : []
  while (gateLog.length && !gateLog.at(-1).trim()) gateLog.pop()
  const diffLines = readLines(path.join(dir, 'diffstat.txt')).filter(l => l.trim())
  const specText = readText(path.join(meta.worktree ?? '', meta.spec ?? '')) || readText(path.join(meta.repo ?? '', meta.spec ?? ''))
  const model = exec.model || (meta.model && meta.model !== 'default' ? meta.model : undefined)

  const run = {
    label: meta.label ?? path.basename(dir),
    runDir: dir,
    executor,
    ...(model ? { model } : {}),
    state,
    round: state !== 'running' && Number.isInteger(result?.round) ? result.round : round,
    maxRounds: meta.max_rounds ?? 3,
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(isEnded ? { wallSeconds: meta.wall_seconds } : {}),
    ...(stuck ? { stuck } : {}),
    ...(Array.isArray(result?.outside) ? { outside: result.outside } : {}),
    ...(failureOf(result, exec, state) ? { failureClass: failureOf(result, exec, state) } : {}),
    ...(state === 'running' && exec.lastTool ? { tool: exec.lastTool } : {}),
    ...(tokens ? { tokens } : {}),
    ...(cost > 0 ? { costUsd: cost } : {}),
    // Beyond C-0: for the launch guard, the wake text and the merge clean-up.
    repo: meta.repo ?? '',
    worktree: meta.worktree ?? '',
    branch: meta.branch ?? '',
    spec: meta.spec ?? '',
    allowed: allowedFromBrief(specText),
    diffstat: diffLines.at(-1)?.trim() ?? '',
    gateTail: gateLog.slice(-GATE_TAIL),
    failedGate: result?.failed_gate ?? '',
    error: exec.error || result?.error || '',
    ...piwFailure(meta, result, isEnded),
  }
  return run
}

// Run dirs touched in the last two days, each summarised when `keep(meta)` says so; oldest first.
function collect(runsDir, now, keep) {
  let labels
  try {
    labels = fs.readdirSync(runsDir)
  } catch {
    return []
  }
  const runs = []
  for (const label of labels) {
    const dir = path.join(runsDir, label)
    let st
    try {
      st = fs.statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory() || now - st.mtimeMs > RECENT_MS) continue
    const meta = readJson(path.join(dir, 'meta.json'))
    if (!meta || !keep(meta)) continue
    try {
      runs.push(summarise(dir, meta, now))
    } catch {
      // a run dir mid-write: next poll
    }
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt)
}

// `sessionIds`: one id, a comma-separated list, or an array. A /clear gives the conversation a new
// session id (G-1), and runs launched before it still carry the old one, so the caller passes the lineage.
export function scan(sessionIds, runsDir = defaultRunsDir(), now = Date.now()) {
  const ids = new Set((Array.isArray(sessionIds) ? sessionIds : String(sessionIds ?? '').split(',')).map(s => String(s).trim()).filter(Boolean))
  if (!ids.size) return []
  return collect(runsDir, now, meta => ids.has(meta.claude_session))
}

// G-5: the same summaries without the session filter: every session's runs, and the ones omdl-queue.sh / slot-run.sh
// start, which carry no `claude_session` at all. Behind `$.delegate.allRuns()`; `scan` above stays this session's.
export function scanAll(runsDir = defaultRunsDir(), now = Date.now()) {
  return collect(runsDir, now, () => true)
}

// G-3: runs whose driver died with no result.json and whose worktree is still there, from any session (a WSL
// restart kills the driver mid-run: 9 of 13 in 7 days). Not already resumed: no other run names it in `resumedFrom`,
// and no `<label>-rN` dir exists.
const ORPHAN_WINDOW_MS = 7 * 24 * 3600 * 1000
export function scanOrphans(runsDir = defaultRunsDir(), now = Date.now()) {
  let labels
  try {
    labels = fs.readdirSync(runsDir)
  } catch {
    return []
  }
  const metas = new Map()
  for (const label of labels) {
    const dir = path.join(runsDir, label)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const meta = readJson(path.join(dir, 'meta.json'))
    if (meta) metas.set(label, { meta, dir })
  }
  const resumed = new Set([...metas.values()].map(m => m.meta.resumedFrom).filter(Boolean))
  const out = []
  for (const [label, { meta, dir }] of metas) {
    const startedAt = (meta.start_epoch ?? 0) * 1000 || fs.statSync(path.join(dir, 'meta.json')).mtimeMs
    if (now - startedAt > ORPHAN_WINDOW_MS) continue
    if (meta.wall_seconds !== undefined && meta.wall_seconds !== null) continue
    if (fs.existsSync(path.join(dir, 'result.json'))) continue
    if (!Number.isInteger(meta.driver_pid) || isAlive(meta.driver_pid)) continue
    if (!meta.worktree || !fs.existsSync(meta.worktree)) continue
    if (resumed.has(label) || labels.some(l => l.startsWith(`${label}-r`) && /^\d+$/.test(l.slice(label.length + 2)))) continue
    out.push({ label, ...launchInfo(meta), startedAt })
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out =
    process.argv[2] === '--orphans' ? scanOrphans(process.argv[3]) : process.argv[2] === '--all' ? scanAll(process.argv[3]) : scan(process.argv[2], process.argv[3])
  process.stdout.write(JSON.stringify(out))
}
