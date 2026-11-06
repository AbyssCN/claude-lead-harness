import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CueSet } from '../types'
import type { Cue, ForkLog, PickLog, PopLog, ShadowLog, VetLog } from './seat'
import { ALT, DROP, PREV, PROMPT_VERSION, SEND, clip, editKind, editRatio, enhancePrompt, isPlanningTier, oneLine, parseReply, popupOutcome, popupQuestion, seatPrompt, stats } from './seat'
import type { Category, Evidence, Route } from './vet'
import { AUTO_SEND_MS, CATEGORY_NAME, MAX_AUTO_CHAIN, nextParkNumber, parkInto, parseVet, route, rulingLines, sensitiveWords, tail, vetPrompt } from './vet'

const current = atom({ plugin: 'cue', key: 'current' } as const, null)
const relayMode = { plugin: 'relay', key: 'mode' } as const

const KEEP = 2000 // log entries kept per kind
const PREVIEW = 60
const HEAD = 200 // answer characters kept per shadow row, enough to label it later
// Shadow rows per seat-prompt version. Sessions still on the v1 code keep writing 'shadow' until
// they reload, so every v2 session start folds whatever is there into the sealed 'shadow-v1'.
const SHADOW = 'shadow-v2'
const LEGACY_SHADOW = 'shadow'
const SEALED_SHADOW = 'shadow-v1'

// C-4: silent while relay drives. Relay not installed / unreadable → idle.
async function relayRunning($: EngineInterface): Promise<boolean> {
  try {
    const { value } = await $.state.get(relayMode)
    return value === 'running'
  } catch {
    return false
  }
}

async function commands($: EngineInterface) {
  const all = await $.command.list()
  const known = new Set(all.map(c => c.name))
  const menu = all.filter(c => c.source !== 'mcp' && c.source !== 'builtin').map(c => c.name)
  return { known, menu }
}

async function append<T>($: EngineInterface, key: string, entry: T) {
  const list = ((await $.store.get(key)) as T[] | undefined) ?? []
  list.push(entry)
  await $.store.set(key, list.slice(-KEEP))
}

/** One generation: fork (or haiku), usage logged, reply parsed into cues and the fork's tier. */
async function generate($: EngineInterface, engine: string, kind: ForkLog['kind'], prompt: string, known: Set<string>, max: number) {
  const useHaiku = engine === 'haiku'
  const reply = useHaiku
    ? await $.model.complete({ model: 'haiku', prompt, maxTokens: 1500 })
    : await $.model.fork({ prompt })
  if ('usage' in reply) {
    const u = reply.usage
    const entry: ForkLog = {
      ts: await $.clock.now(),
      kind,
      engine: useHaiku ? 'haiku' : 'fork',
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens,
    }
    await append($, 'forks', entry)
  }
  return reply.isAnswered ? parseReply(reply.text, known, max) : { cues: [], tier: null, tierReason: null }
}

async function fillAndLog($: EngineInterface, slot: PickLog['slot'], text: string) {
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  if (!filled.isFilled) return false
  await append<PickLog>($, 'picks', { ts: await $.clock.now(), slot, text, v: PROMPT_VERSION })
  return true
}

// The band (AbovePrompt) is raised on the terminal and desktop only; a phone gets the engine's
// AskUserQuestion dialog instead, which every attached surface draws.
async function wantsPopup($: EngineInterface, popup: string): Promise<boolean> {
  if (popup === 'off') return false
  if (popup === 'always') return true
  return (await $.session.surfaces()).includes('mobile')
}

const AUTO = Symbol('auto')
const DROPPED = Symbol('dropped')

/**
 * The phone popup. Runs detached from turn.complete: the dialog may stay open for minutes, and a
 * submit waits for idle. `live()` is false once a newer prompt went in: a late answer sends nothing.
 * `overtaken()` is true once a newer cue was made: a late 发送 / 方向 B sends nothing (Other is owner's own words).
 */
