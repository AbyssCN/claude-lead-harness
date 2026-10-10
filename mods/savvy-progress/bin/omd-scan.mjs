#!/usr/bin/env node
// omd-lite runs launched from one Claude Code session, summarised for the agents panel.
// Usage: omd-scan.mjs <claude-session-id> [runs-dir]
// runs-dir defaults to $OMD_LITE_RUNS_DIR, else ~/.omd-lite/runs.
// Prints a JSON array of OmdRun (see types/index.d.ts). Pure read: never writes into the runs dir.
// Only node's standard library.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A run dir untouched this long is not one of this session's live runs.
const RECENT_MS = 2 * 24 * 3600 * 1000

const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const readLines = file => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    return []
  }
}

// The driver is alive and still omd-lite (a reused pid is someone else).
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (err) {
    if (err.code !== 'EPERM') return false
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('omd-lite')
  } catch {
    // No /proc (macOS): trust the signal check.
    return true
  }
}

const brief = input => {
  if (!input || typeof input !== 'object') return ''
  const v = input.command ?? input.path ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? ''
  return String(v).replace(/\s+/g, ' ').trim().slice(0, 80)
}

// One round's event stream → tool calls, the tool in flight or last used, tokens, model, whether the round ended.
export function parseMcode(lines) {
  const out = { toolCalls: 0, lastTool: '', tokens: 0, contextTokens: 0, model: '', isRoundDone: false, isFailed: false, message: '' }
  for (const line of lines) {
    if (!line || line[0] !== '{') continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const item = e.item
    if (e.type === 'item.started' && item?.type === 'tool_call') {
      const call = item.toolCall ?? {}
      out.lastTool = [call.name, brief(call.input)].filter(Boolean).join(': ')
    } else if (e.type === 'item.completed' && item?.type === 'tool_call') {
      out.toolCalls += 1
    } else if (e.type === 'item.completed' && item?.type === 'agent_message' && typeof item.content === 'string') {
      out.message = item.content.replace(/\s+/g, ' ').trim().slice(0, 120)
    } else if (e.type === 'turn.completed') {
      const u = e.usage ?? {}
      const input = (u.inputTokens || 0) + (u.cacheReadTokens || u.cachedInputTokens || 0)
      out.tokens += input + (u.outputTokens || 0)
      if (e.model?.modelId) out.model = e.model.modelId
    } else if (e.type === 'exec.completed') {
      out.isRoundDone = true
      out.isFailed = e.result?.status === 'failed'
    }
  }
  return out
}

// claude -p --output-format stream-json
export function parseClaude(lines) {
  const out = { toolCalls: 0, lastTool: '', tokens: 0, contextTokens: 0, model: '', isRoundDone: false, isFailed: false, message: '' }
  for (const line of lines) {
    if (!line || line[0] !== '{') continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === 'system' && e.model) out.model = e.model
    else if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type === 'tool_use') {
          out.toolCalls += 1
          out.lastTool = [c.name, brief(c.input)].filter(Boolean).join(': ')
        } else if (c.type === 'text' && c.text) out.message = c.text.replace(/\s+/g, ' ').trim().slice(0, 120)
      }
      const u = e.message?.usage
      if (u) out.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    } else if (e.type === 'result') {
      const u = e.usage ?? {}
      out.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      out.isRoundDone = true
      out.isFailed = e.is_error === true
    }
  }
  return out
}

const roundsOf = (files, prefix, ext) =>
  files.flatMap(f => {
    const m = f.match(new RegExp(`^${prefix}-round-(\\d+)\\.${ext}$`))
    return m ? [Number(m[1])] : []
  })

export function summarise(dir, meta) {
  const files = fs.readdirSync(dir)
  const executor = meta.executor ?? (files.some(f => f.startsWith('mcode-round-')) ? 'mcode' : 'pi')
  const gateRounds = roundsOf(files, 'gate', 'log')
  const execRounds = executor === 'pi' ? [] : roundsOf(files, executor, 'jsonl')
  const round = Math.max(1, ...execRounds, ...gateRounds.map(n => (executor === 'pi' ? n + 1 : n)))
  const parse = executor === 'claude' ? parseClaude : parseMcode
  let toolCalls = 0
  let tokens = 0
  let current = parse([])
  for (const n of execRounds.sort((a, b) => a - b)) {
    const r = parse(readLines(path.join(dir, `${executor}-round-${n}.jsonl`)))
    toolCalls += r.toolCalls
    tokens += r.tokens
    if (n === round) current = r
  }
  const result = readJson(path.join(dir, 'result.json'))
  const metaStart = (meta.start_epoch ?? 0) * 1000 || fs.statSync(path.join(dir, 'meta.json')).mtimeMs
  const endedAt = meta.end_epoch ? meta.end_epoch * 1000 : undefined
  let status = 'running'
  let phase = current.isRoundDone && !gateRounds.includes(round) ? 'gate' : 'exec'
  let note = ''
  if (result) {
    status = result.gates === 'pass' ? 'done' : 'failed'
    phase = 'end'
    note = result.gates === 'pass' ? '' : result.stuck ?? result.error ?? result.failed ?? result.gates ?? ''
    if (typeof note !== 'string') note = JSON.stringify(note).slice(0, 80)
  } else if (meta.driver_pid !== undefined && !isAlive(meta.driver_pid)) {
    status = 'failed'
    phase = 'end'
    note = 'interrupted'
  }
  return {
    id: `omd:${meta.label}`,
    label: meta.label,
    executor,
    spec: meta.spec ?? '',
    model: current.model || (meta.model && meta.model !== 'default' ? meta.model : executor === 'mcode' ? 'MiniMax' : executor),
    status,
    phase,
    note,
    round,
    maxRounds: meta.max_rounds ?? 3,
    toolCalls,
    lastTool: status === 'running' ? current.lastTool : '',
    message: current.message,
    tokens,
    contextTokens: current.contextTokens,
    startedAt: metaStart,
    endedAt: status === 'running' ? undefined : endedAt ?? Math.max(metaStart, fs.statSync(dir).mtimeMs),
  }
}

export function scan(sessionId, runsDir = process.env.OMD_LITE_RUNS_DIR || path.join(os.homedir(), '.omd-lite', 'runs'), now = Date.now()) {
  if (!sessionId) return []
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
    if (!meta || meta.claude_session !== sessionId) continue
    try {
      runs.push(summarise(dir, meta))
    } catch {
      // A run dir mid-write: next poll.
    }
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(JSON.stringify(scan(process.argv[2], process.argv[3])))
}
