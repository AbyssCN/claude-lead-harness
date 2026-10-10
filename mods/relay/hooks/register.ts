import { atom, read, update } from 'claude-code'
import type { CommandPresentation, EngineInterface, PromptOrigin, Register, RenderElement } from 'claude-code'

import type { Handoff, Ops, RelayGoal, RelayMode, RelayView } from '../types'
import { agentEffortMap, effortTable, pickEffort } from './effort'
import type { Effort } from './effort'
import {
  acceptFailPrompt,
  acceptance,
  appendLedger,
  checklist,
  continuePrompt,
  currentItem,
  endsAsking,
  goalPrompt,
  goalTitle,
  heartbeatPrompt,
  kickoffPrompt,
  ledger,
  ledgerLine,
  mmdd,
  noAcceptancePrompt,
  normalizeGoal,
  nudgePrompt,
  parseRelay,
  tail,
  waitInvalidPrompt,
} from './goal'
import type { ContextFile } from './goal'
import { paneRows } from './pane'
import { handoffNote, isReadyAnswer, openDecisionRows, openGoalNine, parseDf, resumePrompt, short } from './parse'

const ops = atom({ plugin: 'relay', key: 'ops' } as const, null)
const IDLE: Handoff = { phase: 'idle', path: '', armedAt: 0, snoozeTokens: 0, waitAgents: false }
const handoff = atom({ plugin: 'relay', key: 'handoff' } as const, IDLE)
const diskWarned = atom({ plugin: 'relay', key: 'diskWarned' } as const, false)
// Subagents of this session still running (Opus / Sonnet / Haiku, workflow agents);
// a /clear would drop them. External omd-lite runs are not counted: they survive it.
const agents = atom({ plugin: 'relay', key: 'agents' } as const, [])
const agentTypes = atom({ plugin: 'relay', key: 'agentTypes' } as const, {})
const turnRunning = atom({ plugin: 'relay', key: 'turnRunning' } as const, false)
// C-4: cue reads this.
const mode = atom({ plugin: 'relay', key: 'mode' } as const, 'idle')
const goal = atom({ plugin: 'relay', key: 'goal' } as const, null)
const view = atom({ plugin: 'relay', key: 'view' } as const, null)
const origin = atom({ plugin: 'relay', key: 'origin' } as const, 'work')
const lastEffort = atom({ plugin: 'relay', key: 'lastEffort' } as const, {})
const selfClear = atom({ plugin: 'relay', key: 'selfClear' } as const, false)

// userConfig paths and the disk guard; set once in register().
type Env = { reposDir: string; worktreePrefixes: RegExp | null; diskPath: string; diskMinGb: number; checkpointCommand: string[] }
const env: Env = { reposDir: '', worktreePrefixes: /^(omdl-|agent-)/, diskPath: '', diskMinGb: 50, checkpointCommand: [] }
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const csv = (s: string): string[] => s.split(',').map(x => x.trim()).filter(Boolean)
const DISK_TICK_MS = 5 * 60_000
const SNOOZE_TOKENS = 100_000
// While subagents or a turn still run at clear time, look again this often, up to the cap.
const RECHECK_MS = 15_000
const WAIT_CAP_MS = 30 * 60_000
// An omd-lite run with files touched this recently and no result yet counts as running.
const RUN_FRESH_MS = 20 * 60_000
// Prompts that carry on a session's work: typed, from the phone, a loop's wake-up.
const WORK_ORIGINS = new Set(['composer', 'bridge', 'scheduled-trigger', 'auto-continuation', 'task-notification'])
const FROM_PERSON = new Set(['composer', 'bridge'])
// Plugins whose prompts drive the loop: relay's own and delegate's wake-ups.
const WORK_PLUGINS = new Set(['relay', 'delegate'])
const STOP_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])
const PANE = 'relay-goal'
const PANE_MIN_COLUMNS = 110
const ACCEPT_TIMEOUT_MS = 10 * 60_000
const STUCK_TURNS = 3
// omd-lite run dirs touched this recently are read for this session's running runs.
const RUN_SCAN_MS = 48 * 3600_000

const isWork = (o: PromptOrigin): boolean =>
  WORK_ORIGINS.has(o.kind) || (o.kind === 'plugin' && 'name' in o && WORK_PLUGINS.has(String(o.name)))

