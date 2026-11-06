import { atom, read, update } from 'claude-code'
import type { CommandPresentation, EngineInterface, PromptOrigin, Register, RenderElement } from 'claude-code'

import type { GoStage, Handoff, IdleStall, ModeWhy, Ops, RelayGoal, RelayMode, RelayView, ReviveRound, SharePanel } from '../types'
import { agentEffortMap, effortTable, pickEffort } from './effort'
import type { Effort } from './effort'
import {
  acceptFailPrompt,
  acceptance,
  altitude,
  appendLedger,
  askedLine,
  asksToGoOn,
  checklist,
  continuePrompt,
  currentItem,
  goalPrompt,
  goalTitle,
  heartbeatPrompt,
  hhmm,
  idleNudgePrompt,
  ownerReplyNote,
  kickoffPrompt,
  midTurnKickoff,
  ledger,
  ledgerLine,
  mmdd,
  noAcceptancePrompt,
  normalizeGoal,
  nudgePrompt,
  openWork,
  park,
  parked,
  parkedPrompt,
  parkedSummary,
  parseRelay,
  REVIVE_NOTE,
  REVIVE_WAITING_NOTE,
  tail,
  waitInvalidPrompt,
  waitLines,
} from './goal'
import type { ContextFile } from './goal'
import { asksNick, lines, sanctioned, ticketNudgePrompt } from './asks'
import { paneRows } from './pane'
import { bar, draftText, freshSteps, goSteps, linksOf, rankFiles, redact, sharePrompt, skillsOf, stamp, unfence } from './share'
import { anchorOf, handoffNote, isReadyAnswer, lastBlock, openDecisionRows, openGoalNine, parseDf, resumePrompt, runsSection, short, withoutReady } from './parse'

const ops = atom({ plugin: 'relay', key: 'ops' } as const, null)
const IDLE: Handoff = { phase: 'idle', path: '', armedAt: 0, snoozeTokens: 0, waitAgents: false, anchor: '', auto: false, by: '', retried: false, clearAt: 0 }
const handoff = atom({ plugin: 'relay', key: 'handoff' } as const, IDLE)
// Same as .claude-plugin/plugin.json `version` (bin/version.test.mjs holds them together).
export const RELAY_VERSION = '0.9.0'
// `by` of a handoff relay starts itself after an answer and a quiet delaySeconds, with nobody driving a GOAL.
const IDLE_BY = 'idle'
// `by` of a /relay coldhandoff: the handoff is built from files (no Claude request) and cleared at once.
const COLD_BY = 'cold'
const kindOf = (h: Handoff): string => (h.by === IDLE_BY ? 'idle' : h.by === COLD_BY ? 'cold' : h.auto ? 'auto' : 'go')
const diskWarned = atom({ plugin: 'relay', key: 'diskWarned' } as const, false)
// Subagents of this session still running (Opus / Sonnet / Haiku, workflow agents);
// a /clear would drop them. External MiniMax runs are not counted: they survive it.
const agents = atom({ plugin: 'relay', key: 'agents' } as const, [])
const agentTypes = atom({ plugin: 'relay', key: 'agentTypes' } as const, {})
// Background shells / monitors of this session still running, as the last Stop hook reported them
// (`background_tasks`). A phase=wait on one of them is a real wait (12.10: an exclusive perf run in a
// background shell was answered「wait 不成立」every turn). They never hold a /clear: they outlive it.
const bgTasks = atom({ plugin: 'relay', key: 'bgTasks' } as const, [])
// owner's last message verbatim, and the answers after it he has not answered (last MAX_UNSEEN): relay's own record of
// what a /clear would take from him, written to the side file and inlined in the resume prompt.
const lastPerson = atom({ plugin: 'relay', key: 'lastPerson' } as const, null)
const unseen = atom({ plugin: 'relay', key: 'unseen' } as const, [])
const BG_TYPES = new Set(['shell', 'monitor'])
const BG_LIVE = new Set(['running', 'pending'])
const WAIT_GRACE_MS = 3_000
const turnRunning = atom({ plugin: 'relay', key: 'turnRunning' } as const, false)
// Origin kind of the prompt that started the current turn. After HANDOFF-READY a turn raised by a
// background event (Monitor / task-notification, every minute) must not count as "not quiet" (13.10).
const turnKind = atom({ plugin: 'relay', key: 'turnKind' } as const, '')
// C-4: cue reads this.
const mode = atom({ plugin: 'relay', key: 'mode' } as const, 'idle')
const goal = atom({ plugin: 'relay', key: 'goal' } as const, null)
const view = atom({ plugin: 'relay', key: 'view' } as const, null)
const origin = atom({ plugin: 'relay', key: 'origin' } as const, 'work')
const lastEffort = atom({ plugin: 'relay', key: 'lastEffort' } as const, {})
const selfClear = atom({ plugin: 'relay', key: 'selfClear' } as const, false)
// GOAL path whose kickoff waits for the running turn's next tool result (or its end); '' when none.
const pendingKickoff = atom({ plugin: 'relay', key: 'pendingKickoff' } as const, '')
// No GOAL driving, a non-owner turn asking owner: '' → reminded once ('nudged') → written to the 待 owner file
// ('parked'), after which relay stays quiet until owner types.
const idleStall = atom({ plugin: 'relay', key: 'idleStall' } as const, '' as IdleStall)
// /handoff's band, and how far a /relay go or auto handoff's clear has got.
const share = atom({ plugin: 'relay', key: 'share' } as const, null as SharePanel | null)
const goStage = atom({ plugin: 'relay', key: 'goStage' } as const, '' as GoStage)
const ownerPid = atom({ plugin: 'relay', key: 'ownerPid' } as const, 0)
// The first turn after a revive, until it ends; null otherwise.
const revive = atom({ plugin: 'relay', key: 'revive' } as const, null as ReviveRound | null)

const DISK_MIN_GB = 50
const DISK_TICK_MS = 5 * 60_000
const SNOOZE_TOKENS = 100_000
// userConfig thresholdTokens, set by register: submit() arms the auto handoff without a Cfg in reach.
let handoffAt = 0
// While subagents or a turn still run at clear time, look again this often, up to the cap.
const RECHECK_MS = 15_000
const WAIT_CAP_MS = 30 * 60_000
// Prompts that carry on a session's work: typed, from the phone, a loop's wake-up.
const WORK_ORIGINS = new Set(['composer', 'bridge', 'scheduled-trigger', 'auto-continuation', 'task-notification'])
const FROM_PERSON = new Set(['composer', 'bridge'])
// cue only sends when owner presses send: its prompts are his words (bcda069e, 20.10: they neither cancelled the clear nor moved the anchor).
const byPerson = (o: PromptOrigin): boolean => FROM_PERSON.has(o.kind) || (o.kind === 'plugin' && 'name' in o && o.name === 'cue')
// Plugins whose prompts drive the loop: relay's own and delegate's wake-ups.
const WORK_PLUGINS = new Set(['relay', 'delegate'])
const STOP_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])
const PANE = 'relay-goal'
const PANE_MIN_COLUMNS = 110
const ACCEPT_TIMEOUT_MS = 10 * 60_000
const STUCK_TURNS = 3

const isWork = (o: PromptOrigin): boolean =>
  WORK_ORIGINS.has(o.kind) || byPerson(o) || (o.kind === 'plugin' && 'name' in o && WORK_PLUGINS.has(String(o.name)))

// C-0 (delegate's noun), read defensively: delegate may not be installed; null when it is not.
type DelegateRunLike = { label: string; state: string; round?: number; maxRounds?: number; failureClass?: string; stuck?: string }
async function delegateRuns($: EngineInterface): Promise<DelegateRunLike[] | null> {
  try {
    // Absent noun: `$.delegate` is undefined and the call throws, caught below.
    const runs = await $.delegate!.runs()
    return Array.isArray(runs) ? runs : null
  } catch {
    return null
  }
}

// G-5: every session's runs, for /ops; null when delegate is absent or too old to have allRuns.
async function delegateAllRuns($: EngineInterface): Promise<DelegateRunLike[] | null> {
  try {
    // allRuns is newer than relay's type reference (types/delegate-ref.d.ts lists runs only); typed here.
    const runs = await ($.delegate as { allRuns?: () => Promise<DelegateRunLike[]> } | undefined)!.allRuns!()
    return Array.isArray(runs) ? runs : null
  } catch {
    return null
  }
}

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME').catch(() => undefined)) ?? '/home/user'
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return String(await $.fs.read(path))
  } catch {
    return null
  }
}

async function diskFree($: EngineInterface): Promise<number | null> {
  try {
    const r = await $.process.run(['df', '-BG', '--output=avail', '/mnt/d'], { timeoutMs: 5000 })
    return r.exitCode === 0 ? parseDf(r.stdout) : null
  } catch {
    return null
  }
}

async function checkDisk($: EngineInterface): Promise<void> {
  const free = await diskFree($)
  const low = free !== null && free < DISK_MIN_GB
  if (low && !(await read($, diskWarned))) {
    $.ui.toast(`D 盘只剩 ${free} GB(上次满盘把 WSL 弄崩了):先清 worktree / .next 缓存,/ops 看清单`)
  }
  await update($, diskWarned, () => low)
}

// Worktrees the dispatch scripts leave in ~/repos plus Claude's own per repo.
async function worktrees($: EngineInterface, h: string): Promise<string[]> {
  const out: string[] = []
  try {
    for (const d of await $.fs.list(`${h}/repos`)) {
      if (d.kind === 'dir' && /^(omdl-|myapp-|agent-)/.test(d.name)) out.push(d.name)
    }
  } catch {
    // No ~/repos.
  }
  for (const repo of ['myapp', 'otherapp', 'oh-my-dag', 'marketing-hub']) {
    try {
      for (const d of await $.fs.list(`${h}/repos/${repo}/.claude/worktrees`)) if (d.kind === 'dir') out.push(`${repo}/${d.name}`)
    } catch {
      // That repo has none.
    }
  }
  return out
}

const repoRoot = (cwd: string): string => cwd.replace(/(\/repos\/[^/]+).*$/, '$1')

// The repo's DECISIONS-PENDING rows and the newest GOAL.md's §9.
async function decisions($: EngineInterface): Promise<string[]> {
  const root = repoRoot(await $.session.cwd())
  const out: string[] = []
  const pending = await readText($, `${root}/docs/plan/DECISIONS-PENDING.md`)
  if (pending) out.push(...openDecisionRows(pending))
  const newest = await newestGoal($, root)
  const goalMd = newest ? await readText($, newest) : null
  if (goalMd) out.push(...openGoalNine(goalMd))
  return out
}

// The newest docs/plan/<dir>/GOAL.md under root, by mtime.
async function newestGoal($: EngineInterface, root: string): Promise<string | null> {
  let newest: { path: string; at: number } | null = null
  try {
    for (const d of await $.fs.list(`${root}/docs/plan`)) {
      if (d.kind !== 'dir') continue
      for (const name of ['GOAL.md', 'GOAL-2.md', 'GOAL-3.md']) {
        const p = `${root}/docs/plan/${d.name}/${name}`
        const st = await $.fs.stat(p).catch(() => null)
        if (st && (!newest || st.mtimeMs > newest.at)) newest = { path: p, at: st.mtimeMs }
      }
    }
  } catch {
    // No docs/plan here.
  }
  return newest?.path ?? null
}

async function handoffPath($: EngineInterface): Promise<string> {
  const h = await home($)
  const name = repoRoot(await $.session.cwd()).split('/').pop() || 'session'
  const id = (await $.session.id()).slice(0, 8)
  return `${h}/.claude/handoffs/${name}-${id}.md`
}

async function contextTokens($: EngineInterface): Promise<number> {
  const usage = await $.session.usage().catch(() => null)
  return usage?.context.tokens ?? 0
}