async function ask($: EngineInterface, set: CueSet, live: () => boolean, overtaken: () => boolean, pops: Popups, auto: boolean) {
  const prev = pops.prev
  pops.prev = null
  const { question, clipped } = popupQuestion(set.items, prev)
  if (clipped) {
    set.items.forEach((c, i) => $.ui.log(`cue · ${i === 0 ? 'Enhance' : ALT} · ${c.title}(全文)\n${c.prompt}`))
  }
  const labels = [SEND, ...(set.items.length > 1 ? [ALT] : []), ...(prev ? [PREV] : []), DROP]
  // A turn owner did not start: unanswered for five minutes, the first prompt goes by itself. Its submit is what
  // takes the dialog down (the engine answers an open dialog when a message comes in).
  // Sent first, logged after: a tap racing the timer is only lost for the length of the submit. A send that did not
  // go in leaves the dialog up and answerable, as if the timer had not fired.
  let firing: Promise<boolean> | null = null
  let dropped = false
  const fire = () => {
    // The session moved on while the dialog sat unanswered (a later turn ran: plugin deliveries leave the dialog up).
    // Nothing to send, and only cue can take its own dialog down; left up it holds the session.
    if (!live() || overtaken()) {
      dropped = true
      endAsk(DROPPED)
      pops.closeOpen?.()
      $.ui.log(`cue · 5 分钟到了，这期间会话又往前走了,「${set.items[0]!.title}」不发了，框已关`)
      return
    }
    const c = set.items[0]!
    // Only a submitted prompt takes the dialog down; a command run leaves it open (seen 2.11 in a live session).
    const text = autoText(c.prompt)
    pops.autoText = text
    firing = (async () => {
      // A submitted prompt leaves the dialog up (seen 2.11 in a live session): cue's own tool.call hook answers it first.
      pops.closeOpen?.()
      const ok = await send($, text)
      // prompt.submit's hooks have run by the time it resolves; a command raises none.
      if (pops.autoText === text) pops.autoText = null
      if (!ok) {
        await append<PopLog>($, 'popups', { ts: await $.clock.now(), action: 'stale', v: PROMPT_VERSION, text: c.prompt, tapped: false })
        const box = await $.prompt.read().catch(() => null)
        const filled = box !== null && box.text.trim() === '' && (await $.prompt.fill({ text: c.prompt, mode: 'replace' }).then((r) => r.isFilled).catch(() => false))
        $.ui.log(`cue · 5 分钟到了，想自动发「${c.title}」但没发进去,没替你发${filled ? ';已放回输入框' : ',原文:\n' + c.prompt}`)
        return true
      }
      pops.chain++
      await append<PopLog>($, 'popups', { ts: await $.clock.now(), action: 'auto', v: PROMPT_VERSION, text })
      await update($, current, () => null)
      $.ui.log(`cue · 5 分钟没人点，自动发出了「${c.title}」`)
      endAsk(AUTO)
      return true
    })()
  }
  // Sent by itself, or dropped: done with this card even if the dialog stayed up, so the next card is not held behind it.
  let endAsk: (how: typeof AUTO | typeof DROPPED) => void = () => {}
  const ended = new Promise<typeof AUTO | typeof DROPPED>((r) => { endAsk = r })
  const timer = auto ? $.clock.after(AUTO_SEND_MS, fire) : null
  let answer: string | null
  try {
    const got = await Promise.race([$.ui.ask(question, { header: 'cue', options: labels }), ended])
    if (got === AUTO) return
    answer = got === DROPPED ? null : got
  } catch {
    answer = null // dismissed, or taken down by a newer prompt
  }
  timer?.cancel()
  if (firing && (await firing)) return
  const out = popupOutcome(answer, set.items, prev)
  const stale = dropped || !live() || out.action === 'stale' || ((out.action === 'send' || out.action === 'alt') && overtaken())
  const tapped = stale && out.text !== null
  await append<PopLog>($, 'popups', {
    ts: await $.clock.now(),
    action: stale ? 'stale' : out.action,
    v: PROMPT_VERSION,
    ...(stale ? { text: out.text ?? set.items[0]!.prompt, tapped } : out.text ? { text: out.text } : {}),
  })
  if (stale) {
    // The turn moved on: sending it now would answer a question nobody is asking. Hand it back instead.
    if (tapped) await handBack($, pops, out.text!)
    return
  }
  await update($, current, () => null)
  if (out.text) await send($, out.text)
}

/** A prompt owner tapped too late: into an empty box, into the next dialog as the previous card's, and the transcript. */
async function handBack($: EngineInterface, pops: Popups, text: string) {
  pops.prev = text
  $.ui.log(`cue · 上一题你点过、但来不及发的(没替你发):\n${text}`)
  const box = await $.prompt.read().catch(() => null)
  if (box && box.text.trim() === '') await $.prompt.fill({ text, mode: 'replace' }).catch(() => null)
}

