#!/usr/bin/env node
// Every 5 minutes (cue-stuck-scan.timer): which herdr panes sit in a cue dialog, and for how long.
//   node cue/bin/cue-stuck-scan.ts            one tick: a line into the readings file, stuck boxes into the outbox
//   node cue/bin/cue-stuck-scan.ts --summary [YYYY-MM-DD]   working-hours stuck count of a Helsinki day (default today)
// Exit 1 when herdr could not be read (that tick has no count, never a zero).
// Env: CUE_STUCK_DIR (readings dir, default ~/.omd-lite/readings) · CUE_STUCK_HERDR (herdr binary) ·
//      CUE_STUCK_OUTBOX (JSON argv of the outbox command, stdin one {dedupKey,text,kind} per line; "[]" = off).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { emptyState, helsinkiDay, summarize, tick, unreadableReading } from '../scan/stuck.ts'
import type { Agent, Alert, State } from '../scan/stuck.ts'

const home = os.homedir()
const dir = process.env.CUE_STUCK_DIR ?? path.join(home, '.omd-lite/readings')
const readings = path.join(dir, 'cue-stuck.jsonl')
const stateFile = path.join(dir, 'cue-stuck.state.json')
const herdrBin = process.env.CUE_STUCK_HERDR ?? 'herdr'
const DEFAULT_OUTBOX = ['~/.bun/bin/bun', '~/.local/bin/freezewatch-outbox.ts', 'enqueue']

function herdr(args: string[]): string {
  return execFileSync(herdrBin, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
}

function append(line: unknown) {
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(readings, JSON.stringify(line) + '\n')
}

function loadState(): State {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State
    return { boxes: s.boxes ?? {}, outbox: s.outbox ?? [] }
  } catch {
    return emptyState()
  }
}

function saveState(s: State) {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${stateFile}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1))
  fs.renameSync(tmp, stateFile)
}

/** Enqueue; returns the dedupKeys the outbox took (or already had). Unsent ones stay for the next tick. */
function send(alerts: Alert[]): Set<string> {
  if (!alerts.length) return new Set()
  const argv = (process.env.CUE_STUCK_OUTBOX ? (JSON.parse(process.env.CUE_STUCK_OUTBOX) as string[]) : DEFAULT_OUTBOX).map((a) => a.replace(/^~\//, home + '/'))
  if (!argv.length) return new Set(alerts.map((a) => a.dedupKey))
  try {
    const out = execFileSync(argv[0]!, argv.slice(1), { input: alerts.map((a) => JSON.stringify(a)).join('\n') + '\n', encoding: 'utf8', timeout: 60_000 })
    const took = new Set<string>()
    for (const l of out.split('\n')) {
      try {
        const r = JSON.parse(l) as { dedupKey?: string }
        if (r.dedupKey) took.add(r.dedupKey)
      } catch { /* not a reply line */ }
    }
    return took
  } catch (e) {
    console.error(`cue-stuck-scan: 发件箱没发出去(${(e as Error).message.split('\n')[0]}),${alerts.length} 条留到下一拍`)
    return new Set()
  }
}

function summary(day: string) {
  let lines: string[] = []
  try { lines = fs.readFileSync(readings, 'utf8').split('\n').filter(Boolean) } catch { /* none yet */ }
  console.log(JSON.stringify(summarize(lines, day)))
}

function main(): number {
  const argv = process.argv.slice(2)
  if (argv[0] === '--summary') {
    summary(argv[1] ?? helsinkiDay(Date.now()))
    return 0
  }
  const now = Date.now()
  let agents: Agent[]
  try {
    agents = (JSON.parse(herdr(['agent', 'list'])) as { result: { agents: Agent[] } }).result.agents
  } catch (e) {
    append(unreadableReading(now, (e as Error).message.split('\n')[0]!))
    return 1
  }
  const seen = agents
    .filter((a) => a.agent_status === 'blocked')
    .map((a) => {
      try {
        return { pane: a.pane_id, screen: herdr(['agent', 'read', a.pane_id, '--source', 'visible']) }
      } catch {
        return { pane: a.pane_id, screen: null }
      }
    })
  const { state, reading } = tick(loadState(), agents, seen, now)
  const took = send(state.outbox)
  state.outbox = state.outbox.filter((a) => !took.has(a.dedupKey))
  saveState(state)
  append(reading)
  return reading.unreadable.length ? 1 : 0
}

process.exitCode = main()