// The newest docs/plan/*/GOAL.md and every LOOP-GOAL.md under docs/plan (three levels down), for the resume prompt.
async function goalFiles($: EngineInterface): Promise<string[]> {
  const plan = `${repoRoot(await $.session.cwd())}/docs/plan`
  const newest = { path: '', at: -1 }
  const loops: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await $.fs.list(dir).catch(() => [])
    for (const d of entries) {
      const p = `${dir}/${d.name}`
      if (d.kind === 'dir') {
        if (depth < 3) await walk(p, depth + 1)
      } else if (d.name === 'LOOP-GOAL.md') {
        loops.push(p)
      } else if (d.name === 'GOAL.md' && depth === 1 && d.mtimeMs > newest.at) {
        newest.path = p
        newest.at = d.mtimeMs
      }
    }
  }
  await walk(plan, 0)
  return [...(newest.path ? [newest.path] : []), ...loops]
}

// S6: continuity's noun, read defensively — continuity may not be installed, and an older build may answer a
// different shape. The type is a local reference, not relay's contract (plugin.json names ./types/index.d.ts
// alone, as delegate-ref.d.ts does for delegate); the cast keeps the noun in the call chain `$.continuity.<method>()`.
type ContinuityRef = {
  latest: (sessionId: string) => Promise<{ path: string; degraded?: boolean } | null>
  flushStart: (sessionId: string) => Promise<{ ok: boolean; path: string; startedAt: number }>
}

// D-5: the writer takes minutes and the engine cuts a noun call at 10 s (发现 1), so the writer runs in the background
// and relay waits on the checkpoint's mtime, up to this cap.
const MAX_FLUSH_MS = 10 * 60_000
const FLUSH_POLL_MS = 5_000

// Writes the checkpoint once more, so the new session reads the state at clear time rather than the last 100k
// boundary. ok=false: continuity absent, flushStart refused or threw, or the file did not change within MAX_FLUSH_MS;
// the handoff then runs on the last good checkpoint.
async function flushCheckpoint($: EngineInterface): Promise<{ ok: boolean; path: string }> {
  let start: { ok: boolean; path: string; startedAt: number }
  try {
    start = await (($ as { continuity?: ContinuityRef }).continuity!.flushStart(await $.session.id()))
  } catch {
    return { ok: false, path: '' }
  }
  if (start?.ok !== true || typeof start.path !== 'string' || start.path === '') return { ok: false, path: '' }
  const written = async (): Promise<boolean> => {
    const st = await $.fs.stat(start.path).catch(() => null)
    return st !== null && st.mtimeMs > start.startedAt
  }
  const deadline = (await $.clock.now()) + MAX_FLUSH_MS
  while (!(await written())) {
    if ((await $.clock.now()) >= deadline) return { ok: false, path: start.path }
    await new Promise<void>(resolve => $.clock.after(FLUSH_POLL_MS, () => resolve()))
  }
  return { ok: true, path: start.path }
}

// The checkpoint continuity holds for this session, with its quality flag. A degraded one (empty §1/§2 or the
// mechanical fallback) is still worth passing on, but the resume prompt says so. null = nothing to read.
async function findCheckpoint($: EngineInterface, sessionId: string): Promise<{ path: string; degraded: boolean } | null> {
  try {
    const latest = await (($ as { continuity?: ContinuityRef }).continuity!.latest(sessionId))
    return latest && typeof latest.path === 'string' && latest.path !== ''
      ? { path: latest.path, degraded: latest.degraded === true }
      : null
  } catch {
    // continuity 没装 / 没这份 / 读失败:只用交接
    return null
  }
}

// ---------------------------------------------------------------- relay: GOAL loop

type Saved = { mode: RelayMode; goal: RelayGoal }

const storeKey = async ($: EngineInterface): Promise<string> => `goal:${await $.session.cwd()}`

// $.state for the session and the pane; $.store keyed by cwd so a restart or resume can re-arm.
async function persist($: EngineInterface): Promise<void> {
  const g = await read($, goal)
  const key = await storeKey($)
  if (!g) {
    await $.store.delete(key).catch(() => undefined)
    return
  }
  const saved: Saved = { mode: await read($, mode), goal: g }
  await $.store.set(key, saved).catch(() => undefined)
}

// ---------------------------------------------------------------- owner: relay/bin/owner.mjs (契约「冻结的接口」)

// O-2, measured 10.23 on Claude Code 2.1.309: a `$.process.run` child is started by the Claude Code process itself, so
// `$PPID` in it is the pid whose ~/.claude/sessions/<pid>.json carries this session's id. 0 when it cannot be read.
async function selfPid($: EngineInterface): Promise<number> {
  const known = await read($, ownerPid)
  if (known > 0) return known
  try {
    const r = await $.process.run(['sh', '-c', 'echo $PPID'], { timeoutMs: 5000 })
    const pid = r.exitCode === 0 ? Number(r.stdout.trim()) : 0
    if (!Number.isInteger(pid) || pid <= 0) return 0
    await update($, ownerPid, () => pid)
    return pid
  } catch {
    return 0
  }
}

type OwnerOut = { code: number; out: string }

// Exit codes are owner.mjs's (claim 0 / 3 / 5, check 0 / 4, set 0 / 3, mode 0 / 1); 1 also when it cannot run.
async function ownerRun($: EngineInterface, args: string[]): Promise<OwnerOut> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/bin/owner.mjs`, ...args], { timeoutMs: 15_000 })
    return { code: r.exitCode, out: r.stdout }
  } catch {
    return { code: 1, out: '' }
  }
}

const goalCwd = async ($: EngineInterface, g: RelayGoal): Promise<string> => g.cwd || (await $.session.cwd())

async function claim($: EngineInterface, g: RelayGoal, m: RelayMode, flag?: '--force' | '--revive'): Promise<OwnerOut> {
  const pid = await selfPid($)
  const args = ['claim', '--cwd', await goalCwd($, g), '--path', g.path, '--sid', await $.session.id(), '--pid', String(pid), '--mode', m]
  return ownerRun($, flag ? [...args, flag] : args)
}

// D-12: one `mode` line in owner.log per mode change; a line that cannot be written never stops relay.
async function modeLine($: EngineInterface, g: RelayGoal, from: RelayMode, to: RelayMode, why: ModeWhy, oldSid?: string): Promise<void> {
  const pid = await selfPid($)
  const args = ['mode', '--cwd', await goalCwd($, g), '--path', g.path, '--sid', await $.session.id(), '--pid', String(pid), '--from', from, '--to', to, '--why', why]
  const r = await ownerRun($, oldSid ? [...args, '--old-sid', oldSid] : args)
  if (r.code !== 0) $.ui.toast(`relay:owner.log 的 mode 行没写进(owner.mjs mode 退 ${r.code}):${from}->${to} ${why}`)
}

// D-4: before relay sends a prompt for a GOAL, the owner record must still name this process. false = it names
// another (taken over, or this one was revived elsewhere): this session stops driving and says so.
async function fenced($: EngineInterface): Promise<boolean> {
  const g = await read($, goal)
  const m = await read($, mode)
  if (!g || (m !== 'running' && m !== 'waiting-owner')) return false
  const pid = await selfPid($)
  const r = await ownerRun($, ['set', '--cwd', await goalCwd($, g), '--pid', String(pid), '--sid', await $.session.id(), '--last-turn-at', String(await $.clock.now())])
  if (r.code !== 3) return false
  // Only this session's mode: the shared store holds the new owner's state.
  await setMode($, 'idle', 'fence')
  await update($, revive, () => null)
  await tell($, `relay:${g.path} 的属主已经不是这个进程(被接管或在别处复活),这里停手不再续跑;要在这里接着推,敲 /relay resume force`)
  return true
}

async function setMode($: EngineInterface, m: RelayMode, why?: ModeWhy): Promise<void> {
  const from = await read($, mode)
  await update($, mode, () => m)
  const g = why ? await read($, goal) : null
  if (g && why) await modeLine($, g, from, m, why)
}

async function saveGoal($: EngineInterface, g: RelayGoal): Promise<void> {
  await update($, goal, () => g)
  await persist($)
}

// A prompt relay sends: the turn it starts is a work turn relay reacts to. The engine skips only the calling hook, so
// relay's own prompt.submit hook does see it (measured 21.10, kind 'plugin'); the handoff is armed here and rides in
// the text, and the hook's armAuto then finds the phase armed and adds nothing.
function submit($: EngineInterface, text: string): void {
  void (async () => {
    if (await fenced($)) return
    await update($, origin, () => 'work')
    const note = await armAuto($, 'plugin')
    await $.prompt.submit({ text: note ? `${text}\n\n${note}` : text, asUser: true })
  })().catch(() => $.ui.toast('relay:续跑 prompt 没发出去,/relay resume 重试'))
}

async function tell($: EngineInterface, text: string): Promise<void> {
  $.ui.toast(text)
  await $.ui.notify(text, { title: 'relay' }).catch(() => undefined)
}

// Every handoff step leaves a line in ~/.claude/handoffs/handoff.log (last 400), so a stalled or skipped clear is never silent.
async function hlog($: EngineInterface, line: string): Promise<void> {
  try {
    const dir = `${await home($)}/.claude/handoffs`
    const path = `${dir}/handoff.log`
    const old = (await readText($, path)) ?? ''
    const sid = (await $.session.id()).slice(0, 8)
    const lines = old ? old.trimEnd().split('\n').slice(-399) : []
    lines.push(`${new Date(await $.clock.now()).toISOString()} ${sid} ${line}`)
    await $.process.run(['mkdir', '-p', dir]).catch(() => undefined)
    await $.fs.write(path, `${lines.join('\n')}\n`)
  } catch {
    // The log never breaks a handoff.
  }
}

// Stops driving: nothing left that does not wait on owner, budget, done. Never submits. The notice ends with
// the 待 owner summary: the one list owner reads in the morning.
async function halt($: EngineInterface, m: RelayMode, why: string, reason: ModeWhy): Promise<void> {
  const g = await read($, goal)
  await setMode($, m, reason)
  if (g) await saveGoal($, { ...g, lastEvent: why })
  else await persist($)
  const md = g ? await readText($, g.path) : null
  const summary = md ? parkedSummary(md) : ''
  await tell($, `relay:${why}${summary ? `\n${summary}` : ''}`)
}

const MAX_NUDGES = 2

/**
 * A question relay cannot answer for owner: parked under 待 owner (the item it blocks tagged), then on to the
 * next open item. Stops only when every unchecked item waits on 待 owner.
 */
async function parkAndGo($: EngineInterface, g: RelayGoal, md: string, question: string, recommend: string, cfg: Cfg): Promise<void> {
  const p = park(md, question, recommend, g.item)
  if (p.md !== md) await $.fs.write(g.path, p.md)
  await refreshView($, p.md, cfg.threshold)
  const next = openWork(p.md)[0]?.text ?? ''
  const ng: RelayGoal = { ...g, item: next, nudges: 0, stuckKey: '', stuckCount: 0, lastEvent: `挂单 #${p.n}` }
  await saveGoal($, ng)
  if (!next) {
    await halt($, 'waiting-owner', '清单剩下的项都在等你,先停', 'owner-parked')
    return
  }
  // Each park blocks the item it was asked on, so the list runs out; only an item it could not block spins.
  if (g.item && !p.isTagged) {
    await halt($, 'waiting-owner', `「${short(g.item, 40)}」挂不上 #${p.n}(清单里找不到这一行),先停`, 'owner-parked')
    return
  }
  submit($, parkedPrompt(g.path, p.n, question, next))
}

async function pendingPath($: EngineInterface): Promise<string> {
  const name = repoRoot(await $.session.cwd()).split('/').pop() || 'session'
  return `${await home($)}/.claude/relay/待owner-${name}.md`
}