// C-0 (delegate's noun), read defensively: delegate may not be installed; null when it is not.
type DelegateRunLike = { label: string; state: string }
async function delegateRuns($: EngineInterface): Promise<DelegateRunLike[] | null> {
  try {
    // Absent noun: `$.delegate` is undefined and the call throws, caught below.
    const runs = await $.delegate!.runs()
    return Array.isArray(runs) ? runs : null
  } catch {
    return null
  }
}

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME').catch(() => undefined)) || '.'
}

// `~` / `~/x` → $HOME-relative.
async function expand($: EngineInterface, p: string): Promise<string> {
  return p === '~' || p.startsWith('~/') ? `${await home($)}${p.slice(1)}` : p
}

// userConfig reposDir, default ~/repos: where repos and their sibling worktrees live.
async function reposDir($: EngineInterface): Promise<string> {
  return (await expand($, env.reposDir)) || `${await home($)}/repos`
}

// The repo the session is in: <reposDir>/<name> when cwd is under reposDir, else cwd itself.
async function repoRoot($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const rd = await reposDir($)
  if (!cwd.startsWith(`${rd}/`)) return cwd
  return `${rd}/${cwd.slice(rd.length + 1).split('/')[0]}`
}

// userConfig diskPath, default the session's repo.
async function diskPath($: EngineInterface): Promise<string> {
  return (await expand($, env.diskPath)) || (await repoRoot($))
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
    const r = await $.process.run(['df', '-BG', '--output=avail', await diskPath($)], { timeoutMs: 5000 })
    return r.exitCode === 0 ? parseDf(r.stdout) : null
  } catch {
    return null
  }
}

async function checkDisk($: EngineInterface): Promise<void> {
  const free = await diskFree($)
  const low = free !== null && env.diskMinGb > 0 && free < env.diskMinGb
  if (low && !(await read($, diskWarned))) {
    $.ui.toast(`磁盘只剩 ${free} GB(满盘可能拖垮整个环境):先清 worktree / 构建缓存,/ops 看清单`)
  }
  await update($, diskWarned, () => low)
}

// Worktrees the dispatch scripts leave beside the repos (names matching userConfig worktreePrefixes)
// plus Claude's own under every repo's .claude/worktrees.
async function worktrees($: EngineInterface): Promise<string[]> {
  const rd = await reposDir($)
  const out: string[] = []
  const repos: string[] = []
  try {
    for (const d of await $.fs.list(rd)) {
      if (d.kind !== 'dir') continue
      if (env.worktreePrefixes?.test(d.name)) out.push(d.name)
      else repos.push(d.name)
    }
  } catch {
    // No reposDir.
  }
  for (const repo of repos) {
    try {
      for (const d of await $.fs.list(`${rd}/${repo}/.claude/worktrees`)) if (d.kind === 'dir') out.push(`${repo}/${d.name}`)
    } catch {
      // That repo has none.
    }
  }
  return out
}

async function runningRuns($: EngineInterface, h: string, now: number): Promise<string[]> {
  const out: string[] = []
  try {
    for (const d of await $.fs.list(`${h}/.omd-lite/runs`)) {
      if (d.kind !== 'dir' || now - d.mtimeMs > RUN_FRESH_MS) continue
      const files = await $.fs.list(`${h}/.omd-lite/runs/${d.name}`).catch(() => [])
      if (files.some(f => f.name === 'result.json')) continue
      if (now - Math.max(d.mtimeMs, ...files.map(f => f.mtimeMs)) < RUN_FRESH_MS) out.push(d.name)
    }
  } catch {
    // omd-lite never ran here.
  }
  return out
}

// The repo's DECISIONS-PENDING rows and the newest GOAL.md's §9.
async function decisions($: EngineInterface): Promise<string[]> {
  const root = await repoRoot($)
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
  const name = (await repoRoot($)).split('/').pop() || 'session'
  const id = (await $.session.id()).slice(0, 8)
  return `${h}/.claude/handoffs/${name}-${id}.md`
}

async function contextTokens($: EngineInterface): Promise<number> {
  const usage = await $.session.usage().catch(() => null)
  return usage?.context.tokens ?? 0
}