/** At most one dialog open: a cue made while one is open waits in `queued`, and only the newest waits. */
/**
 * `autoText`: the prompt of cue's own five-minute send in flight; the cue prompt with exactly this text is not owner's.
 * `chain`: such sends in a row with no other prompt between them.
 */
type Popups = {
  made: number
  open: boolean
  queued: { set: CueSet; n: number; live: () => boolean; auto: boolean } | null
  prev: string | null
  autoText: string | null
  chain: number
  /** Answers cue's open dialog from above core, which takes it down; set while one is open. */
  closeOpen: (() => void) | null
}

function popUp($: EngineInterface, pops: Popups, set: CueSet, n: number, live: () => boolean, auto: boolean) {
  if (pops.open) {
    pops.queued = { set, n, live, auto }
    return
  }
  pops.open = true
  void ask($, set, live, () => pops.made !== n, pops, auto).finally(() => {
    pops.open = false
    const next = pops.queued
    pops.queued = null
    if (next && next.n === pops.made && next.live()) popUp($, pops, next.set, next.n, next.live, next.auto)
  })
}

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME').catch(() => undefined)) ?? '/home/user'
}

async function run($: EngineInterface, argv: string[], cwd: string, stdin?: string): Promise<string | null> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs: 20_000, ...(stdin === undefined ? {} : { stdin }) })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

/** The session's repository root (the main working tree's) and its name. */
async function repoOf($: EngineInterface): Promise<{ root: string; name: string }> {
  const cwd = await $.session.cwd()
  const r = await $.session.repo().catch(() => null)
  const root = r?.root ?? cwd
  return { root, name: root.split('/').filter(Boolean).pop() ?? 'session' }
}

/** The newest docs/plan/<dir>/GOAL.md by mtime (MyApp: docs/plan/11.01/GOAL.md), else docs/plan/NOTES.md. */
async function ledgerPath($: EngineInterface, root: string): Promise<string | null> {
  const plan = `${root}/docs/plan`
  const dirs = await $.fs.list(plan).catch(() => [])
  let best: { path: string; mtime: number } | null = null
  for (const d of dirs) {
    if (d.kind !== 'dir') continue
    const path = `${plan}/${d.name}/GOAL.md`
    const st = await $.fs.stat(path).catch(() => null)
    if (st?.kind === 'file' && (!best || st.mtimeMs > best.mtime)) best = { path, mtime: st.mtimeMs }
  }
  if (best) return best.path
  return (await $.fs.exists(`${plan}/NOTES.md`).catch(() => false)) ? `${plan}/NOTES.md` : null
}

/** The evidence pack (t1102-07 §2): ledger tail · rulings · ticket board · git log main -30 · 待 owner · messages since. */
async function evidence($: EngineInterface, since: string[]): Promise<Evidence[]> {
  const { root, name } = await repoOf($)
  const h = await home($)
  const ev: Evidence[] = []
  const ledger = await ledgerPath($, root)
  if (ledger) ev.push({ source: `决策账 ${ledger.slice(root.length + 1)} 末 80 行`, lines: tail((await readText($, ledger)) ?? '') })
  ev.push({ source: '~/.omd-lite/rulings.json(最近 40 条裁定)', lines: rulingLines((await readText($, `${h}/.omd-lite/rulings.json`)) ?? '') })
  ev.push({ source: `ticket board --repo ${name}`, lines: tail((await run($, ['ticket', 'board', '--repo', name], root)) ?? '') })
  const fmt = ['-30', '--format=%h %ad %s', '--date=format:%m-%dT%H:%M']
  const log = (await run($, ['git', 'log', 'main', ...fmt], root)) ?? (await run($, ['git', 'log', 'master', ...fmt], root))
  ev.push({ source: 'git log main -30', lines: tail(log ?? '', 30) })
  ev.push({ source: `~/.claude/relay/待owner-${name}.md 末 80 行`, lines: tail((await readText($, `${h}/.claude/relay/待owner-${name}.md`)) ?? '') })
  if (since.length) ev.push({ source: '这一轮里插进来的消息', lines: since.flatMap((t) => tail(t, 20)) })
  return ev
}