async function parkPending($: EngineInterface, question: string, recommend: string): Promise<void> {
  const path = await pendingPath($)
  const md = (await readText($, path)) ?? `# 待 owner · ${path.split('待owner-').pop()?.replace(/\.md$/, '')}\n`
  const p = park(md, question, recommend, '')
  if (p.md !== md) await $.fs.write(path, p.md)
  if (p.isNew) await tell($, `relay:#${p.n} 记进 ${path}(没有 GOAL 在跑)\n${parkedSummary(p.md)}`)
}

/**
 * No GOAL driving (19.10: both night stalls were sessions without one). A turn owner did not start that ends
 * asking him gets one reminder; asked again, the question goes to the 待 owner file and relay stops pushing.
 */
async function idleTurn($: EngineInterface, answer: string): Promise<void> {
  // A GOAL that runs or waits on owner keeps its own 待 owner list; one that is done or cleared does not.
  const m = await read($, mode)
  if (m === 'running' || (m === 'waiting-owner' && (await read($, goal)))) return
  if ((await read($, origin)) !== 'work' || FROM_PERSON.has(await read($, turnKind))) return
  const stall = await read($, idleStall)
  const r = parseRelay(answer)
  const ticket = await $.env.get('TICKET_ID').catch(() => undefined)
  if (ticket) {
    if (r.kind !== 'owner' && (sanctioned(answer) || !asksNick(answer))) {
      if (stall === 'nudged') await update($, idleStall, () => '')
      return
    }
    if (stall === 'nudged' || stall === 'parked') {
      await update($, idleStall, () => 'parked')
      return
    }
    await update($, idleStall, () => 'nudged')
    submit($, ticketNudgePrompt(ticket))
    return
  }
  if (r.kind === 'owner') {
    await update($, idleStall, () => 'parked')
    await parkPending($, r.question || '(没写问题)', r.recommend)
    return
  }
  if (sanctioned(answer) || !asksNick(answer)) {
    if (stall === 'nudged') await update($, idleStall, () => '')
    return
  }
  if (stall === 'nudged' || stall === 'parked') {
    await update($, idleStall, () => 'parked')
    await parkPending($, askedLine(answer) ?? lines(answer).pop() ?? '', '')
    return
  }
  await update($, idleStall, () => 'nudged')
  submit($, idleNudgePrompt(await pendingPath($)))
}