// The newest docs/plan/*/GOAL.md and every LOOP-GOAL.md under docs/plan (three levels down), for the resume prompt.
async function goalFiles($: EngineInterface): Promise<string[]> {
  const plan = `${await repoRoot($)}/docs/plan`
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

const WRITER_TIMEOUT_MS = 6 * 60_000

// Writes the omd checkpoint once more, synchronously, so the new session reads the state at clear time
// rather than the last 100k boundary. Runs userConfig checkpointCommand (e.g. the same writer omd's
// PreCompact hook runs) with {transcript} / {session} filled in; skipped when unset. Fails open.
async function flushCheckpoint($: EngineInterface): Promise<boolean> {
  if (!env.checkpointCommand.length) return false
  const h = await home($)
  const id = await $.session.id()
  let transcript: string | null = null
  for (const d of await $.fs.list(`${h}/.claude/projects`).catch(() => [])) {
    const p = `${h}/.claude/projects/${d.name}/${id}.jsonl`
    if (d.kind === 'dir' && (await $.fs.exists(p))) {
      transcript = p
      break
    }
  }
  if (!transcript) return false
  try {
    const argv = await Promise.all(
      env.checkpointCommand.map(a => expand($, a.replace(/\{transcript\}/g, transcript).replace(/\{session\}/g, id))),
    )
    const r = await $.process.run(argv, {
      cwd: await $.session.cwd(),
      timeoutMs: WRITER_TIMEOUT_MS,
    })
    return r.exitCode === 0
  } catch {
    return false
  }
}

// omd continuity hook 把每个 session 的 checkpoint 写在 ~/.omd/projects/<项目>/session/<session id>/checkpoint.md;
// 项目名由 omd 按 cwd 推,这里不复刻那套规则,直接按 session id 找。
async function findCheckpoint($: EngineInterface, sessionId: string): Promise<string | null> {
  const root = `${await home($)}/.omd/projects`
  try {
    for (const d of await $.fs.list(root)) {
      if (d.kind !== 'dir') continue
      const p = `${root}/${d.name}/session/${sessionId}/checkpoint.md`
      if (await $.fs.exists(p)) return p
    }
  } catch {
    // omd 没装或目录不在:只用交接
  }
  return null
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

async function setMode($: EngineInterface, m: RelayMode): Promise<void> {
  await update($, mode, () => m)
}

async function saveGoal($: EngineInterface, g: RelayGoal): Promise<void> {
  await update($, goal, () => g)
  await persist($)
}

// A prompt relay sends: the turn it starts is a work turn relay reacts to.
function submit($: EngineInterface, text: string): void {
  void (async () => {
    await update($, origin, () => 'work')
    await $.prompt.submit({ text, asUser: true })
  })().catch(() => $.ui.toast('relay:续跑 prompt 没发出去,/relay resume 重试'))
}

async function tell($: EngineInterface, text: string): Promise<void> {
  $.ui.toast(text)
  await $.ui.notify(text, { title: 'relay' }).catch(() => undefined)
}

// Stops driving: owner fork, budget, stuck, done. Never submits.
async function halt($: EngineInterface, m: RelayMode, why: string): Promise<void> {
  const g = await read($, goal)
  await setMode($, m)
  if (g) await saveGoal($, { ...g, lastEvent: why })
  else await persist($)
  await tell($, `relay:${why}`)
}

async function gitHead($: EngineInterface): Promise<string> {
  try {
    const r = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd: await $.session.cwd(), timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

// omd-lite runs of this session still going: meta.json names the session and has no wall_seconds yet.
async function sessionRuns($: EngineInterface): Promise<string[]> {
  const root = `${await home($)}/.omd-lite/runs`
  const id = await $.session.id()
  const now = await $.clock.now()
  const out: string[] = []
  for (const d of await $.fs.list(root).catch(() => [])) {
    if (d.kind !== 'dir' || now - d.mtimeMs > RUN_SCAN_MS) continue
    const text = await readText($, `${root}/${d.name}/meta.json`)
    if (!text) continue
    try {
      const meta = JSON.parse(text) as { claude_session?: string; wall_seconds?: number | null }
      if (meta.claude_session === id && (meta.wall_seconds === undefined || meta.wall_seconds === null)) out.push(d.name)
    } catch {
      // A meta.json mid-write.
    }
  }
  return out
}

// INV-12: what a phase=wait could be waiting on — running external runs plus running subagents.
async function waitingOn($: EngineInterface): Promise<number> {
  const subs = (await read($, agents)).length
  const runs = await delegateRuns($)
  if (runs) return subs + runs.filter(r => r.state === 'running').length
  return subs + (await sessionRuns($)).length
}

async function runsSummary($: EngineInterface): Promise<string | null> {
  const runs = await delegateRuns($)
  if (runs) {
    const by = new Map<string, number>()
    for (const r of runs) by.set(r.state, (by.get(r.state) ?? 0) + 1)
    return [...by].map(([s, n]) => `${s} ${n}`).join(' · ') || '无'
  }
  const mine = await sessionRuns($)
  return mine.length ? `${mine.length} 个在跑:${mine.join(' · ')}` : '本 session 无在跑'
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
    diskMinGb: env.diskMinGb,
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
async function writeGoalText($: EngineInterface, prompt: string): Promise<string | null> {
  const forked = await $.model.fork({ prompt })
  if (forked.isAnswered) return forked.text
  if (forked.reason !== 'nothing-to-fork') return null
  const model = await $.session.model()
  const done = await $.model.complete({ model, prompt, maxTokens: 8000 })
  return done.isAnswered ? done.text : null
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
    lastEvent: '已激活',
  }
}

type Cfg = { threshold: number; delayMs: number; heartbeatMin: number; maxTurns: number }

// Clears only when no subagent and no turn is running; checks again until the cap.
async function clearWhenQuiet($: EngineInterface, cfg: Cfg, path: string, since: number): Promise<void> {
  const h = await read($, handoff)
  if (h.phase !== 'ready') return
  const out = (await read($, agents)).length
  if (out > 0 || (await read($, turnRunning))) {
    if (Date.now() - since > WAIT_CAP_MS) {
      await update($, handoff, () => ({ ...IDLE, snoozeTokens: h.snoozeTokens }))
      $.ui.toast(`relay:等了 30 分钟仍有 ${out} 个子 agent 或一轮在跑,没有自动 /clear;交接在 ${path}`)
      return
    }
    $.clock.after(RECHECK_MS, () => void clearWhenQuiet($, cfg, path, since))
    return
  }
  // 补存 checkpoint 要几十秒到几分钟:补存时仍是 ready,期间用户发消息照样能取消;
  // 补完再看一次 —— 被取消了就不 clear,又有一轮 / 子 agent 起来了就回到等安静。
  const flushing = env.checkpointCommand.length > 0
  if (flushing) $.ui.toast('relay:先补存一次 omd checkpoint,写完就 /clear')
  const flushed = await flushCheckpoint($)
  if ((await read($, handoff)).phase !== 'ready') return
  if ((await read($, agents)).length > 0 || (await read($, turnRunning))) {
    $.clock.after(RECHECK_MS, () => void clearWhenQuiet($, cfg, path, since))
    return
  }
  await update($, handoff, () => IDLE)
  if (flushing && !flushed) $.ui.toast('relay:checkpoint 补存没成功,照旧用上一份')
  const checkpoint = await findCheckpoint($, await $.session.id())
  const goals = await goalFiles($).catch(() => [])
  // D-20: carry the active GOAL across the clear and re-arm it in the new session.
  const m = await read($, mode)
  const g = await read($, goal)
  const carry = g && (m === 'running' || m === 'waiting-owner') ? { mode: m, goal: g } : null
  await update($, selfClear, () => true)
  await $.command.run({ command: 'clear' })
  await update($, selfClear, () => false)
  if (carry) {
    await setMode($, carry.mode)
    await saveGoal($, { ...carry.goal, sessionId: await $.session.id(), nudges: 0, lastEvent: '交接后接上' })
  }
  await update($, origin, () => 'work')
  await $.prompt.submit({
    text: resumePrompt(path, checkpoint, goals.filter(p => p !== carry?.goal.path), carry ? { path: carry.goal.path, phase: carry.goal.phase } : null),
    asUser: true,
  })
}

async function statusText($: EngineInterface, cfg: Cfg): Promise<string> {
  const m = await read($, mode)
  const g = await read($, goal)
  if (!g) return `relay:${m},没有激活的 GOAL。/goal <一句话> 开一个。`
  return [
    `relay:${m} · ${g.title || g.path}`,
    `GOAL ${g.path}`,
    `phase ${g.phase} · 当前项 ${g.item || '(清单已全勾)'} · 轮次 ${g.turns}/${cfg.maxTurns} · 连续违规 ${g.nudges}`,
    `最近:${g.lastEvent}`,
  ].join('\n')
}

async function startGoal($: EngineInterface, cfg: Cfg, line: string, p: CommandPresentation | null): Promise<void> {
  $.ui.status('relay:正在写 GOAL.md…')
  try {
    const cwd = await $.session.cwd()
    const now = await $.clock.now()
    const day = mmdd(now)
    const raw = await writeGoalText($, goalPrompt(line, await contextFiles($, cwd), day))
    if (!raw) {
      await tell($, 'relay:GOAL 没写出来(模型没有回答),没有激活;再 /goal 一次')
      return
    }
    const md = normalizeGoal(raw, line)
    const path = await freePath($, `${cwd}/docs/plan/${day}`)
    await $.fs.write(path, md)
    const prior = await read($, goal)
    if (prior && prior.path !== path && (await read($, mode)) === 'running') $.ui.toast(`relay:新 GOAL 取代 ${prior.path}`)
    await update($, goal, () => freshGoal(path, md, '', now))
    const sid = await $.session.id()
    await update($, goal, g => (g ? { ...g, sessionId: sid } : g))
    await setMode($, 'running')
    await persist($)
    await refreshView($, md, cfg.threshold)
    await openPane($, p)
    submit($, kickoffPrompt(path))
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
  await halt($, 'done', `GOAL 验收全过(${list.length} 条):${g.title || g.path}`)
}

// One main-loop work turn ended while relay drives: read its RELAY line and act (C-2).
async function relayTurn($: EngineInterface, cfg: Cfg, answer: string): Promise<void> {
  if ((await read($, mode)) !== 'running') return
  if ((await read($, origin)) !== 'work') return
  const g0 = await read($, goal)
  if (!g0) return
  const md = await readText($, g0.path)
  if (md === null) {
    await halt($, 'waiting-owner', `GOAL 文件读不到:${g0.path}`)
    return
  }
  const g: RelayGoal = { ...g0, turns: g0.turns + 1, title: goalTitle(md) || g0.title, item: currentItem(md), efforts: effortTable(md) }
  await refreshView($, md, cfg.threshold)
  if (g.turns > cfg.maxTurns) {
    await saveGoal($, g)
    await halt($, 'waiting-owner', `GOAL 已跑满 ${cfg.maxTurns} 轮(maxTurns),停下等你`)
    return
  }
  const r = parseRelay(answer)
  // D-14: no RELAY line, or a continue that ends on a question / options.
  if (r.kind === 'none' || (r.kind === 'continue' && endsAsking(answer))) {
    const nudges = g.nudges + 1
    await saveGoal($, { ...g, nudges, lastEvent: `违规结尾 ${nudges}` })
    if (nudges >= 2) await halt($, 'waiting-owner', '连续两轮没有 RELAY 行(或停在问句 / 选项),已停;回一句话就接着跑')
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
          submit($, waitInvalidPrompt(ok.path))
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
        await halt($, 'waiting-owner', `卡住:「${short(ok.item || phase, 40)}」${STUCK_TURNS} 轮没有新提交`)
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
      await saveGoal($, ok)
      await halt($, 'waiting-owner', `等你拍板:${r.question || '(没写问题)'}`)
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

async function stopRelay($: EngineInterface, cfg: Cfg): Promise<void> {
  await setMode($, 'idle')
  const g = await read($, goal)
  if (g) await saveGoal($, { ...g, lastEvent: '已停(/relay stop)' })
}

async function resumeRelay($: EngineInterface, cfg: Cfg): Promise<string> {
  let g = await read($, goal)
  if (!g) {
    const saved = (await $.store.get(await storeKey($)).catch(() => undefined)) as Saved | undefined
    g = saved?.goal ?? null
  }
  if (!g) return 'relay:没有可续的 GOAL。/goal <一句话> 开一个。'
  if (!(await $.fs.exists(g.path).catch(() => false))) return `relay:GOAL 文件不在了:${g.path}`
  await setMode($, 'running')
  await saveGoal($, { ...g, nudges: 0, stuckCount: 0, sessionId: await $.session.id(), lastEvent: '续跑(/relay resume)' })
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
  if (saved.goal.sessionId === sid) {
    await setMode($, saved.mode)
    $.ui.toast(`relay:接上 GOAL ${saved.goal.path}(${saved.mode})`)
  } else {
    $.ui.toast(`relay:${saved.goal.path} 还没做完;/relay resume 在这个 session 接着跑`)
  }
}

// The handoff's part of a turn's end; true when the turn belongs to the handoff and relay keeps out.
async function handoffTurn($: EngineInterface, cfg: Cfg, answer: string): Promise<boolean> {
  const h = await read($, handoff)
  if (h.phase === 'ready') return true
  if (h.phase !== 'armed' || !isReadyAnswer(answer)) return false
  const out = (await read($, agents)).length
  if (out > 0) {
    await update($, handoff, () => ({ ...h, waitAgents: true }))
    $.ui.toast(`relay:交接写了,但还有 ${out} 个子 agent 没返回;等它们回来、交接重写后再 clear`)
    return true
  }
  const st = await $.fs.stat(h.path).catch(() => null)
  if (!st || st.mtimeMs < h.armedAt - 1000) {
    $.ui.toast(`relay:说交接写好了,但 ${h.path} 没有新内容,不自动 /clear`)
    return true
  }
  await update($, handoff, () => ({ ...h, phase: 'ready' }))
  $.ui.toast(`relay:交接已写到 ${h.path}。${Math.round(cfg.delayMs / 1000)} 秒后自动 /clear 并接着做;发任何消息即取消`)
  const since = Date.now()
  $.clock.after(cfg.delayMs, () => void clearWhenQuiet($, cfg, h.path, since))
  return true
}


export const register: Register = (on, options) => {
  const threshold = Number(options.thresholdTokens ?? 500_000)
  const delayMs = Math.max(5, Number(options.delaySeconds ?? 30)) * 1000
  const heartbeatMin = Math.max(1, Number(options.heartbeatMinutes ?? 25))
  const maxTurns = Math.max(1, Number(options.maxTurns ?? 200))
  const agentMap = agentEffortMap(String(options.subagentEffort ?? ''))
  const cfg: Cfg = { threshold, delayMs, heartbeatMin, maxTurns }
  env.reposDir = String(options.reposDir ?? '').trim()
  const prefixes = csv(String(options.worktreePrefixes ?? 'omdl-,agent-'))
  env.worktreePrefixes = prefixes.length ? new RegExp(`^(${prefixes.map(escapeRe).join('|')})`) : null
  env.diskPath = String(options.diskPath ?? '').trim()
  env.diskMinGb = Math.max(0, Number(options.diskMinGB ?? 50))
  env.checkpointCommand = String(options.checkpointCommand ?? '').trim().split(/\s+/).filter(Boolean)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ops', description: '列出待拍板事项、worktree、在跑的 omd-lite run 和磁盘余量' })
    await $.command.register({ name: 'relay', description: 'relay:GOAL 续跑 status | stop | resume | open', argumentHint: 'status|stop|resume|open' })
    void checkDisk($)
    void restore($, cfg).catch(() => undefined)
    $.clock.every(DISK_TICK_MS, () => void checkDisk($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear the user typed drops the loop (the GOAL stays for /relay resume); relay's own keeps it.
    if (e.reason === 'clear' && !(await read($, selfClear)) && (await read($, mode)) === 'running') {
      await setMode($, 'idle')
      await persist($)
    }
    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    await update($, agents, list => [...list.filter(id => id !== e.agent_id), e.agent_id])
    await update($, agentTypes, m => ({ ...m, [e.agent_id]: e.agent_type }))
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await update($, agents, list => list.filter(id => id !== e.agent_id))
    await update($, agentTypes, m => Object.fromEntries(Object.entries(m).filter(([id]) => id !== e.agent_id)))
    return next(e)
  })

  // Only the main loop raises turn.start; a subagent's run does not.
  on('turn.start', async ($, e, next) => {
    await update($, turnRunning, () => true)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const work = isWork(e.origin)
    if (!e.turnId) await update($, origin, () => (work ? 'work' : 'other'))
    // INV-4: the owner answers the owner fork by typing; that resumes the loop.
    if (FROM_PERSON.has(e.origin.kind)) {
      const g = await read($, goal)
      const m = await read($, mode)
      if (g && (m === 'waiting-owner' || (m === 'running' && g.nudges > 0))) {
        await setMode($, 'running')
        await saveGoal($, { ...g, nudges: 0, stuckCount: 0, lastEvent: 'owner 回复,继续' })
      }
    }

    if (threshold <= 0 || !work) return next(e)
    const h = await read($, handoff)

    // The subagents that held the handoff back are all in: have it rewritten with their results.
    if (h.phase === 'armed' && h.waitAgents && (await read($, agents)).length === 0) {
      await update($, handoff, () => ({ ...h, waitAgents: false, armedAt: Date.now() }))
      const note = `[relay] 子 agent 都已返回。把它们的结果并进交接,重写 ${h.path},写完回复最后一行单独写 HANDOFF-READY。`
      return next({ ...e, context: [...(e.context ?? []), note] })
    }

    // A message from the person while the clear waits: keep the session.
    if (h.phase === 'ready' && FROM_PERSON.has(e.origin.kind)) {
      const tokens = await contextTokens($)
      await update($, handoff, () => ({ ...IDLE, snoozeTokens: tokens + SNOOZE_TOKENS }))
      $.ui.toast(`relay:已取消自动 /clear,交接留在 ${h.path};上下文再长 100k 会再问一次`)
      return next(e)
    }
    if (h.phase !== 'idle') return next(e)

    const tokens = await contextTokens($)
    if (tokens < threshold || tokens < h.snoozeTokens) return next(e)
    const path = await handoffPath($)
    await update($, handoff, () => ({ ...h, phase: 'armed', path, armedAt: Date.now() }))
    return next({ ...e, context: [...(e.context ?? []), handoffNote(tokens, path)] })
    // Never hold a prompt back over a fault here.
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    await update($, turnRunning, () => false)
    await update($, goal, g => (g ? { ...g, waitGen: g.waitGen + 1 } : g))
    if (e.isAborted || e.reason !== 'answer') return done
    if (await handoffTurn($, cfg, e.answer)) return done
    void relayTurn($, cfg, e.answer).catch(() => $.ui.toast('relay:这一轮的 RELAY 处理出错,/relay status 看状态'))
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
      await stopRelay($, cfg)
      await next(e).catch(() => undefined)
      return { text: 'relay:已停自动续跑(GOAL 文件保留,/relay resume 接着跑)' }
    }
    void startGoal($, cfg, line, e.presentation).catch(() => $.ui.toast('relay:写 GOAL 出错,没有激活'))
    return { text: `relay:正在把「${short(line, 60)}」写成 GOAL.md,写完立刻开工。` }
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'relay:/goal 出错,没有激活' }))

  on('command.run', { command: 'relay' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'stop') {
      await stopRelay($, cfg)
      return { text: 'relay:已停自动续跑(GOAL 文件保留,/relay resume 接着跑)' }
    }
    if (arg === 'resume') return { text: await resumeRelay($, cfg) }
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

  on('command.run', { command: 'ops' }, async $ => {
    const h = await home($)
    const o: Ops = {
      diskFreeGb: await diskFree($),
      worktrees: await worktrees($),
      decisions: await decisions($).catch(() => []),
      runningRuns: await runningRuns($, h, Date.now()),
    }
    await update($, ops, () => o)
    const ho = await read($, handoff)
    const lines = [
      `磁盘剩余(${await diskPath($)}):${o.diskFreeGb ?? '读不到'} GB · 上下文 ${Math.round((await contextTokens($)) / 1000)}k / 交接阈值 ${Math.round(threshold / 1000)}k(${ho.phase})`,
      '',
      `待拍板(${o.decisions.length}):`,
      ...o.decisions.map((d, i) => `  ${i + 1}. ${short(d)}`),
      '',
      `在跑的 omd-lite run(${o.runningRuns.length}):${o.runningRuns.join(' · ') || '无'}`,
      `worktree(${o.worktrees.length}):${o.worktrees.join(' · ') || '无'}`,
    ]
    return { text: lines.join('\n') }
  })
}