function stamp(ms: number): string {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? ''
  return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}`
}

/** One cheap call: still holds? touches money / production / owner's logins? Fails closed (parseVet). */
async function vetCue($: EngineInterface, items: Cue[], answer: string, since: string[]) {
  let ev: Evidence[]
  try {
    ev = await evidence($, since)
  } catch {
    return parseVet(null, [])
  }
  const draft = items.map((c, i) => `${i === 0 ? '' : `—— ${ALT} ——\n`}${c.title}\n${c.prompt}`).join('\n\n')
  let reply: string | null = null
  try {
    const r = await $.model.complete({ model: 'haiku', prompt: vetPrompt(draft, answer, ev, stamp(await $.clock.now())), maxTokens: 600 })
    reply = r.isAnswered ? r.text : null
  } catch {
    reply = null
  }
  return parseVet(reply, ev, answer)
}

/** Why cue took its own dialog down. */
const CLOSED = 'cue:5 分钟没人点，自动发出'

const DEFAULT_OUTBOX = ['~/.bun/bin/bun', '~/.local/bin/freezewatch-outbox.ts', 'enqueue']

/** A sensitive cue: no dialog. Into 待 owner, to owner's phone through the outbox, kept for `/cue send`. */
async function parkCue($: EngineInterface, set: CueSet, why: string, outbox: string[]) {
  const c = set.items[0]!
  const { root, name } = await repoOf($)
  const h = await home($)
  const pane = (await $.env.get('HERDR_PANE_ID').catch(() => undefined)) ?? ''
  const sid = await $.session.id()
  const path = `${h}/.claude/relay/待owner-${name}.md`
  const md = (await readText($, path)) ?? `# 待 owner · ${name}\n`
  const n = nextParkNumber(md)
  const p = parkInto(md, `cue 草稿等你点头(${why}${pane ? ` · pane ${pane}` : ''}):「${c.title}」${c.prompt}`, `看过没问题回「发」;在那个会话里打 /cue send ${n}`)
  let wrote = true
  await $.fs.write(path, p.md).catch(() => { wrote = false })
  // Kept per session: `/cue send` in one session never sends another session's draft.
  const key = heldKey(sid)
  const held = ((await $.store.get(key)) as HeldCue[] | undefined) ?? []
  held.push({ ts: await $.clock.now(), turnId: set.turnId, n, title: c.title, prompt: c.prompt, why })
  await $.store.set(key, held.slice(-20))
  const text = `cue 有一条草稿碰到${why},没替你发，等你点头(${name}${pane ? ` · ${pane}` : ''} · 待owner #${n}):「${c.title}」\n${c.prompt}\n要发：在那个会话里打 /cue send ${n}`
  // The outbox rings the phone once per family a day (rcmux p0-policy): the family is per session, so one session's
  // second draft goes to the digest, another session's first still rings. The notification goes out every time.
  const argv = outbox.map((a) => a.replace(/^~\//, `${h}/`))
  const line = JSON.stringify({ dedupKey: `cue-park-${sid.slice(0, 8)}:${set.turnId}`, kind: 'p0', text })
  const sent = argv.length ? (await run($, argv, root, line + '\n')) !== null : false
  const told = await $.ui.notify(text, { title: 'cue' }).then((r) => r.isSent).catch(() => false)
  $.ui.log(`cue · 这条碰到${why},不开确认框${wrote ? `,记进 ${path} #${n}` : ''}${sent ? ',已进发件箱' : ''}${told ? ',已弹通知' : ''}。要发：/cue send ${n}`)
}

/** Held drafts older than this are not sent by `/cue send`: the turn they answer is long gone. */
const HELD_MS = 24 * 3600_000
type HeldCue = { ts: number; turnId: string; n: number; title: string; prompt: string; why: string }
const heldKey = (sid: string) => `held:${sid}`

function sensitiveWhy(words: { category: Category; word: string }[], fallback: string | null): string {
  const cats = [...new Set(words.map((w) => w.category))]
  if (cats.length) return cats.map((c) => CATEGORY_NAME[c]).join('、') + `(${words.map((w) => w.word).join('、')})`
  return fallback ?? '敏感(模型判不准)'
}

/** Sends as the person would: a plugin's prompt may not begin with `/`, so a slash command runs as one. */
/**
 * The text a five-minute send submits. A slash command goes in as a prompt naming it (a plugin's prompt may not
 * begin with `/`, and only a prompt takes the dialog down); the model runs the skill from there.
 */
function autoText(prompt: string): string {
  const cmd = /^\/([\w:.-]+)\s*([\s\S]*)$/.exec(prompt)
  return cmd ? `用 /${cmd[1]} 处理下面这段(cue 代发，原文以这条命令开头):\n\n${cmd[2]}` : prompt
}

async function send($: EngineInterface, text: string): Promise<boolean> {
  const cmd = /^\/([\w:.-]+)\s*([\s\S]*)$/.exec(text)
  try {
    if (cmd) await $.command.run({ command: cmd[1]!, args: cmd[2]! })
    else {
      const r = await $.prompt.submit({ text, asUser: true })
      if (r.drop !== undefined) {
        $.ui.log(`cue:没发出去(${r.drop}),原文:\n${text}`)
        return false
      }
    }
    return true
  } catch (err) {
    $.ui.log(`cue:没发出去(${String(err)}),原文:\n${text}`)
    return false
  }
}

export const register: Register = (on, options) => {
  const engine = String(options.engine ?? 'fork')
  const minChars = Number(options.minChars ?? 80)
  const popup = String(options.popup ?? 'auto')
  let outbox = DEFAULT_OUTBOX
  try {
    if (options.outbox) outbox = JSON.parse(String(options.outbox)) as string[]
  } catch { /* keep the default */ }
  // The turn whose cues are wanted; a newer prompt makes older work stale.
  let wanted = ''
  let lastAnswer = ''
  // Bumped only when owner speaks (keyboard, phone, a plugin sending on owner's behalf); a background wake leaves an
  // open phone card answerable.
  let spoke = 0
  // A -p run (review bots, learn, collect) has no one to read a cue: no fork, no shadow record.
  let interactive = true
  // Whether the latest prompt was owner's; a delegate wake or a task notification is not, and owner is likely away.
  let byNick = true
  // Whether the latest prompt was typed by owner himself (terminal or phone): only those turns keep the dialog that waits.
  let ownerTurn = true
  // What came in after the latest answer, for the evidence pack.
  let since: string[] = []
  // owner's last few messages, so the next cue does not restate them.
  const said: string[] = []
  const pops: Popups = { made: 0, open: false, queued: null, prev: null, autoText: null, chain: 0, closeOpen: null }

  // cue's own dialog passes here on its way to core. Settling first takes core's dialog down (next.signal: "a hook
  // above settled first"), the only way a plugin has to close a dialog it opened.
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e, next) => {
    const q = (e as unknown as { questions?: { header?: string; question?: string }[] }).questions?.[0]
    // cue opens one dialog at a time: a second one with cue's marks is not cue's, and is passed on untouched.
    if (q?.header !== 'cue' || !q.question?.startsWith('cue · ') || pops.closeOpen) return next(e)
    let mine: () => void = () => {}
    const closed = new Promise<'closed'>((r) => { mine = () => r('closed') })
    pops.closeOpen = mine
    try {
      const got = await Promise.race([next(e), closed])
      return got === 'closed' ? { deny: CLOSED } : got
    } finally {
      if (pops.closeOpen === mine) pops.closeOpen = null
    }
  })

  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive
    const legacy = (await $.store.get(LEGACY_SHADOW)) as ShadowLog[] | undefined
    if (legacy?.length) {
      const sealed = ((await $.store.get(SEALED_SHADOW)) as ShadowLog[] | undefined) ?? []
      await $.store.set(SEALED_SHADOW, [...sealed, ...legacy])
      await $.store.delete(LEGACY_SHADOW)
    }
    await $.command.register({ name: 'enhance', description: 'cue:把输入框里的粗稿改写成完整 prompt(空输入框则给下一步),写回输入框不发送' })
    await $.command.register({ name: 'cue', description: 'cue:用量与按下统计;held 看本会话等你点头的敏感草稿,send [编号] 发出那条(不写编号发最新的)', argumentHint: '[stats|held|send [n]]' })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    wanted = ''
    const o = e.origin
    // cue's own five-minute send is nobody's hand: neither owner's nor a reason to keep the next dialog waiting.
    const auto = o.kind === 'plugin' && o.name === 'cue' && pops.autoText !== null && e.text.trim() === pops.autoText.trim()
    if (auto) pops.autoText = null
    else pops.chain = 0
    const nickHand = o.kind === 'composer' || o.kind === 'bridge'
    const asNick = !auto && (nickHand || (o.kind === 'plugin' && !!o.asUser))
    const nickOwn = !auto && (nickHand || (o.kind === 'plugin' && o.name === 'cue' && !!o.asUser))
    if (e.turnId) {
      // Delivered into a running turn (a peer, a task notice): the turn stays whoever started it; owner typing over it makes it his.
      byNick ||= asNick
      ownerTurn ||= nickOwn
      since.push(e.text)
      if (since.length > 5) since.shift()
    } else {
      byNick = asNick
      ownerTurn = nickOwn
      since = []
    }
    // This message's own hand, not the turn's: a peer delivered into owner's turn is not something owner said.
    if (asNick) {
      spoke++
      said.push(e.text)
      if (said.length > 3) said.shift()
    }
    await update($, current, () => null)
    // Resolve the last unresolved pick against what was actually sent.
    if (e.origin.kind === 'composer') {
      const picks = ((await $.store.get('picks')) as PickLog[] | undefined) ?? []
      const last = picks[picks.length - 1]
      if (last && !last.edited) {
        const ratio = Number(editRatio(last.text, e.text).toFixed(3))
        last.edited = editKind(ratio)
        last.ratio = ratio
        await $.store.set('picks', picks)
      }
    }
    return next(e)
  })

  // A phone message sent while the dialog is open: the Remote Control client answers the dialog for it,
  // and that answer can come back before prompt.submit runs; this event fires before the message is queued.
  on('session.receive', async (_$, e, next) => {
    if (e.origin.kind === 'bridge' && !e.agentId) spoke++
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || e.reason !== 'answer') return result
    lastAnswer = e.answer
    if (!interactive || engine === 'off' || e.answer.trim().length < minChars) return result
    if (await relayRunning($)) return result

    wanted = e.turnId
    const { known, menu } = await commands($)
    const { cues: items, tier, tierReason } = await generate($, engine, 'answer', seatPrompt(e.answer, menu, { unattended: !byNick, said: [...said] }), known, 2)
    if (engine === 'fork') {
      await append<ShadowLog>($, SHADOW, { turnId: e.turnId, ts: await $.clock.now(), tier, reason: tierReason, v1: isPlanningTier(e.answer), head: e.answer.slice(0, HEAD) })
    }
    if (wanted !== e.turnId || items.length === 0) return result
    if (await relayRunning($)) return result
    const fresh: CueSet = { turnId: e.turnId, items }
    // t1102-07: on a turn owner did not start, check the draft against the disk before it goes anywhere.
    const words = sensitiveWords(items.map((c) => `${c.title}\n${c.prompt}`).join('\n'))
    const vet = ownerTurn ? undefined : await vetCue($, items, e.answer, [...since])
    if (wanted !== e.turnId) return result
    let where: Route = route({ ownerTurn, words, vet })
    const chained = where === 'popup' && pops.chain >= MAX_AUTO_CHAIN
    if (chained) where = 'void'
    await append<VetLog>($, 'vets', {
      ts: await $.clock.now(), turnId: e.turnId, route: where, title: items[0]!.title,
      ...(vet ? { verdict: vet.stale.verdict, reason: chained ? `已连着自动发了 ${pops.chain} 次` : vet.stale.reason, evidence: vet.stale.evidence, sensitive: vet.sensitivity.sensitive ? vet.sensitivity.category : null } : {}),
      words: words.map((w) => w.word),
    })
    // Any fresh cue, even a voided one, overtakes the dialog still open for an earlier turn: it must not go out.
    const n = ++pops.made
    if (where === 'void') {
      const why = chained ? `已经连着自动发了 ${pops.chain} 次，停下等人` : vet!.stale.verdict === 'stale' ? `已过时:${vet!.stale.reason}` : `核不了现状(${vet!.stale.reason}),不发`
      $.ui.log(`cue · 作废「${items[0]!.title}」:${why}${vet?.stale.evidence ? `\n证据:${vet.stale.evidence}` : ''}`)
      return result
    }
    await update($, current, () => fresh)
    if (where === 'park') {
      await parkCue($, fresh, sensitiveWhy(words, vet?.sensitivity.why ? `敏感(${vet.sensitivity.why})` : null), outbox)
      return result
    }
    if (await wantsPopup($, popup)) {
      const at = spoke
      popUp($, pops, fresh, n, () => spoke === at, where === 'popup')
    }
    return result
  })

  on('command.run', { command: 'enhance' }, async ($, e) => {
    // `/enhance 粗稿`:粗稿跟在命令后面;只打 `/enhance` 时读输入框。
    const draft = e.args.trim() || (await $.prompt.read()).text
    let pick: Cue | undefined
    let slot: PickLog['slot'] = 'enhance'
    if (draft.trim()) {
      const { known, menu } = await commands($)
      pick = (await generate($, engine, 'enhance', enhancePrompt(draft, menu), known, 1)).cues[0]
    } else {
      // Empty draft: the post-answer cue, reused if it is already on the band.
      const shown = await read($, current)
      pick = shown?.items[0]
      if (pick) slot = '1'
      else {
        const { known, menu } = await commands($)
        const answer = lastAnswer || '(见上文主 session 的最后一条回答)'
        pick = (await generate($, engine, 'answer', seatPrompt(answer, menu, { said: [...said] }), known, 1)).cues[0]
      }
    }
    if (!pick) return { text: 'cue:这次没生成出可用的 prompt,输入框未改动。' }
    const ok = await fillAndLog($, slot, pick.prompt)
    await update($, current, () => null)
    return { text: ok ? `cue:已写入输入框(未发送)· ${pick.title}` : 'cue:输入框不可写(对话框打开中或无输入框)。' }
  })

  on('command.run', { command: 'cue' }, async ($, e) => {
    const sub = e.args.trim()
    const [verb, arg] = sub.split(/\s+/)
    if (verb === 'send' || verb === 'held') {
      const key = heldKey(await $.session.id())
      const now = await $.clock.now()
      const held = (((await $.store.get(key)) as HeldCue[] | undefined) ?? []).filter((c) => now - c.ts < HELD_MS)
      if (verb === 'held') return { text: held.length ? held.map((c) => `#${c.n} · ${stamp(c.ts)} · ${c.why} ·「${c.title}」\n${c.prompt}`).join('\n\n') : 'cue:这个会话没有等你点头的草稿(超过 24 小时的不算)。' }
      const at = arg ? held.findIndex((c) => String(c.n) === arg.replace(/^#/, '')) : held.length - 1
      const c = at >= 0 ? held[at] : undefined
      if (!c) return { text: arg ? `cue:这个会话没有 #${arg.replace(/^#/, '')} 这条(超过 24 小时的不算)。/cue held 看还有哪些。` : 'cue:这个会话没有等你点头的草稿(超过 24 小时的不算)。' }
      held.splice(at, 1)
      await $.store.set(key, held)
      await update($, current, () => null)
      // A submit from inside command.run would wait on the turn this command holds: send right after it.
      $.clock.after(300, () => void send($, c.prompt))
      return { text: `cue:发出「${c.title}」` }
    }
    const forks = ((await $.store.get('forks')) as ForkLog[] | undefined) ?? []
    const picks = ((await $.store.get('picks')) as PickLog[] | undefined) ?? []
    const pops = ((await $.store.get('popups')) as PopLog[] | undefined) ?? []
    const vets = ((await $.store.get('vets')) as VetLog[] | undefined) ?? []
    return { text: stats(forks, picks, pops, vets) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Not raised on mobile today; if it ever is, the popup already covers the phone.
    if (e.surface === 'mobile' || e.props.hasSurvey || e.props.isWorking) return next(e)
    const shown = await read($, current)
    if (!shown || shown.items.length === 0) return next(e)
    if (await relayRunning($)) return next(e)

    // The other mods' bands (helper-desk's runs, cache-clock's countdown) stay above; idle is when they are read.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const rest = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns - 4
    const press = (slot: '1' | '2', text: string) => async () => {
      await fillAndLog($, slot, text)
      await update($, current, () => null)
    }

    return (
      <Box flexDirection="column">
        {rest as never}
        <Text dimColor>cue · 空输入框按数字或点击,写进草稿(不会发送)</Text>
        {shown.items.map((c, i) => {
          const slot = i === 0 ? '1' : '2'
          const name = `${i === 0 ? 'Enhance' : '方向 B'} · ${c.title}`
          const room = Math.max(0, Math.min(PREVIEW, width - name.length - 6))
          return (
            <Button key={`s${slot}`} plain hotkey={slot} label={name} onPress={press(slot, c.prompt)}>
              {name}
              {room > 8 ? <Text dimColor>{'  ' + clip(oneLine(c.prompt), room)}</Text> : null}
            </Button>
          )
        })}
      </Box>
    )
  })
}