async function gitHead($: EngineInterface): Promise<string> {
  try {
    const r = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd: await $.session.cwd(), timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

// Subagents still out. The engine's own list is the truth; the SubagentStart/Stop ledger only stands in
// when it cannot be read. An id whose SubagentStop never came (killed, or ended before a compaction)
// stayed on the ledger for good and held the handoff's /clear for 4 hours (10.11).
// `waiting` is left out: in the 10.11 case a subagent that had handed back its result 6 h before stayed
// `waiting` on leftover background work it owned and held the clear. A subagent waiting on its own
// child is covered by the child, listed `running` in its own row.
const LIVE = new Set(['pending', 'running'])
async function liveAgentsFrom($: EngineInterface): Promise<{ ids: string[]; source: string }> {
  try {
    const all = await $.agent.list()
    const live = all.filter(a => LIVE.has(a.status))
    await update($, agents, () => live.map(a => a.id))
    return { ids: live.map(a => `${a.id}(${a.status})`), source: `引擎,共 ${all.length} 个` }
  } catch (err) {
    return { ids: await read($, agents), source: `账,引擎读不到:${String(err).slice(0, 120)}` }
  }
}
async function liveAgents($: EngineInterface): Promise<string[]> {
  return (await liveAgentsFrom($)).ids
}

// INV-12: what a phase=wait could be waiting on — running external runs plus running subagents.
async function waitingOn($: EngineInterface): Promise<number> {
  const subs = (await liveAgents($)).length + (await read($, bgTasks)).length
  // delegate absent: only what relay itself can see.
  const runs = await delegateRuns($)
  return subs + (runs ? runs.filter(r => r.state === 'running').length : 0)
}

// The handoff clears by itself only while nobody is there to lose the screen: a GOAL this session drives (running, or
// waiting on owner while it works the items not parked), or a scheduled run / /loop's turn. A GOAL record another
// window restored from the shared `goal:<cwd>` store is not this session's.
async function isAuto($: EngineInterface, kind: string): Promise<boolean> {
  if (kind === 'scheduled-trigger') return true
  const m = await read($, mode)
  const g = await read($, goal)
  return !!g && (m === 'running' || m === 'waiting-owner') && g.sessionId === (await $.session.id())
}

// What runs now that a /clear would leave behind or orphan: live subagents with the task they were given (the Agent
// call's prompt, from the transcript) and background shells / monitors with their command, one line each.
async function inflight($: EngineInterface): Promise<string> {
  const out: string[] = []
  let rows: Array<{ id: string; type: string; description: string }>
  try {
    rows = (await $.agent.list()).filter(a => LIVE.has(a.status))
  } catch {
    const types = await read($, agentTypes)
    rows = (await read($, agents)).map(id => ({ id, type: types[id] ?? '?', description: '' }))
  }
  if (rows.length) {
    const tasks = new Map<string, string>()
    try {
      for (const m of await $.session.messages()) {
        for (const u of m.toolUses) if (u.agentId && typeof u.input.prompt === 'string') tasks.set(u.agentId, u.input.prompt)
      }
    } catch {
      // Transcript unreadable: the description alone.
    }
    for (const a of rows) out.push(`- 子 agent ${a.id} · ${a.type} · ${a.description} · 任务原文:${tasks.get(a.id) ?? '读不到(只有描述)'}`)
  }
  for (const t of await read($, bgTasks)) out.push(`- 后台 ${t.type} ${t.id} · ${t.command}`)
  return out.join('\n')
}

async function noteFor($: EngineInterface, tokens: number, path: string, anchor: string): Promise<string> {
  return handoffNote(tokens, path, await delegateRuns($), { anchor, inflight: await inflight($) })
}

// Arms the auto handoff on a prompt owner did not send, under a GOAL / scheduled run past the threshold; the note to
// send with it, or null.
async function armAuto($: EngineInterface, kind: string): Promise<string | null> {
  const threshold = handoffAt
  if (threshold <= 0) return null
  const h = await read($, handoff)
  if (h.phase !== 'idle' && h.phase !== 'due') return null
  if (!(await isAuto($, kind))) return null
  const tokens = await contextTokens($)
  // A reminder's snooze is owner's; a GOAL that starts afterwards hands off at the threshold.
  if (tokens < threshold || (h.phase === 'idle' && tokens < h.snoozeTokens)) return null
  const path = await handoffPath($)
  const anchor = anchorOf((await read($, lastPerson))?.text ?? '')
  await update($, handoff, () => ({ ...h, phase: 'armed', path, armedAt: Date.now(), waitAgents: false, anchor, auto: true, by: kind, retried: false }))
  void hlog($, `armed auto ${Math.round(tokens / 1000)}k ${path}`)
  return noteFor($, tokens, path, anchor)
}

async function runsSummary($: EngineInterface): Promise<string | null> {
  const runs = await delegateRuns($)
  if (runs) {
    const by = new Map<string, number>()
    for (const r of runs) by.set(r.state, (by.get(r.state) ?? 0) + 1)
    return [...by].map(([s, n]) => `${s} ${n}`).join(' · ') || '无'
  }
  return null
}

// C-5's slot rule, read for the pane: max(1, ⌊(MemAvailable_GB − 8) ÷ 2⌋).
async function gateSlots($: EngineInterface): Promise<number | null> {
  const text = await readText($, '/proc/meminfo')
  const kb = text?.match(/^MemAvailable:\s+(\d+)\s*kB/m)?.[1]
  return kb ? Math.max(1, Math.floor((Number(kb) / 1024 / 1024 - 8) / 2)) : null
}

async function refreshView($: EngineInterface, md: string | null, threshold: number): Promise<void> {
  const v: RelayView = {
    checklist: md ? checklist(md) : [],
    ledger: md ? ledger(md).slice(-3) : [],
    contextTokens: await contextTokens($),
    threshold,
    runs: await runsSummary($).catch(() => null),
    gateSlots: await gateSlots($),
    diskFreeGb: await diskFree($),
  }
  await update($, view, () => v)
}

async function openPane($: EngineInterface, p: CommandPresentation | null): Promise<void> {
  // D-24 / reference: unasked, a pane opens only where it would be a sidebar.
  if (p && !(p.isFullscreen && p.columns >= PANE_MIN_COLUMNS)) return
  await $.ui.open({ id: PANE, title: 'GOAL' }).catch(() => undefined)
}

async function contextFiles($: EngineInterface, cwd: string): Promise<ContextFile[]> {
  const out: ContextFile[] = []
  for (const name of ['CLAUDE.md', '_NEXT.md', 'docs/plan/TODO.md']) {
    const text = await readText($, `${cwd}/${name}`)
    if (text) out.push({ name, text })
  }
  const last = await newestGoal($, cwd)
  const text = last ? await readText($, last) : null
  if (last && text) out.push({ name: `上一份 GOAL(${last})`, text })
  return out
}

async function freePath($: EngineInterface, dir: string): Promise<string> {
  for (let i = 1; ; i++) {
    const p = `${dir}/GOAL${i === 1 ? '' : `-${i}`}.md`
    if (!(await $.fs.exists(p).catch(() => false))) return p
  }
}

// The text the fork (or, before the first turn, one completion) writes for the GOAL.
async function writeGoalText($: EngineInterface, prompt: string): Promise<{ text: string | null; via: 'fork' | 'complete' }> {
  const forked = await $.model.fork({ prompt })
  if (forked.isAnswered) return { text: forked.text, via: 'fork' }
  if (forked.reason !== 'nothing-to-fork') return { text: null, via: 'fork' }
  const model = await $.session.model()
  const done = await $.model.complete({ model, prompt, maxTokens: 8000 })
  return { text: done.isAnswered ? done.text : null, via: 'complete' }
}

// What /goal writes back beside 已激活 about the GOAL the fork just produced. A hint, never a
// rejection — the same level as a missing section, which normalizeGoal leaves as `(待补:…)`. Fewer
// than two of the four 高度 lines carrying a real answer means the fork shipped a template, not a
// decision, so the note says so and the GOAL still runs.
export function goalTemplateHints(md: string): string[] {
  return altitude(md).filter(a => a.filled).length < 2 ? ['高度节四行里非「无」的不足两行,/goal 重写'] : []
}

function freshGoal(path: string, md: string, sessionId: string, now: number): RelayGoal {
  return {
    path,
    title: goalTitle(md),
    phase: 'plan',
    item: currentItem(md),
    turns: 0,
    nudges: 0,
    stuckKey: '',
    stuckHead: '',
    stuckCount: 0,
    waitGen: 0,
    efforts: effortTable(md),
    startedAt: now,
    sessionId,
    lastEvent: ['已激活', ...goalTemplateHints(md)].join(' · '),
  }
}

type Cfg = { threshold: number; delayMs: number; heartbeatMin: number; maxTurns: number }

// A running turn blocks the clear unless a background-event notification started it; a person's turn
// never gets here (their message already cancelled the handoff).
async function turnBusy($: EngineInterface): Promise<boolean> {
  return (await read($, turnRunning)) && (await read($, turnKind)) !== 'task-notification'
}

// Clears only when no subagent and no turn is running; checks again until the cap.
// One `held:` line per wait in handoff.log, so a stalled clear is never read back from transcripts again.
let heldLogged = ''
// preflushed: /relay coldhandoff already waited for a fresh checkpoint before writing the handoff.
// preflushed 'skip':「现在交接」按钮，不补存，用已有的 checkpoint。
async function clearWhenQuiet($: EngineInterface, cfg: Cfg, path: string, since: number, preflushed: boolean | 'skip' = false): Promise<void> {
  const h = await read($, handoff)
  if (h.phase !== 'ready') return
  const ids = await liveAgents($)
  const out = ids.length
  const busy = await turnBusy($)
  if (out > 0 || busy) {
    const what = `${out} subagents${out ? ` ${ids.join(' ')}` : ''}${busy ? `, a turn (${await read($, turnKind)}) running` : ''}`
    if (Date.now() - since > WAIT_CAP_MS) {
      await update($, handoff, () => ({ ...IDLE, snoozeTokens: h.snoozeTokens }))
      await tell($, `relay:等了 30 分钟仍有 ${out} 个子 agent 或一轮在跑,没有自动 /clear;交接在 ${path}`)
      void hlog($, `gave up after 30 min: ${what}`)
      return
    }
    const key = `${path}@${since}`
    if (heldLogged !== key) {
      heldLogged = key
      void hlog($, `held: ${what}`)
    }
    $.clock.after(RECHECK_MS, () => void clearWhenQuiet($, cfg, path, since, preflushed))
    return
  }
  // 补存 checkpoint 要几十秒到几分钟:补存时仍是 ready,期间 owner 发消息照样能取消;
  // 补完再看一次 —— 被取消了就不 clear,又有一轮 / 子 agent 起来了就回到等安静。
  let flushed = preflushed === true
  if (!preflushed) {
    $.ui.toast('relay:先补存一次 continuity checkpoint,写完就 /clear')
    await update($, goStage, () => 'flush')
    flushed = (await flushCheckpoint($)).ok
    await update($, goStage, () => '')
  }
  if ((await read($, handoff)).phase !== 'ready') return
  if ((await liveAgents($)).length > 0 || (await turnBusy($))) {
    $.clock.after(RECHECK_MS, () => void clearWhenQuiet($, cfg, path, since, preflushed))
    return
  }
  // owner spoke after the handoff was armed and the cancel has not landed yet: the handoff misses his last word.
  const person = await read($, lastPerson)
  if (anchorOf(person?.text ?? '') !== h.anchor) {
    await update($, handoff, () => ({ ...IDLE, snoozeTokens: h.snoozeTokens }))
    $.ui.toast(`relay:交接没接上你最后一条消息,不 clear;交接留在 ${path}`)
    void hlog($, 'not cleared: owner spoke after it was armed')
    return
  }
  // The GOAL stopped while the clear waited: nobody-there no longer holds, so remind instead.
  if (h.auto && h.by !== IDLE_BY && !(await isAuto($, h.by))) {
    const tokens = await contextTokens($)
    await update($, handoff, () => ({ ...IDLE, phase: 'due', snoozeTokens: tokens + SNOOZE_TOKENS }))
    await tell($, `relay:GOAL 已不在跑,不再自动 /clear;交接在 ${path},要清空就敲 /relay go`)
    return
  }
  await update($, handoff, () => IDLE)
  await update($, goStage, () => 'side')
  if (!flushed && preflushed !== 'skip') $.ui.toast('relay:checkpoint 补存没成功,照旧用上一份')
  const lastPath = path.replace(/\.md$/, '.last.md')
  const said = await read($, unseen)
  const last = lastBlock(person, said, [await inflight($), runsSection(await delegateRuns($))].filter(Boolean).join('\n'))
  await $.fs.write(lastPath, last).catch(() => $.ui.toast(`relay:旁车 ${lastPath} 没写进去,原文只在续接 prompt 里`))
  if (h.auto) {
    const answer = said[said.length - 1]?.text ?? '(没有)'
    await $.ui.notify(`relay:已自动清空。clear 前最后一条回答:${short(answer, 200)} 全文 ${lastPath}`, { title: 'relay' }).catch(() => undefined)
  }
  const checkpoint = await findCheckpoint($, await $.session.id())
  const goals = await goalFiles($).catch(() => [])
  // D-20: carry the active GOAL across the clear and re-arm it in the new session.
  const m = await read($, mode)
  const g = await read($, goal)
  const carry = g && (m === 'running' || m === 'waiting-owner') ? { mode: m, goal: g } : null
  await update($, goStage, () => 'clear')
  const oldSid = await $.session.id()
  void hlog($, `cleared ${kindOf(h)} ${path} checkpoint=${flushed ? 'flushed' : 'old'}`)
  await update($, selfClear, () => true)
  await $.command.run({ command: 'clear' })
  await update($, selfClear, () => false)
  await update($, goStage, () => '')
  await update($, unseen, () => [])
  if (carry) {
    await setMode($, carry.mode)
    await saveGoal($, { ...carry.goal, sessionId: await $.session.id(), nudges: 0, lastEvent: '交接后接上' })
    // D-12 / GWT-13: same process, new session id; the judge follows the GOAL line across it by this row.
    await modeLine($, carry.goal, carry.mode, carry.mode, 'relay-clear', oldSid)
    // view 只在内存里,clear 后是空的:不刷的话面板只剩三行表头,要等一轮答完才出清单。
    await refreshView($, await readText($, carry.goal.path), cfg.threshold)
  }
  // D-4: a carried GOAL another process took over while the clear waited is not this session's to resume.
  if (carry && (await fenced($))) return
  await update($, origin, () => 'work')
  await $.prompt.submit({
    text: resumePrompt(
      path,
      checkpoint?.path ?? null,
      goals.filter(p => p !== carry?.goal.path),
      carry ? { path: carry.goal.path, phase: carry.goal.phase } : null,
      checkpoint?.degraded === true,
      { text: last, path: lastPath, auto: h.auto },
    ),
    asUser: true,
  })
}

async function statusText($: EngineInterface, cfg: Cfg): Promise<string> {
  const m = await read($, mode)
  const g = await read($, goal)
  if (!g) return `relay:${m},没有激活的 GOAL。/goal <一句话> 开一个。`
  const h = await read($, handoff)
  const live = await liveAgentsFrom($)
  return [
    `relay:${m} · ${g.title || g.path}`,
    `GOAL ${g.path}`,
    `phase ${g.phase} · 当前项 ${g.item || '(清单已全勾)'} · 轮次 ${g.turns}/${cfg.maxTurns} · 连续违规 ${g.nudges}`,
    `最近:${g.lastEvent}`,
    `交接 ${h.phase}${h.waitAgents ? '(等子 agent 返回)' : ''} · 在跑子 agent ${live.ids.length}${live.ids.length ? ` ${live.ids.join(' ')}` : ''}(${live.source})`,
  ].join('\n')
}

async function startGoal($: EngineInterface, cfg: Cfg, line: string, p: CommandPresentation | null): Promise<void> {
  $.ui.status('relay:正在写 GOAL.md…')
  try {
    const cwd = await $.session.cwd()
    const now = await $.clock.now()
    const day = mmdd(now)
    const prompt = goalPrompt(line, await contextFiles($, cwd), day)
    const ctx = Math.round((await contextTokens($)) / 1000)
    const t0 = await $.clock.now()
    const { text: raw, via } = await writeGoalText($, prompt)
    // Which road, how long, how big: whether fork or the complete after /clear is the slow one is read from these lines.
    const took = `${Math.round(((await $.clock.now()) - t0) / 1000)}s prompt ${prompt.length} chars ctx ${ctx}k`
    if (!raw) {
      void hlog($, `goal failed ${via} ${took}`)
      await tell($, 'relay:GOAL 没写出来(模型没有回答),没有激活;再 /goal 一次')
      return
    }
    const md = normalizeGoal(raw, line)
    const path = await freePath($, `${cwd}/docs/plan/${day}`)
    await $.fs.write(path, md)
    void hlog($, `goal ${via} ${took} hints ${goalTemplateHints(md).length} todo ${md.split('(待补:').length - 1} ${path}`)
    const fresh: RelayGoal = { ...freshGoal(path, md, await $.session.id(), now), cwd }
    // D-2 / D-3: another live process owns this repo's GOAL: written, not activated. Kept in this session only (the
    // shared store is the owner's), so /relay resume force takes it over.
    const c = await claim($, fresh, 'running')
    if (c.code === 3) {
      await update($, goal, () => fresh)
      await update($, mode, () => 'idle')
      await tell($, `relay:GOAL 写到 ${path},没有激活:这个仓的属主(${c.out.trim().replace(/^owner-alive /, '')})还活着在推。要在这里接管就敲 /relay resume force`)
      return
    }
    if (c.code !== 0) $.ui.toast(`relay:认领没记上(owner.mjs claim 退 ${c.code}),照旧激活`)
    const prior = await read($, goal)
    if (prior && prior.path !== path && (await read($, mode)) === 'running') $.ui.toast(`relay:新 GOAL 取代 ${prior.path}`)
    await update($, goal, () => fresh)
    await setMode($, 'running', 'goal')
    await persist($)
    await refreshView($, md, cfg.threshold)
    await openPane($, p)
    // A plugin's prompt only runs once the session is idle: with a turn running, tell the lead inside it.
    if (await read($, turnRunning)) {
      await update($, pendingKickoff, () => path)
      $.ui.toast(`relay:GOAL 已写好 ${path};这一轮下一次工具调用时告诉 lead`)
    } else submit($, kickoffPrompt(path))
  } finally {
    $.ui.status(undefined)
  }
}

// INV-2: relay runs every acceptance command itself before it stops on done.
async function runAcceptance($: EngineInterface, cfg: Cfg, g: RelayGoal, md: string): Promise<void> {
  const list = acceptance(md)
  if (!list.length) {
    await saveGoal($, { ...g, lastEvent: 'done 但验收节无命令' })
    submit($, noAcceptancePrompt(g.path))
    return
  }
  const cwd = await $.session.cwd()
  for (const a of list) {
    let got: number | string
    let out: string
    try {
      const r = await $.process.run(['bash', '-c', a.command], { cwd, timeoutMs: ACCEPT_TIMEOUT_MS })
      got = r.exitCode
      out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`
    } catch (err) {
      got = '超时或无法运行'
      out = String(err)
    }
    if (got !== a.exitCode) {
      if ((await read($, mode)) !== 'running') return
      await saveGoal($, { ...g, lastEvent: `验收没过:${short(a.command, 40)}` })
      submit($, acceptFailPrompt(g.path, a, got, tail(out)))
      return
    }
  }
  if ((await read($, mode)) !== 'running') return
  await halt($, 'done', `GOAL 验收全过(${list.length} 条):${g.title || g.path}`, 'done-accepted')
}

// One main-loop work turn ended while relay drives: read its RELAY line and act (C-2).
async function relayTurn($: EngineInterface, cfg: Cfg, answer: string): Promise<void> {
  if ((await read($, mode)) !== 'running') return
  if ((await read($, origin)) !== 'work') return
  const g0 = await read($, goal)
  if (!g0) return
  const md = await readText($, g0.path)
  if (md === null) {
    await halt($, 'waiting-owner', `GOAL 文件读不到:${g0.path}`, 'stuck')
    return
  }
  const g: RelayGoal = { ...g0, turns: g0.turns + 1, title: goalTitle(md) || g0.title, item: currentItem(md), efforts: effortTable(md) }
  await refreshView($, md, cfg.threshold)
  if (g.turns > cfg.maxTurns) {
    await saveGoal($, g)
    await halt($, 'waiting-owner', `GOAL 已跑满 ${cfg.maxTurns} 轮(maxTurns),停下等你`, 'max-turns')
    return
  }
  const r = parseRelay(answer)
  // D-14: no RELAY line, or a continue that ends on a question / options. A real question gets one nudge
  // (decide it yourself, or write it as owner), then is parked like an owner; 「要不要继续」 is never parked.
  const asked = r.kind === 'none' || r.kind === 'continue' ? askedLine(answer) : null
  if (r.kind === 'none' || asked !== null) {
    if (asked !== null && !asksToGoOn(asked) && g.nudges >= 1) {
      await parkAndGo($, g, md, asked, '', cfg)
      return
    }
    const nudges = g.nudges + 1
    await saveGoal($, { ...g, nudges, lastEvent: `违规结尾 ${nudges}` })
    if (nudges >= MAX_NUDGES) await halt($, 'waiting-owner', `连续 ${nudges} 轮没有 RELAY 行(或停在问句 / 选项),已停;回一句话就接着跑`, 'no-relay-line-twice')
    else submit($, nudgePrompt(g.path))
    return
  }
  const ok: RelayGoal = { ...g, nudges: 0 }
  switch (r.kind) {
    case 'continue': {
      const phase = r.phase ?? ok.phase
      if (phase === 'wait') {
        await saveGoal($, { ...ok, phase, lastEvent: 'wait' })
        if ((await waitingOn($)) === 0) {
          // The Stop hook carrying background_tasks can land just after turn.complete: look once more.
          const gen0 = ok.waitGen
          $.clock.after(WAIT_GRACE_MS, () =>
            void (async () => {
              const g2 = await read($, goal)
              if (!g2 || g2.waitGen !== gen0 || (await read($, turnRunning))) return
              if ((await waitingOn($)) === 0) submit($, waitInvalidPrompt(ok.path))
              else $.clock.after(cfg.heartbeatMin * 60_000, () => void heartbeat($, cfg, gen0))
            })(),
          )
          return
        }
        const gen = ok.waitGen
        $.clock.after(cfg.heartbeatMin * 60_000, () => void heartbeat($, cfg, gen))
        return
      }
      const key = `${phase}|${ok.item}`
      const head = await gitHead($)
      const count = key === ok.stuckKey && head === ok.stuckHead ? ok.stuckCount + 1 : 1
      const next: RelayGoal = { ...ok, phase, stuckKey: key, stuckHead: head, stuckCount: count, lastEvent: `continue ${phase}` }
      await saveGoal($, next)
      if (count >= STUCK_TURNS) {
        if (!ok.item) {
          await halt($, 'waiting-owner', `卡住:「${phase}」${STUCK_TURNS} 轮没有新提交`, 'stuck')
          return
        }
        // 卡住的项跳过去做下一项,卡住这件事挂给 owner 看;没有下一项才停。
        await parkAndGo($, next, md, `「${short(ok.item, 40)}」连续 ${STUCK_TURNS} 轮没有新提交,已跳过`, '(lead 卡住,没有推荐)', cfg)
        return
      }
      submit($, continuePrompt(next.path, phase, next.item))
      return
    }
    case 'done':
      await saveGoal($, { ...ok, lastEvent: '验收中' })
      await runAcceptance($, cfg, ok, md)
      return
    case 'owner':
      await parkAndGo($, g, md, r.question || '(没写问题)', r.recommend, cfg)
      return
    case 'replan': {
      const now = await $.clock.now()
      const item = r.item || ok.item
      const updated = appendLedger(md, ledgerLine(now, r.reason || '(未写原因)', item))
      await $.fs.write(ok.path, updated)
      const next: RelayGoal = { ...ok, item, stuckKey: '', stuckCount: 0, lastEvent: `改道 → ${short(item, 30)}` }
      await saveGoal($, next)
      await refreshView($, updated, cfg.threshold)
      submit($, continuePrompt(next.path, next.phase, item, `改道已记账(${r.reason} → ${item}),先做它。`))
      return
    }
  }
}

async function heartbeat($: EngineInterface, cfg: Cfg, gen: number): Promise<void> {
  const g = await read($, goal)
  if ((await read($, mode)) !== 'running' || !g || g.waitGen !== gen || (await read($, turnRunning))) return
  submit($, heartbeatPrompt(g.path, cfg.heartbeatMin))
}

async function stopRelay($: EngineInterface, why: 'relay-stop' | 'goal-clear'): Promise<void> {
  await setMode($, 'idle', why)
  await update($, revive, () => null)
  const g = await read($, goal)
  if (g) await saveGoal($, { ...g, lastEvent: '已停(/relay stop)' })
}

async function resumeRelay($: EngineInterface, cfg: Cfg, force: boolean): Promise<string> {
  const saved = (await $.store.get(await storeKey($)).catch(() => undefined)) as Saved | undefined
  const g = (await read($, goal)) ?? saved?.goal ?? null
  if (!g) return 'relay:没有可续的 GOAL。/goal <一句话> 开一个。'
  // D-5: a GOAL whose acceptance passed is finished; a new one is a new /goal.
  if ((await read($, mode)) === 'done' || (saved?.mode === 'done' && saved.goal.path === g.path)) {
    return `relay:${g.path} 已经验收通过(done),不再续跑;要接着干,用 /goal <一句话> 开一份新的`
  }
  if (!(await $.fs.exists(g.path).catch(() => false))) return `relay:GOAL 文件不在了:${g.path}`
  const c = await claim($, g, 'running', force ? '--force' : undefined)
  if (c.code === 3) {
    return `relay:${g.path} 的属主(${c.out.trim().replace(/^owner-alive /, '')})还活着在推,这里没有接手;确定要接管就敲 /relay resume force`
  }
  if (c.code !== 0) $.ui.toast(`relay:认领没记上(owner.mjs claim 退 ${c.code}),照旧续跑`)
  await update($, goal, () => g)
  await setMode($, 'running', 'resume')
  await saveGoal($, { ...g, nudges: 0, stuckCount: 0, sessionId: await $.session.id(), lastEvent: '续跑(/relay resume)' })
  // 面板的清单 / 上下文只在内存里(view);新 session 续跑时不刷,要等这一轮答完才出来。
  await refreshView($, await readText($, g.path), cfg.threshold)
  submit($, continuePrompt(g.path, g.phase, g.item))
  return `relay:续跑 ${g.path}(phase=${g.phase})`
}

// A restart or `claude --resume`: the same session re-arms; another session in this cwd is offered it.
async function restore($: EngineInterface, cfg: Cfg): Promise<void> {
  const saved = (await $.store.get(await storeKey($)).catch(() => undefined)) as Saved | undefined
  if (!saved?.goal || (saved.mode !== 'running' && saved.mode !== 'waiting-owner')) return
  if (!(await $.fs.exists(saved.goal.path).catch(() => false))) return
  await update($, goal, () => saved.goal)
  const sid = await $.session.id()
  if (saved.goal.sessionId !== sid) {
    $.ui.toast(`relay:${saved.goal.path} 还没做完;/relay resume 在这个 session 接着跑`)
    return
  }
  // The same session in a new process (`claude --resume <sid>`): a revive when the owner process is gone (D-6).
  const chk = await ownerRun($, ['check', '--cwd', await goalCwd($, saved.goal)])
  let owner: OwnerRecord | null = null
  let alive = false
  if (chk.code === 0) {
    try {
      const j = JSON.parse(chk.out) as { record?: OwnerRecord; alive?: boolean }
      owner = j.record ?? null
      alive = j.alive === true
    } catch {
      owner = null
    }
  }
  if ((chk.code !== 0 && chk.code !== 4) || (chk.code === 0 && !owner)) {
    await tell($, `relay:读不到 ${saved.goal.path} 的属主记录(owner.mjs check 退 ${chk.code}),没有接着跑;/relay resume 手动续`)
    return
  }
  if (owner && owner.pid === (await selfPid($))) {
    await setMode($, saved.mode)
    await refreshView($, await readText($, saved.goal.path), cfg.threshold)
    $.ui.toast(`relay:接上 GOAL ${saved.goal.path}(${saved.mode})`)
    return
  }
  if (owner && alive) {
    await tell($, `relay:${saved.goal.path} 的属主 ${String(owner.sessionId ?? '').slice(0, 8)} ${owner.pid} 还活着,这里不接手;要接管敲 /relay resume force`)
    return
  }
  await reviveGoal($, cfg, saved, owner)
}

// What `owner.mjs check` prints as `record`.
type OwnerRecord = { pid: number; sessionId?: string; claimedAt?: number; lastTurnAt?: number }

// D-6 / D-7 / D-11: the owner process died; claim with --revive, push the news, send exactly one continue prompt.
async function reviveGoal($: EngineInterface, cfg: Cfg, saved: Saved, owner: OwnerRecord | null): Promise<void> {
  const g = saved.goal
  const title = g.title || g.path
  const c = await claim($, g, saved.mode, '--revive')
  if (c.code === 5) {
    await tell($, `relay:「${title}」一小时内已经复活过 3 次,这次不复活,停手;看过再 /relay resume`)
    return
  }
  if (c.code === 3) {
    await tell($, `relay:${g.path} 已经有别的进程接手(${c.out.trim().replace(/^owner-alive /, '')}),这里不复活`)
    return
  }
  if (c.code !== 0) {
    await tell($, `relay:「${title}」复活认领没成(owner.mjs claim 退 ${c.code}),没有续跑;/relay resume 手动续`)
    return
  }
  const now = await $.clock.now()
  const head = await gitHead($)
  const md = (await readText($, g.path)) ?? ''
  const waiting = saved.mode === 'waiting-owner'
  await setMode($, saved.mode, 'revive')
  await saveGoal($, { ...g, sessionId: await $.session.id(), nudges: 0, stuckCount: 0, lastEvent: '属主进程断了,已复活' })
  await refreshView($, md, cfg.threshold)
  await update($, revive, () => ({ kind: waiting ? 'waiting-owner' : 'running', head, waits: waitLines(md) }))
  const lost = owner ? owner.lastTurnAt || owner.claimedAt || 0 : 0
  const asks = parked(md).filter(p => !p.isDone).map(p => `#${p.n} ${short(p.question, 40)}`)
  const push = [
    `relay:「${title}」的属主进程断了,已复活。断开 ${lost ? hhmm(lost) : '时刻不明'} · 复活 ${hhmm(now)}`,
    ...(waiting ? [`仍在等你:${asks.join(' · ') || '(待 owner 里没有没答的)'}`] : []),
  ].join('\n')
  await $.ui.notify(push, { title: 'relay' }).catch(() => undefined)
  submit($, continuePrompt(g.path, g.phase, g.item, waiting ? REVIVE_WAITING_NOTE : REVIVE_NOTE))
}

// The turn the revive prompt started has ended. running: one more push with the commits since, then the usual RELAY
// handling. waiting-owner: true — relay writes nothing and sends nothing; it checks the turn only re-parked (D-6).
async function reviveTurn($: EngineInterface, answer: string): Promise<boolean> {
  const r = await read($, revive)
  if (!r) return false
  await update($, revive, () => null)
  const g = await read($, goal)
  if (!g) return false
  if (r.kind === 'running') {
    let count = '?'
    try {
      const out = await $.process.run(['git', 'rev-list', `${r.head}..HEAD`, '--count'], { cwd: await $.session.cwd(), timeoutMs: 5000 })
      if (out.exitCode === 0) count = out.stdout.trim()
    } catch {
      // count stays ?
    }
    await $.ui.notify(`relay:「${g.title || g.path}」复活后推进了一轮,新提交 ${count} 个`, { title: 'relay' }).catch(() => undefined)
    return false
  }
  const wrong: string[] = []
  const last = lines(answer).filter(l => l.trim()).pop()?.trim() ?? ''
  if (!last.startsWith('RELAY: owner')) wrong.push(`末行不是 RELAY: owner(是「${short(last, 60)}」)`)
  if ((await gitHead($)) !== r.head) wrong.push(`git HEAD 动了(复活时 ${r.head.slice(0, 8) || '读不到'})`)
  const now = waitLines((await readText($, g.path)) ?? '')
  if (now.length !== r.waits.length || now.some((l, i) => l !== r.waits[i])) wrong.push('带 ⏸ 的清单行变了')
  if ((await read($, mode)) !== 'waiting-owner') await setMode($, 'waiting-owner', 'owner-parked')
  if (wrong.length) await tell($, `relay:复活那一轮越界:${wrong.join(';')}。停在 waiting-owner,不再续跑,等你看`)
  return true
}

// The handoff's part of a turn's end; true when the turn belongs to the handoff and relay keeps out.
async function handoffTurn($: EngineInterface, cfg: Cfg, answer: string): Promise<boolean> {
  const h = await read($, handoff)
  if (h.phase === 'ready') return true
  if (h.phase !== 'armed' && isReadyAnswer(answer)) {
    // 30.10: a marker after a cancel did nothing, silently; the session blamed the RELAY last line.
    $.ui.toast('relay:这次的 HANDOFF-READY 不会 /clear —— 交接倒计时已取消(你发了消息)或没开始;要清空就敲 /relay go')
    void hlog($, `HANDOFF-READY at ${h.phase}: ignored`)
    return false
  }
  if (h.phase !== 'armed' || !isReadyAnswer(answer)) return false
  const ids = await liveAgents($)
  if (ids.length > 0) {
    await update($, handoff, () => ({ ...h, waitAgents: true }))
    await tell($, `relay:交接写了,但还有 ${ids.length} 个子 agent 在跑;等它们回来、交接重写后再 clear`)
    void hlog($, `held: ${ids.length} subagents ${ids.join(' ')} at HANDOFF-READY ${h.path}`)
    // 10.11 / 20.10: a wait with no end is the stall; it gives up at the same cap as the clear's.
    const armedAt = h.armedAt
    $.clock.after(WAIT_CAP_MS, () => void giveUpWaiting($, armedAt).catch(() => undefined))
    return true
  }
  const st = await $.fs.stat(h.path).catch(() => null)
  if (!st || st.mtimeMs < h.armedAt - 1000) {
    $.ui.toast(`relay:说交接写好了,但 ${h.path} 没有新内容,不自动 /clear`)
    return true
  }
  const person = (await read($, lastPerson))?.text ?? ''
  const want = anchorOf(person)
  if (!((await readText($, h.path)) ?? '').includes(`relay-anchor: ${want}`)) {
    if (h.auto) {
      // owner spoke while it was written: he is there, so no clear.
      const tokens = await contextTokens($)
      await update($, handoff, () => ({ ...IDLE, snoozeTokens: tokens + SNOOZE_TOKENS }))
      $.ui.toast(`relay:交接没接上你最后一条消息,不 clear;交接留在 ${h.path},上下文再长 100k 再交接`)
      return true
    }
    if (!h.retried) {
      await update($, handoff, () => ({ ...h, anchor: want, retried: true, armedAt: Date.now() }))
      $.ui.toast('relay:交接首行的锚点没对上你最后一条消息,让它重写一次')
      submit($, `[relay] 交接没接上 owner 最后一条消息。他最后一条是:\n${person}\n按它重写 ${h.path},第一行单独写 relay-anchor: ${want},写完回复最后一行单独写 HANDOFF-READY。`)
      return true
    }
    await update($, handoff, () => ({ ...IDLE, snoozeTokens: h.snoozeTokens }))
    await tell($, `relay:交接重写后仍没接上你最后一条消息,停下不 clear;交接在 ${h.path}`)
    return true
  }
  await update($, handoff, () => ({ ...h, phase: 'ready' }))
  void hlog($, `ready ${kindOf(h)} ${h.path}`)
  // /relay go: owner is at the screen and asked for it, no grace period.
  const delay = h.auto && h.by !== IDLE_BY ? cfg.delayMs : 0
  $.ui.toast(
    delay
      ? `relay:交接已写到 ${h.path}。${Math.round(delay / 1000)} 秒后自动 /clear 并接着做;发任何消息即取消`
      : `relay:交接已写到 ${h.path},现在 /clear`,
  )
  const since = Date.now()
  await update($, handoff, x => ({ ...x, clearAt: since + delay }))
  $.clock.after(delay, () => void clearWhenQuiet($, cfg, h.path, since))
  return true
}

// F 稿 ④ 的两个按钮(board 第 2 行):取消交接;倒计时中不等了，现在就 /clear。
async function cancelHandoff($: EngineInterface): Promise<string> {
  const h = await read($, handoff)
  if (h.phase !== 'armed' && h.phase !== 'ready') return 'relay:没有在进行的交接'
  await update($, handoff, () => ({ ...IDLE, snoozeTokens: h.snoozeTokens }))
  void hlog($, `cancelled by button ${h.phase}`)
  return 'relay:交接已取消,不 /clear'
}

async function clearNow($: EngineInterface, cfg: Cfg): Promise<string> {
  const h = await read($, handoff)
  if (h.phase !== 'ready') return 'relay:交接还没写好,没法现在 /clear'
  await update($, handoff, x => ({ ...x, clearAt: Date.now() }))
  // owner 10.24:点了就要在 5 秒内 /clear;补存 checkpoint 要一两分钟,这里跳过,交接用已有的 checkpoint。
  void hlog($, 'clear now by button, no checkpoint flush')
  void clearWhenQuiet($, cfg, h.path, Date.now(), 'skip')
  return 'relay:不等倒计时,现在 /clear'
}

async function giveUpWaiting($: EngineInterface, armedAt: number): Promise<void> {
  const h = await read($, handoff)
  if (h.phase !== 'armed' || !h.waitAgents || h.armedAt !== armedAt) return
  const ids = await liveAgents($)
  await update($, handoff, () => ({ ...IDLE, snoozeTokens: h.snoozeTokens }))
  await tell($, `relay:等子 agent 返回等了 30 分钟,没有自动 /clear;交接在 ${h.path}`)
  void hlog($, `gave up after 30 min: ${ids.length} subagents ${ids.join(' ')} never returned`)
}

// Outside a GOAL / scheduled run (23.10): past the threshold at an answer's end, and nothing for delaySeconds — no
// message from owner, no turn — relay hands off in a turn of its own and clears as soon as it is written. Any prompt
// in between voids the wait; the next answer starts it again.
let idleGen = 0
async function scheduleIdle($: EngineInterface, cfg: Cfg): Promise<void> {
  if (cfg.threshold <= 0) return
  const h = await read($, handoff)
  if (h.phase !== 'idle' && h.phase !== 'due') return
  if (await isAuto($, await read($, turnKind))) return
  const tokens = await contextTokens($)
  if (tokens < cfg.threshold) return
  const gen = ++idleGen
  await update($, handoff, () => ({ ...h, phase: 'due' }))
  $.clock.after(cfg.delayMs, () => void idleHandoff($, gen).catch(() => undefined))
}

async function idleHandoff($: EngineInterface, gen: number): Promise<void> {
  if (gen !== idleGen || (await read($, turnRunning))) return
  const h = await read($, handoff)
  if (h.phase !== 'due') return
  const tokens = await contextTokens($)
  const path = await handoffPath($)
  const anchor = anchorOf((await read($, lastPerson))?.text ?? '')
  await update($, handoff, () => ({ ...h, phase: 'armed', path, armedAt: Date.now(), waitAgents: false, anchor, auto: true, by: IDLE_BY, retried: false }))
  void hlog($, `armed idle ${Math.round(tokens / 1000)}k ${path}`)
  submit($, await noteFor($, tokens, path, anchor))
}

// /relay go: a handoff turn of its own, after the last answer; cleared as soon as it is written.
async function go($: EngineInterface): Promise<string> {
  const h = await read($, handoff)
  if (h.phase === 'armed' || h.phase === 'ready') return `relay:交接已在进行(${h.phase}),交接文件 ${h.path}`
  const path = await handoffPath($)
  const anchor = anchorOf((await read($, lastPerson))?.text ?? '')
  const out = (await liveAgents($)).length
  await update($, handoff, () => ({ ...h, phase: 'armed', path, armedAt: Date.now(), waitAgents: false, anchor, auto: false, by: 'composer', retried: false }))
  submit($, await noteFor($, await contextTokens($), path, anchor))
  void hlog($, `armed go ${path}`)
  if (out > 0) $.ui.toast(`relay:${out} 个子 agent 在跑,交接写好后等它们回来、重写一次再 /clear`)
  return `relay:正在写交接到 ${path},写完立即 /clear;发任何消息即取消`
}

// D-4 / D-7: a cold session's handoff without a Claude request (no fork replay at write price). Waits for a fresh
// checkpoint, writes it with the GOAL, the plan file and git into the handoff file, then takes the usual clear path.
let coldBusy = false
let readHandoff: (() => Promise<{ phase: string; waitAgents: boolean; armedAt: number; clearAt: number; stage: string }>) | null = null
async function coldHandoff($: EngineInterface, cfg: Cfg): Promise<string> {
  const h = await read($, handoff)
  if (h.phase === 'armed' || h.phase === 'ready' || coldBusy) return `relay:交接已在进行,交接文件 ${h.path || await handoffPath($)}`
  coldBusy = true
  void runCold($, cfg)
    .catch(() => $.ui.toast('relay:冷交接出错,没有 /clear'))
    .finally(() => {
      coldBusy = false
    })
  return 'relay:冷交接:后台写 checkpoint(不发 Claude 请求),写完拼交接并 /clear,最多等 10 分钟;看输入框上方的进度'
}

async function runCold($: EngineInterface, cfg: Cfg): Promise<void> {
  void hlog($, 'cold start')
  await update($, goStage, () => 'flush')
  const ck = await flushCheckpoint($)
  await update($, goStage, () => '')
  const text = ck.ok ? await readText($, ck.path) : null
  if (!ck.ok || text === null) {
    $.ui.toast('relay:checkpoint 没在 10 分钟内写出来(或 continuity 不可用),不 /clear;交接留在上一份 checkpoint')
    void hlog($, `cold not cleared: checkpoint ${ck.path ? 'not written in time' : 'flushStart unavailable'}`)
    return
  }
  const sid = await $.session.id()
  const root = repoRoot(await $.session.cwd())
  const g = await read($, goal)
  const goalText = g ? await readText($, g.path) : null
  const planPath = `${await home($)}/.claude/mods-state/plan-${sid}.json`
  const plan = await readText($, planPath)
  const git = async (...args: string[]): Promise<string> => {
    const r = await $.process.run(['git', '-C', root, ...args]).catch(() => null)
    return r && r.exitCode === 0 ? r.stdout.trimEnd() || '(空)' : '(读不到)'
  }
  const path = await handoffPath($)
  const anchor = anchorOf((await read($, lastPerson))?.text ?? '')
  const md = [
    `relay-anchor: ${anchor}`,
    '# 冷交接(continuity checkpoint + 文件拼成,没有调模型)',
    '',
    `## checkpoint(${ck.path})`,
    text.trimEnd(),
    '',
    ...(g && goalText ? [`## 当前 GOAL(${g.path})`, goalText.trimEnd(), ''] : []),
    `## 计划文件(${planPath})`,
    plan === null ? '(没有)' : plan.trimEnd(),
    '',
    '## git log --oneline -10',
    await git('log', '--oneline', '-10'),
    '',
    '## git status --short',
    await git('status', '--short'),
    '',
  ].join('\n')
  try {
    await $.fs.write(path, md)
  } catch {
    $.ui.toast(`relay:冷交接没写进 ${path},不 /clear`)
    void hlog($, `cold not cleared: write failed ${path}`)
    return
  }
  const since = Date.now()
  const cur = await read($, handoff)
  await update($, handoff, () => ({ ...IDLE, snoozeTokens: cur.snoozeTokens, phase: 'ready', path, armedAt: since, anchor, by: COLD_BY }))
  void hlog($, `ready cold ${path}`)
  await clearWhenQuiet($, cfg, path, since, true)
}

// ---------------------------------------------------------------- /handoff: a shareable handoff, no clear

const TICK_MS = 120
// A quick step still shows its bar filling this long, so the rows read one by one.
const MIN_STEP_MS = 650
// The model step's bar creeps toward full on this scale while the fork writes.
const WRITE_SCALE_MS = 40_000
const BAR_W = 18
const SPIN = ['◐', '◓', '◑', '◒']
let shareBusy = false
let shareText = ''
let shareRunning = -1
let shareStepAt = 0
let shareTicker: { cancel: () => void } | null = null

async function patchShare($: EngineInterface, fn: (p: SharePanel) => SharePanel): Promise<void> {
  await update($, share, p => (p ? fn(p) : p))
}

async function shareTick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await patchShare($, p => {
    if (p.phase !== 'working') return p
    const steps = p.steps.map((st, k) => {
      if (k !== shareRunning || st.status !== 'run') return st
      const t = now - shareStepAt
      return k === 3
        ? { ...st, progress: Math.min(0.95, 1 - Math.exp(-t / WRITE_SCALE_MS)), detail: `${Math.round(t / 1000)} 秒` }
        : { ...st, progress: Math.min(0.9, t / MIN_STEP_MS) }
    })
    return { ...p, steps, tick: p.tick + 1 }
  })
}

// One step: its work, and at least MIN_STEP_MS of bar (the model step excepted).
async function shareStep<T>($: EngineInterface, i: number, work: () => Promise<T>, detail: (v: T) => string): Promise<T> {
  shareRunning = i
  shareStepAt = await $.clock.now()
  await patchShare($, p => ({ ...p, steps: p.steps.map((st, k) => (k === i ? { ...st, status: 'run', progress: 0.02 } : st)) }))
  const value = await work()
  const left = MIN_STEP_MS - ((await $.clock.now()) - shareStepAt)
  if (left > 0 && i !== 3) await $.clock.sleep(left)
  await patchShare($, p => ({ ...p, steps: p.steps.map((st, k) => (k === i ? { ...st, status: 'done', progress: 1, detail: detail(value) } : st)) }))
  return value
}

const tildeOf = (p: string, h: string): string => (h && p.startsWith(h) ? `~${p.slice(h.length)}` : p)

async function runShare($: EngineInterface): Promise<void> {
  if (shareBusy) return
  shareBusy = true
  let draftPath = ''
  const h = await home($)
  await update($, share, () => ({ phase: 'working', steps: freshSteps(), tick: 0, file: '', chars: 0, error: '', note: '' }))
  shareTicker?.cancel()
  shareTicker = $.clock.every(TICK_MS, () => void shareTick($).catch(() => undefined))
  try {
    const cwd = await $.session.cwd()
    const messages = await shareStep($, 0, () => $.session.messages(), ms => `${ms.length} 条消息`)
    const files = await shareStep(
      $,
      1,
      async () => {
        const kept: string[] = []
        for (const p of rankFiles(messages, h)) {
          if (kept.length >= 30) break
          if (await $.fs.exists(p).catch(() => false)) kept.push(p)
        }
        return kept
      },
      fs => `${fs.length} 个文件`,
    )
    const found = await shareStep($, 2, async () => ({ skills: skillsOf(messages), links: linksOf(messages) }), f => `${f.skills.length} 个技能/工具 · ${f.links.length} 个链接`)
    const g = { files: files.map(f => tildeOf(f, h)), ...found }
    const dir = `${h}/.claude/handoffs`
    await $.process.run(['mkdir', '-p', dir]).catch(() => undefined)
    const at = stamp(await $.clock.now())
    draftPath = `${dir}/share-${at}-draft.md`
    shareText = redact(draftText(tildeOf(cwd, h), messages, g))
    await $.fs.write(draftPath, shareText)
    await hlog($, `share start ${messages.length} messages, draft ${draftPath}`)
    const reply = await shareStep(
      $,
      3,
      async () => {
        const r = await $.model.fork({ prompt: sharePrompt(tildeOf(cwd, h), g) })
        return { r, ms: (await $.clock.now()) - shareStepAt }
      },
      ({ r, ms }) => (r.isAnswered ? `${Math.round(ms / 1000)} 秒` : '失败'),
    ).then(x => x.r)
    if (!reply.isAnswered) {
      throw new Error(
        reply.reason === 'nothing-to-fork'
          ? '这段会话还没有可分叉的上下文(刚 /clear 或还没答完一轮)'
          : reply.reason === 'api-error'
            ? `模型调用失败(${'status' in reply ? (reply.status ?? '?') : '?'})`
            : `没拿到交接(${reply.reason})`,
      )
    }
    const text = redact(unfence(reply.text))
    const saved = await shareStep(
      $,
      4,
      async () => {
        const path = `${dir}/share-${at}.md`
        await $.fs.write(path, `${text}\n`)
        if (String(await $.fs.read(path)).trim() !== text.trim()) throw new Error('存下的文件和写出的不一致')
        return path
      },
      p => p.split('/').pop() ?? '',
    )
    shareText = text
    await $.process.run(['rm', '-f', draftPath]).catch(() => undefined)
    await patchShare($, p => ({ ...p, phase: 'ready', file: saved, chars: text.length }))
    await hlog($, `share ok ${saved} ${text.length} chars`)
  } catch (err) {
    const why = String(err instanceof Error ? err.message : err).slice(0, 160)
    await patchShare($, p => ({
      ...p,
      phase: 'failed',
      steps: p.steps.map((st, k) => (k === shareRunning && st.status === 'run' ? { ...st, status: 'fail' } : st)),
      error: why,
      file: draftPath,
      note: draftPath ? '草稿已存:复制它,或重试' : '',
    }))
    await hlog($, `share failed at step ${shareRunning + 1}: ${why}`)
  } finally {
    shareTicker?.cancel()
    shareTicker = null
    shareRunning = -1
    shareBusy = false
  }
}

// WSL: clip.exe takes UTF-16LE as Unicode (UTF-8 comes out garbled; a BOM would land in the clipboard); wl-copy / xclip elsewhere.
async function copyShare($: EngineInterface): Promise<void> {
  const p = await read($, share)
  if (!p?.file || !shareText) return
  const script =
    'if command -v clip.exe >/dev/null; then iconv -f UTF-8 -t UTF-16LE "$1" | clip.exe; ' +
    'elif command -v wl-copy >/dev/null; then wl-copy < "$1"; elif command -v xclip >/dev/null; then xclip -selection clipboard < "$1"; else exit 3; fi'
  const r = await $.process.run(['bash', '-c', script, '_', p.file], { timeoutMs: 10_000 }).catch(() => null)
  await patchShare($, s => ({ ...s, note: r?.exitCode === 0 ? '已复制,贴进新会话或发给同事' : `复制没成功,文件在 ${s.file}` }))
}

export const register: Register = (on, options) => {
  const threshold = Number(options.thresholdTokens ?? 500_000)
  const delayMs = Math.max(5, Number(options.delaySeconds ?? 30)) * 1000
  const heartbeatMin = Math.max(1, Number(options.heartbeatMinutes ?? 25))
  const maxTurns = Math.max(1, Number(options.maxTurns ?? 200))
  const agentMap = agentEffortMap(String(options.subagentEffort ?? ''))
  const cfg: Cfg = { threshold, delayMs, heartbeatMin, maxTurns }
  handoffAt = threshold

  // F 稿 ④:`$.relay.handoff()`,给 board 第 2 行画交接倒计时。
  on('engine.create', async (_, e, next) => {
    const built = await next(e)
    return {
      ...built,
      relay: {
        handoff: async () => (readHandoff ? readHandoff() : { phase: 'idle', waitAgents: false, armedAt: 0, clearAt: 0, stage: '' }),
      },
    } as never
  })

  on('session.start', async ($, e, next) => {
    readHandoff = async () => {
      const h = await read($, handoff)
      return { phase: h.phase, waitAgents: h.waitAgents, armedAt: h.armedAt, clearAt: h.clearAt ?? 0, stage: await read($, goStage) }
    }
    await $.command.register({ name: 'ops', description: '列出待拍板事项、worktree、在跑的 MiniMax 片和磁盘余量' })
    await $.command.register({ name: 'handoff', description: '写一份可分享的交接 prompt(不清空会话):复制给同事或新窗口;交接并清空用 /relay go' })
    await $.command.register({ name: 'relay', description: 'relay:GOAL 续跑 status | stop | resume | open;go = 交接并清空;cancel 取消交接;now 不等倒计时现在 /clear', argumentHint: 'status|stop|resume|open|go|cancel|now' })
    // The handoff judge counts only sessions that ran this version (an open window keeps the version it started with).
    void hlog($, `start relay ${RELAY_VERSION}`)
    void checkDisk($)
    void restore($, cfg).catch(() => undefined)
    $.clock.every(DISK_TICK_MS, () => void checkDisk($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear owner typed himself drops the loop (the GOAL stays for /relay resume); relay's own keeps it.
    if (e.reason === 'clear' && !(await read($, selfClear)) && (await read($, mode)) === 'running') {
      await setMode($, 'idle', 'owner-clear')
      await persist($)
    }
    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    await update($, agents, list => [...list.filter(id => id !== e.agent_id), e.agent_id])
    await update($, agentTypes, m => ({ ...m, [e.agent_id]: e.agent_type }))
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const live = (e.background_tasks ?? []).filter(t => BG_TYPES.has(t.type) && BG_LIVE.has(t.status))
    await update($, bgTasks, () => live.map(t => ({ id: t.id, type: t.type, command: t.command || t.description || '' })))
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await update($, agents, list => list.filter(id => id !== e.agent_id))
    await update($, agentTypes, m => Object.fromEntries(Object.entries(m).filter(([id]) => id !== e.agent_id)))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || r.deny !== undefined) return r
    const kick = await read($, pendingKickoff)
    if (!kick) return r
    await update($, pendingKickoff, () => '')
    return { ...r, context: [...(r.context ?? []), midTurnKickoff(kick)] }
  })

  // Only the main loop raises turn.start; a subagent's run does not.
  on('turn.start', async ($, e, next) => {
    await update($, turnRunning, () => true)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Any prompt voids a pending idle handoff; the answer it gets starts the wait again.
    idleGen++
    const work = isWork(e.origin)
    if (!e.turnId) await update($, turnKind, () => e.origin.kind)
    if (!e.turnId) await update($, origin, () => (work ? 'work' : 'other'))
    // Typed over a running turn too (turnId set): his last word is his last word.
    if (byPerson(e.origin) && !e.command) {
      const at = await $.clock.now()
      await update($, lastPerson, () => ({ text: e.text, at }))
      await update($, unseen, () => [])
    }
    // INV-4: owner answers the owner fork by typing; that resumes the loop.
    if (byPerson(e.origin)) {
      await update($, idleStall, () => '')
      const g = await read($, goal)
      const m = await read($, mode)
      const md = g ? await readText($, g.path) : null
      if (g && md && parked(md).some(p => !p.isDone)) e = { ...e, context: [...(e.context ?? []), ownerReplyNote(g.path)] }
      // owner speaking ends a revive turn's watch: what follows is his.
      await update($, revive, () => null)
      if (g && (m === 'waiting-owner' || (m === 'running' && g.nudges > 0))) {
        await setMode($, 'running', m === 'running' ? undefined : 'continue')
        await saveGoal($, { ...g, nudges: 0, stuckCount: 0, lastEvent: 'owner 回复,继续' })
      }
    }

    if (threshold <= 0 || !work) return next(e)
    const h = await read($, handoff)

    // A message from the person while the clear waits, or while a /relay go handoff is written: keep the session.
    // An auto handoff he speaks into is not cancelled here: its anchor no longer matches, and it stops at HANDOFF-READY.
    if (byPerson(e.origin) && (h.phase === 'ready' || (h.phase === 'armed' && (!h.auto || h.by === IDLE_BY)))) {
      const tokens = await contextTokens($)
      await update($, handoff, () => ({ ...IDLE, snoozeTokens: tokens + SNOOZE_TOKENS }))
      void hlog($, `cancelled at ${h.phase}: owner spoke`)
      $.ui.toast(
        h.phase === 'ready'
          ? `relay:已取消自动 /clear,交接留在 ${h.path};上下文再长 100k 会再问一次`
          : 'relay:已取消 /relay go 的交接;要清空就再敲一次',
      )
      return next(e)
    }

    // The subagents that held the handoff back are all in: have it rewritten with their results.
    if (h.phase === 'armed' && h.waitAgents && (await liveAgents($)).length === 0) {
      await update($, handoff, () => ({ ...h, waitAgents: false, armedAt: Date.now() }))
      const note = `[relay] 子 agent 都已返回。把它们的结果并进交接,重写 ${h.path}(第一行仍单独写 relay-anchor: ${h.anchor}),写完回复最后一行单独写 HANDOFF-READY。`
      return next({ ...e, context: [...(e.context ?? []), note] })
    }

    // owner's own turn is never handed off: the next relay / background prompt is.
    if (byPerson(e.origin)) return next(e)
    const note = await armAuto($, e.origin.kind)
    return note ? next({ ...e, context: [...(e.context ?? []), note] }) : next(e)
    // Never hold a prompt back over a fault here.
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    await update($, turnRunning, () => false)
    await update($, goal, g => (g ? { ...g, waitGen: g.waitGen + 1 } : g))
    // The turn ended before another tool call: the kickoff goes as its own prompt, and this turn is not judged.
    const kick = await read($, pendingKickoff)
    if (kick) {
      await update($, pendingKickoff, () => '')
      submit($, kickoffPrompt(kick))
      return done
    }
    if (e.isAborted || e.reason !== 'answer') return done
    // Every answer after owner's last message is one he may not have seen; the /relay go handoff turn's own is not.
    const h = await read($, handoff)
    if (!(h.phase === 'armed' && (!h.auto || h.by === IDLE_BY))) {
      const said = { at: await $.clock.now(), origin: await read($, turnKind), text: withoutReady(e.answer) }
      await update($, unseen, list => [...list, said])
    }
    if (await handoffTurn($, cfg, e.answer)) return done
    void scheduleIdle($, cfg).catch(() => undefined)
    void (async () => {
      if (!(await reviveTurn($, e.answer))) await relayTurn($, cfg, e.answer)
    })().catch(() => $.ui.toast('relay:这一轮的 RELAY 处理出错,/relay status 看状态'))
    void idleTurn($, e.answer).catch(() => $.ui.toast('relay:空等兜底出错,/relay status 看状态'))
    return done
  })

  // INV-9 / D-12 / D-13: effort per phase on the main loop, per agent type for subagents;
  // after each switch, the cache the next request read is recorded (observation only).
  on('turn.step', async function* ($, e, next) {
    let want: Effort | null = null
    try {
      if (e.agentId) {
        const types = await read($, agentTypes)
        want = pickEffort({ isRunning: true, phase: '', table: {}, isSubagent: true, agentType: types[e.agentId], agentMap })
      } else {
        const g = await read($, goal)
        if (g) want = pickEffort({ isRunning: (await read($, mode)) === 'running', phase: g.phase, table: g.efforts as Record<string, Effort>, isSubagent: false, agentMap })
      }
    } catch {
      want = null
    }
    const sent = want ?? e.effort
    const loop = e.agentId ?? 'main'
    const prev = (await read($, lastEffort))[loop]
    const result = want && want !== e.effort ? yield* next({ ...e, effort: want }) : yield* next(e)
    if (sent !== undefined && String(sent) !== prev) {
      await update($, lastEffort, m => ({ ...m, [loop]: String(sent) }))
      if (prev !== undefined && result.usage) {
        const entry = { at: await $.clock.now(), loop, from: prev, to: String(sent), cacheRead: result.usage.cache_read_input_tokens, input: result.usage.input_tokens }
        const log = ((await $.store.get('effortSwitches').catch(() => undefined)) as unknown[] | undefined) ?? []
        await $.store.set('effortSwitches', [...log, entry].slice(-500)).catch(() => undefined)
      }
    }
    return result
  })

  // Claude Code ships a /goal of its own (a Stop-hook condition); relay answers it in its place (D-19).
  on('command.describe', { command: 'goal' }, async ($, e, next) => ({
    ...(await next(e)),
    description: 'relay:把一句话写成 GOAL.md 并立刻开跑(/goal clear 停)',
    argumentHint: '<一句话目标> | clear',
  }))

  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const line = e.args.trim()
    if (!line) return { text: await statusText($, cfg) }
    if (STOP_WORDS.has(line.toLowerCase())) {
      await stopRelay($, 'goal-clear')
      await next(e).catch(() => undefined)
      return { text: 'relay:已停自动续跑(GOAL 文件保留,/relay resume 接着跑)' }
    }
    void startGoal($, cfg, line, e.presentation).catch(() => $.ui.toast('relay:写 GOAL 出错,没有激活'))
    return { text: `relay:正在把「${short(line, 60)}」写成 GOAL.md,写完立刻开工。` }
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'relay:/goal 出错,没有激活' }))

  on('command.run', { command: 'relay' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'stop') {
      await stopRelay($, 'relay-stop')
      return { text: 'relay:已停自动续跑(GOAL 文件保留,/relay resume 接着跑)' }
    }
    if (arg === 'resume' || arg === 'resume force') return { text: await resumeRelay($, cfg, arg === 'resume force') }
    if (arg === 'go') return { text: await go($) }
    if (arg === 'coldhandoff') return { text: await coldHandoff($, cfg) }
    if (arg === 'cancel') return { text: await cancelHandoff($) }
    if (arg === 'now') return { text: await clearNow($, cfg) }
    if (arg === 'open') {
      const g = await read($, goal)
      await refreshView($, g ? await readText($, g.path) : null, threshold)
      const r = await $.ui.open({ id: PANE, title: 'GOAL' })
      return { text: r.isPlaced ? 'relay:GOAL 面板已打开' : 'relay:面板等终端变宽后显示' }
    }
    return { text: await statusText($, cfg) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const rows = paneRows({
      mode: await read($, mode),
      goal: await read($, goal),
      view: await read($, view),
      effort: (await read($, lastEffort)).main,
      maxTurns,
      columns: e.props.bodyColumns,
    })
    const color = { accent: 'claude', success: 'success', warning: 'warning', error: 'error', dim: undefined } as const
    return h(
      Box,
      { flexDirection: 'column' },
      ...rows.map(r =>
        h(Text, { wrap: 'truncate-end', ...(r.tone === 'dim' ? { dimColor: true } : r.tone ? { color: color[r.tone] } : {}), ...(r.isBold ? { bold: true } : {}) }, r.text || ' '),
      ),
    ) as RenderElement
  })

  // /handoff: a handoff of this chat for a teammate or another window, written beside the chat; no turn, no /clear.
  on('command.run', { command: 'handoff' }, async $ => {
    if (shareBusy) return { text: 'relay:交接正在写,看输入框上方' }
    void runShare($).catch(() => undefined)
    return { text: 'relay:正在写可分享的交接(不清空会话),看输入框上方的进度;要交接并清空用 /relay go' }
  })

  // Presses go to these hooks, not onPress: a closure lives one drawing and the band redraws every tick.
  on('ui.press', { plugin: 'relay', element: 'share-copy' }, async ($, e) => {
    await copyShare($)
    return { element: e.element }
  })
  on('ui.press', { plugin: 'relay', element: 'share-retry' }, async ($, e) => {
    void runShare($).catch(() => undefined)
    return { element: e.element }
  })
  on('ui.press', { plugin: 'relay', element: 'share-go' }, async ($, e) => {
    await update($, share, () => null)
    $.ui.toast(await go($))
    return { element: e.element }
  })
  on('ui.press', { plugin: 'relay', element: 'share-close' }, async ($, e) => {
    if (!shareBusy) await update($, share, () => null)
    return { element: e.element }
  })

  // Above the prompt: the /handoff steps, else the steps of a /relay go or auto handoff while it runs.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const p = await read($, share)
    const ho = await read($, handoff)
    const stage = await read($, goStage)
    const going = ho.phase === 'armed' || ho.phase === 'ready' || stage !== ''
    if (!p && !going) return next(e)
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const noop = (): undefined => undefined
    const tick = p?.tick ?? Math.floor((await $.clock.now()) / 300)
    const rows = (steps: SharePanel['steps']) =>
      steps.map((st, i) => {
        const b = bar(st.progress, BAR_W)
        const color = st.status === 'fail' ? 'error' : st.status === 'done' ? 'success' : 'claude'
        const icon = st.status === 'done' ? '✓' : st.status === 'fail' ? '✗' : st.status === 'run' ? (SPIN[tick % SPIN.length] ?? '◐') : '○'
        return h(
          Box,
          { key: `r${i}`, flexDirection: 'row', gap: 1 },
          h(Box, { width: 2 }, h(Text, st.status === 'wait' ? { dimColor: true } : { color }, icon)),
          h(Box, { width: 26 }, h(Text, { dimColor: st.status === 'wait', wrap: 'truncate-end' }, `${i + 1}. ${st.label}`)),
          h(Text, {}, h(Text, { color }, b.on), h(Text, { dimColor: true }, b.off)),
          h(Text, { dimColor: true, wrap: 'truncate-end' }, st.detail),
        )
      })
    const parts: RenderElement[] = []
    if (rest) parts.push(rest as RenderElement)
    if (p) {
      const title = p.phase === 'working' ? '写可分享的交接' : p.phase === 'ready' ? `交接写好了:${p.chars} 字` : '交接没写完'
      const tone = p.phase === 'failed' ? 'error' : p.phase === 'ready' ? 'success' : 'claude'
      parts.push(
        h(
          Box,
          { key: 'share', flexDirection: 'column' },
          h(Text, { bold: true, color: tone }, title),
          ...rows(p.steps),
          p.phase === 'failed' ? h(Text, { color: 'error' }, p.error) : null,
          p.file && p.phase !== 'working' ? h(Text, { dimColor: true, wrap: 'truncate-middle' }, `${p.phase === 'ready' ? '存在' : '草稿在'} ${p.file}`) : null,
          p.phase === 'working'
            ? null
            : h(
                Box,
                { flexDirection: 'row', gap: 1 },
                p.file ? h(Button, { key: 'share-copy', label: p.phase === 'ready' ? '复制交接' : '复制草稿', variant: 'primary', onPress: noop }) : null,
                p.phase === 'failed' ? h(Button, { key: 'share-retry', label: '重试', onPress: noop }) : null,
                p.phase === 'ready' ? h(Button, { key: 'share-go', label: '交接并清空(/relay go)', variant: 'secondary', onPress: noop }) : null,
                h(Button, { key: 'share-close', label: '关闭', role: 'dismiss', onPress: noop }),
              ),
          p.note ? h(Text, { dimColor: true }, p.note) : null,
        ) as RenderElement,
      )
    } else {
      parts.push(
        h(
          Box,
          { key: 'go', flexDirection: 'column' },
          h(Text, { bold: true, color: 'claude' }, ho.auto ? '自动交接中(发任何消息即取消)' : '交接并清空中(发任何消息即取消)'),
          ...rows(goSteps(ho.phase, stage)),
        ) as RenderElement,
      )
    }
    return h(Box, { flexDirection: 'column' }, ...parts) as RenderElement
  })

  on('command.run', { command: 'ops' }, async $ => {
    const h = await home($)
    const all = await delegateAllRuns($)
    const o: Ops = {
      diskFreeGb: await diskFree($),
      worktrees: await worktrees($, h),
      decisions: await decisions($).catch(() => []),
      runningRuns: (all ?? []).filter(r => r.state === 'running').map(r => r.label),
    }
    await update($, ops, () => o)
    const ho = await read($, handoff)
    const lines = [
      `D 盘剩余:${o.diskFreeGb ?? '读不到'} GB · 上下文 ${Math.round((await contextTokens($)) / 1000)}k / 交接阈值 ${Math.round(threshold / 1000)}k(${ho.phase})`,
      '',
      `待拍板(${o.decisions.length}):`,
      ...o.decisions.map((d, i) => `  ${i + 1}. ${short(d)}`),
      '',
      all === null
        ? '在跑的 run(所有 session):读不到(delegate 没装或没启用)'
        : `在跑的 run(所有 session,${o.runningRuns.length}):${o.runningRuns.join(' · ') || '无'}`,
      `worktree(${o.worktrees.length}):${o.worktrees.join(' · ') || '无'}`,
    ]
    return { text: lines.join('\n') }
  })
}
