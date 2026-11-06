import type { EngineInterface, ModelForkResult, Register } from 'claude-code'

import type { CacheClockState, Clock, Miss, Warm } from '../types'

const CLOCK = { plugin: 'cache-clock', key: 'clock' } as const
const WARM = { plugin: 'cache-clock', key: 'warm' } as const
const MISSES = { plugin: 'cache-clock', key: 'misses' } as const

const FIVE_MIN = 5 * 60_000
const ONE_HOUR = 60 * 60_000
const DEMO_MS = 60_000
// 冷了还这么大的会话给「交接」按钮:重读它最贵。
const BIG = 150_000
// 冷了的会话小于这个就不拦:重写也不贵。
const GUARD_MIN = 50_000
const BAR = 20
// D-2:三者全空满这么久出一次保温提醒。
const IDLE_NUDGE = 5 * 60_000
const LIVE = new Set(['pending', 'running'])
const BG_TYPES = new Set(['shell', 'monitor'])

// 保温:缓存变冷前约 45 秒发一个后台小 ping。$.model.fork 重放主线程上一次请求
// (同模型、系统提示、工具、消息)再接这一句,API 从缓存读整段会话,缓存计时重新开始。
// fork 不写 transcript。
const LEAD = 45_000
const MAX_PINGS = 30
const DEFAULT_WINDOW = 2 * 60 * 60_000
const MAX_WINDOW = 8 * 60 * 60_000
const MAX_FAILS = 3
const RETRY_MS = 20_000
const PING_PROMPT = 'Reply with the single word: ok'
const TIP = '保温每次 ping 只按缓存读价付整段会话(约写价的 1/20,Fable 5.1 是 1/80);放冷了就得按写价重写一遍。'
// 不是人在打字的回合:不算「人回来了」,也不拦。
const BACKGROUND = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation'])
// 只拦人亲手发的:终端输入框与手机 / 远程。
const HUMAN = new Set(['composer', 'bridge'])

const GOOD = '#16a34a'
const WARN = '#ca8a04'
const BAD = '#dc2626'
const COLD = '#2563eb'

// $ / 百万 tokens:[缓存读, 1h 缓存写, 输出],2026-09 牌价(取自 cache-tax)。长名在前,模型 id 取第一个包含的行。
const PRICES: [string, number, number, number][] = [
  ['fable-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['opus-5', 0.5, 10, 25],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku', 0.1, 2, 5],
]

type Guard = 'refuse' | 'warn' | 'off'

// 模块变量随重载清零;时钟本身在 $.state。
let sid = ''
let home = ''
let demo = false
let detected: 'unknown' | '5m' | '1h' = 'unknown'
let working = false
let pinging = false
let hidden = false
let guard: Guard = 'refuse'
let lastModel = ''
// 已拦过一次的那次冷:同一个 lastEnd 再发就放行。
let ackedAt = 0
// board@lead-harness 开着:输入框上方归 board 画(D-14),这里不画横条。
let yielded = false
// $.cacheClock.state() 的读法;session.start 前为 null。
let readState: (() => Promise<CacheClockState>) | null = null
let coldPending = false
// D-1/D-2:最后一次看到「在干活」的时刻;点「先不」时记下当时的 idleSince,同一段停手不再提醒。
let lastBusyAt = 0
let dismissedFor: number | null = null
let bgLive = 0
// 保温自己停了(窗口到、ping 满、连续失败)的原因;人发消息或手动关不算。
let stoppedWhy = ''
// board ◷ 段的短句:stopBrief() 从 STOP_BRIEFS 里挑一句(G 稿第 5 行)。
let stoppedBrief = ''
// D-5:一键交接起跑的时刻;continuity 的 checkpoint mtime 晚于它,或过了 MAX_FLUSH_MS,就收起「写交接中…」。
let handoffSince: number | null = null
let handoffCheckedAt = 0
const MAX_FLUSH_MS = 10 * 60_000
const FLUSH_POLL_MS = 5_000

function priceOf(model: string): [number, number, number] | null {
  const m = model.toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, read, write, output] of PRICES) if (m.includes(family)) return [read, write, output]
  return null
}
// 5 分钟缓存写价是基价的 1.25 倍,1 小时是 2 倍。
const writeRate = (p: [number, number, number], ttlMs: number) => (ttlMs >= ONE_HOUR ? p[1] : p[1] * 0.625)
const coldUsd = (c: Pick<Clock, 'tokens' | 'model' | 'ttlMs'>) => {
  const p = priceOf(c.model)
  return p ? (c.tokens * writeRate(p, c.ttlMs)) / 1e6 : null
}
const warmUsd = (c: Pick<Clock, 'tokens' | 'model'>) => {
  const p = priceOf(c.model)
  return p ? (c.tokens * p[0]) / 1e6 : null
}
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const pingUsd = (u: Usage, model: string, ttlMs: number) => {
  const p = priceOf(model)
  if (!p) return null
  const w = writeRate(p, ttlMs)
  return (u.cache_read_input_tokens * p[0] + u.cache_creation_input_tokens * w + (u.input_tokens * p[1]) / 2 + u.output_tokens * p[2]) / 1e6
}
const usd = (n: number | null) => (n === null ? '' : `≈$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`)

const short = (tokens: number) => `${Math.round(tokens / 1000)}k`
const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}
const ago = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `${Math.floor(m / 60)} 小时前`
}
const dur = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}` : `${m} 分钟`
}
function parseWindow(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000
  return ms > 0 ? Math.min(ms, MAX_WINDOW) : null
}

/** 缓存时长的出处:Anthropic 上次回复、演示、还是首次回复前的猜测。 */
function lengthLabel(c: Pick<Clock, 'ttlMs' | 'ttlSource'>) {
  if (c.ttlSource === 'demo') return '60 秒演示缓存,仅本会话'
  if (c.ttlSource === 'detected') return `${c.ttlMs === ONE_HOUR ? '1 小时' : '5 分钟'}缓存(据上次回复)`
  return '5 分钟缓存(首次回复前的猜测)'
}

function ttl(): { ttlMs: number; ttlSource: Clock['ttlSource'] } {
  if (demo) return { ttlMs: DEMO_MS, ttlSource: 'demo' }
  if (detected === '1h') return { ttlMs: ONE_HOUR, ttlSource: 'detected' }
  if (detected === '5m') return { ttlMs: FIVE_MIN, ttlSource: 'detected' }
  return { ttlMs: FIVE_MIN, ttlSource: 'default' }
}

async function getClock($: EngineInterface): Promise<Clock | null> {
  const { value } = await $.state.get(CLOCK)
  return value ?? null
}
async function setClock($: EngineInterface, c: Clock | null) {
  await $.state.set(CLOCK, c)
}
async function getWarm($: EngineInterface): Promise<Warm | null> {
  const { value } = await $.state.get(WARM)
  return value ?? null
}
async function setWarm($: EngineInterface, w: Warm | null) {
  await $.state.set(WARM, w)
  invalidate($)
}
function invalidate($: EngineInterface) {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // 下一跳照样重画。
  }
}
function toast($: EngineInterface, text: string) {
  try {
    $.ui.toast(text)
  } catch {
    // toast 只是提示。
  }
}

async function setHidden($: EngineInterface, value: boolean) {
  hidden = value
  await $.store.set('hidden', value).catch(err => log($, `save hidden failed: ${String(err)}`))
  if (value) await stopWarm($, '保温已停:缓存钟已隐藏。')
  const c = await getClock($)
  if (c) await setClock($, { ...c, now: await $.clock.now() })
  invalidate($)
}

async function startWarm($: EngineInterface, windowMs = DEFAULT_WINDOW): Promise<'on' | 'none'> {
  const c = await getClock($)
  if (!c || !c.lastEnd) return 'none'
  // 保温从不在看不见的地方跑:先把钟亮出来。
  if (hidden) await setHidden($, false)
  stoppedWhy = ''
  stoppedBrief = ''
  await setWarm($, { startedAt: await $.clock.now(), windowMs, pings: 0, read: 0, write: 0, cold: false, error: '', sending: false, failures: 0, retryAt: 0, usd: priceOf(c.model) ? 0 : null })
  await log($, `keep warm on (${c.ttlMs / 1000} s cache, ${short(c.tokens)} tokens, window ${windowMs / 60_000} min)`)
  return 'on'
}

// board ◷ 段的原因只用这几句(XVYQF 稿「失败 / 窗口到」行):原因里可能带 API 错误原文,长度没有上界,细节只进 toast 和日志。
export const STOP_BRIEFS = ['窗口到了', 'ping 满 30', '还没回复', 'ping 连败', '保温停了'] as const
export function stopBrief(why: string): (typeof STOP_BRIEFS)[number] {
  if (/窗口到了/.test(why)) return '窗口到了'
  if (/已发 \d+ 次 ping/.test(why)) return 'ping 满 30'
  if (/可保温的回复/.test(why)) return '还没回复'
  if (/ping 失败/.test(why)) return 'ping 连败'
  return '保温停了'
}

async function stopWarm($: EngineInterface, why: string, shout = true) {
  const w = await getWarm($)
  if (!w) return
  await setWarm($, null)
  stoppedWhy = shout && why !== '保温已关。' && !why.includes('你发了消息') && !why.includes('隐藏') ? why : ''
  stoppedBrief = stoppedWhy ? stopBrief(stoppedWhy) : ''
  await log($, `keep warm off after ${w.pings} pings (${usd(w.usd) || 'n/a'}): ${why}`)
  if (shout) toast($, why)
}

// 每秒一次:离变冷 45 秒时发 ping,并守住上限。
async function warmTick($: EngineInterface) {
  const w = await getWarm($)
  if (!w || pinging || working) return
  const now = await $.clock.now()
  if (now - w.startedAt >= w.windowMs) return stopWarm($, `保温已停:${dur(w.windowMs)}窗口到了。/keepwarm 可再开。`)
  if (w.pings >= MAX_PINGS) return stopWarm($, `保温已停:已发 ${MAX_PINGS} 次 ping。/keepwarm 可再开。`)
  if (now < w.retryAt) return
  const c = await getClock($)
  if (!c || !c.lastEnd) return
  if (c.lastEnd + c.ttlMs - now > LEAD) return
  pinging = true
  void ping($, now).catch(async err => {
    pinging = false
    await log($, `ping failed: ${String(err)}`)
  })
}

async function ping($: EngineInterface, start: number) {
  const w0 = await getWarm($)
  if (w0) await setWarm($, { ...w0, sending: true })
  let r: ModelForkResult | null = null
  let thrown = ''
  try {
    r = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    thrown = String(err)
  }
  pinging = false
  const n = (w0?.pings ?? 0) + 1
  if (r && !r.isAnswered && r.reason === 'nothing-to-fork') {
    await log($, `ping ${n}: nothing to fork yet`)
    return stopWarm($, '保温已停:还没有可保温的回复。')
  }
  const usage = r && 'usage' in r ? (r.usage as Usage) : null
  const read = usage?.cache_read_input_tokens ?? 0
  const write = usage?.cache_creation_input_tokens ?? 0
  // 有回答,或回复是空的,都已经读过会话:缓存计时重新开始。
  const ok = r !== null && (r.isAnswered || r.reason === 'empty-reply')
  const error = ok ? '' : thrown ? 'error' : r && !r.isAnswered && r.reason === 'api-error' ? `${r.error}${r.status ? ` ${r.status}` : ''}` : r && !r.isAnswered ? r.reason : 'error'
  await log($, `ping ${n}: cache read ${read}, cache write ${write}, error ${error || 'none'}${thrown ? ` (${thrown.slice(0, 200)})` : ''}`)
  const w = await getWarm($)
  // ping 在途时被停了(人发了消息、/keepwarm off):只记日志。
  if (!w) return
  const now = await $.clock.now()
  const c = await getClock($)
  const cost = usage && c ? pingUsd(usage, c.model, c.ttlMs) : null
  const spent = w.usd === null || cost === null ? null : w.usd + cost
  if (ok) {
    await setWarm($, { ...w, pings: n, read, write, cold: write > read, error: '', sending: false, failures: 0, retryAt: 0, usd: spent })
    if (c) await setClock($, { ...c, lastEnd: Math.max(c.lastEnd, start), now })
  } else {
    const failures = w.failures + 1
    await setWarm($, { ...w, pings: n, error, sending: false, failures, retryAt: now + RETRY_MS, usd: spent })
    if (failures >= MAX_FAILS) return stopWarm($, `保温已停:连续 ${MAX_FAILS} 次 ping 失败(${error})。`)
  }
  if (n >= MAX_PINGS) await stopWarm($, `保温已停:已发 ${MAX_PINGS} 次 ping。/keepwarm 可再开。`)
}

function warmLine(w: Warm, left: number): string {
  const parts = ['保温中']
  if (w.sending) parts.push(`正在发第 ${w.pings + 1} 次 ping`)
  else if (w.pings === 0) parts.push(`首次 ping 在 ${mmss(left - LEAD)} 后`)
  else parts.push(`第 ${w.pings} 次 ping`, `下次在 ${mmss(left - LEAD)} 后`)
  if (w.error) parts.push(`上次 ping 失败(${w.error}),稍后重试`)
  else if (w.pings > 0 && w.cold) parts.push(`缓存已冷过,第 ${w.pings} 次 ping 重写了 ${short(w.write)} tokens`)
  else if (w.pings > 0) parts.push(`上次 ping 读了 ${short(w.read)} 缓存 tokens`)
  if (w.usd !== null && w.pings > 0) parts.push(`保温累计 ${usd(w.usd)}`)
  return parts.join(' · ')
}

async function log($: EngineInterface, line: string) {
  try {
    const path = `${home}/.claude/mods-logs/cache-clock.log`
    const old = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    const lines = old ? old.trimEnd().split('\n').slice(-200) : []
    lines.push(`${new Date(await $.clock.now()).toISOString()} ${sid.slice(0, 8)} ${line}`)
    await $.fs.write(path, `${lines.join('\n')}\n`)
  } catch {
    // 日志不许把钟弄坏。
  }
}

// 读这个会话的回复用的缓存时长(5 分钟或 1 小时)。
async function detect($: EngineInterface) {
  if (!sid) return
  const r = await $.process.run(['python3', `${$.plugin.root}/bin/ttl.py`, sid])
  const out = r.stdout.trim()
  if (out === '5m' || out === '1h') detected = out
  else if (r.exitCode !== 0) await log($, `ttl check failed: ${r.stderr.slice(0, 200)}`)
}

// 主会话一次回复刚结束:缓存从现在起又是热的。
async function restart($: EngineInterface, write: number) {
  const now = await $.clock.now()
  const prev = await getClock($)
  const { context } = await $.session.usage()
  await detect($).catch(() => undefined)
  const c: Clock = { lastEnd: now, ...ttl(), tokens: context.tokens ?? 0, model: lastModel || prev?.model || '', now, note: '' }
  // 真付了冷写(被拦后重发,或写入了上一轮一半以上的上下文):记一笔。
  if (coldPending || (prev && prev.tokens > 20_000 && write >= 0.5 * prev.tokens)) {
    const p = priceOf(c.model)
    const miss: Miss = { at: now, tokens: write, usd: p ? (write * writeRate(p, c.ttlMs)) / 1e6 : null }
    const { value: list = [] } = await $.state.get(MISSES)
    await $.state.set(MISSES, [...list, miss].slice(-50))
    await log($, `cold write ${write} tokens ${usd(miss.usd)}`)
  }
  coldPending = false
  await setClock($, c)
}

type ContinuityRef = { latest: (sessionId: string) => Promise<{ path: string } | null> }

// D-4 / D-5:一键交接不发 Claude 请求,交给 relay 的 /relay coldhandoff(它调 flushStart、等 checkpoint、拼交接、/clear)。
// 这里只记起跑时刻,好让 board 第 2 行显示「写交接中…」。
async function coldHandoff($: EngineInterface): Promise<string> {
  if (handoffSince !== null) return '一键交接已在进行。'
  handoffSince = await $.clock.now()
  handoffCheckedAt = handoffSince
  invalidate($)
  // 从 /cacheclock handoff 的 hook 里直接 $.command.run 跑不起来:等这个 hook 返回再跑。
  $.clock.after(0, () => {
    void $.command
      .run({ command: 'relay', args: 'coldhandoff' })
      .then(() => log($, 'cold handoff started'))
      .catch(async err => {
        handoffSince = null
        invalidate($)
        await log($, `cold handoff not started: ${String(err)}`)
        toast($, '一键交接没起来:relay 没装或没开。')
      })
  })
  return '一键交接:后台写 checkpoint(不发 Claude 请求),写完拼交接并 /clear。'
}

// 写交接中:checkpoint 写出来(mtime 晚于起跑)、continuity 读不到、或过了 10 分钟,就收起。
async function handoffTick($: EngineInterface, now: number) {
  if (handoffSince === null || now - handoffCheckedAt < FLUSH_POLL_MS) return
  handoffCheckedAt = now
  let done = now - handoffSince >= MAX_FLUSH_MS
  if (!done) {
    try {
      const latest = await ($ as unknown as { continuity: ContinuityRef }).continuity.latest(sid)
      const st = latest?.path ? await $.fs.stat(latest.path).catch(() => null) : null
      done = st !== null && st.mtimeMs > handoffSince
    } catch {
      done = true
    }
  }
  if (done) {
    handoffSince = null
    invalidate($)
  }
}

async function tick($: EngineInterface) {
  if (await busy($)) lastBusyAt = await $.clock.now()
  await handoffTick($, await $.clock.now())
  const c = await getClock($)
  if (!c || hidden || !c.lastEnd) return
  const now = await $.clock.now()
  // 冷了的钟一分钟重画一次就够(为了「多久前变冷」那一行)。
  const cold = now - c.lastEnd >= c.ttlMs
  if (cold && Math.floor((now - c.lastEnd) / 60_000) === Math.floor((c.now - c.lastEnd) / 60_000) && c.now - c.lastEnd >= c.ttlMs) return
  await setClock($, { ...c, now })
}

async function handoff($: EngineInterface) {
  const c = await getClock($)
  const r = await $.prompt.fill({ text: '/relay go' }).catch(() => ({ isFilled: false }))
  await log($, `handoff offered at ${short(c?.tokens ?? 0)}, filled ${String(r.isFilled)}`)
  if (c) await setClock($, { ...c, note: r.isFilled ? '已把 /relay go 填进输入框,回车开始交接。' : '输入 /relay go 开始交接。' })
}

async function statusText($: EngineInterface): Promise<string> {
  const c = await getClock($)
  const w = await getWarm($)
  const { value: misses = [] } = await $.state.get(MISSES)
  const lines: string[] = []
  if (!c || !c.lastEnd) lines.push('还没有回复,没有缓存可计时。')
  else {
    const now = await $.clock.now()
    const left = c.lastEnd + c.ttlMs - now
    lines.push(left > 0 ? `缓存热,还剩 ${mmss(left)} · ${lengthLabel(c)}` : `缓存已冷(${ago(-left)})· ${lengthLabel(c)}`)
    lines.push(`上下文 ${short(c.tokens)} tokens · 现在回复 ${usd(warmUsd(c)) || '报不出价'} · 冷了重写 ${usd(coldUsd(c)) || '报不出价'}${c.model ? `(${c.model})` : ''}`)
  }
  lines.push(w ? warmLine(w, c ? c.lastEnd + c.ttlMs - (await $.clock.now()) : 0) : '保温:关')
  const paid = misses.reduce((n, m) => (m.usd === null || n === null ? null : n + m.usd), 0 as number | null)
  lines.push(misses.length ? `本会话冷写 ${misses.length} 次 · ${short(misses.reduce((n, m) => n + m.tokens, 0))} tokens · ${usd(paid) || '报不出价'}` : '本会话还没付过冷写。')
  lines.push(`拦截:${guard === 'refuse' ? '拦一次(再发放行)' : guard === 'warn' ? '只报价不拦' : '关'} · /cacheclock guard refuse|warn|off`)
  return lines.join('\n')
}

async function snapshot($: EngineInterface): Promise<CacheClockState> {
  const c = await getClock($).catch(() => null)
  const w = await getWarm($).catch(() => null)
  return {
    lastEnd: c?.lastEnd ?? 0,
    ttlMs: c?.ttlMs ?? ttl().ttlMs,
    warm: w ? { startedAt: w.startedAt, windowMs: w.windowMs, pings: w.pings, usd: w.usd } : null,
    ...(await idleState($, c, w)),
    tokens: c?.tokens ?? 0,
    coldUsd: c ? coldUsd(c) : null,
    maxPings: MAX_PINGS,
    stopped: stoppedWhy ? stoppedBrief : '',
    handoffSince,
    turn: working,
  }
}

// D-1:主对话一轮在跑、有活的子 agent / 后台 shell、或 delegate 有 running,都算在干活;读不到也算。
async function busy($: EngineInterface): Promise<boolean> {
  if (working || bgLive > 0) return true
  try {
    if ((await $.agent.list()).some(a => LIVE.has(a.status))) return true
    // delegate 没装时 $.delegate 是 undefined,这里抛错,按在干活。
    const runs = await $.delegate!.runs()
    return !Array.isArray(runs) || runs.some(r => r.state === 'running')
  } catch {
    return true
  }
}

async function idleState($: EngineInterface, c: Clock | null, w: Warm | null): Promise<Pick<CacheClockState, 'idleSince' | 'nudge'>> {
  const now = await $.clock.now()
  if (await busy($)) {
    lastBusyAt = now
    return { idleSince: null, nudge: 'none' }
  }
  const idleSince = lastBusyAt
  if (!c || !c.lastEnd || w) return { idleSince, nudge: 'none' }
  if (now - c.lastEnd >= c.ttlMs) return { idleSince, nudge: 'cold' }
  if (stoppedWhy) return { idleSince, nudge: 'stopped' }
  return { idleSince, nudge: now - idleSince >= IDLE_NUDGE && dismissedFor !== idleSince ? 'warm' : 'none' }
}

async function boardOn($: EngineInterface): Promise<boolean> {
  try {
    const v = (await $.settings.read({ key: 'enabledPlugins' } as never)) as Record<string, unknown>
    const inner = v && typeof v === 'object' && 'enabledPlugins' in v ? v.enabledPlugins : v
    return !!inner && typeof inner === 'object' && (inner as Record<string, unknown>)['board@lead-harness'] === true
  } catch {
    return false
  }
}

export const register: Register = on => {
  // D-14:`$.cacheClock.state()`,给 board 画 ◷ 段。
  on('engine.create', async (_, e, next) => {
    const built = await next(e)
    return {
      ...built,
      cacheClock: {
        state: async () => (readState ? readState() : { lastEnd: 0, ttlMs: ttl().ttlMs, warm: null, idleSince: null, nudge: 'none' as const }),
      },
    }
  })

  on('session.start', async ($, e, next) => {
    readState = () => snapshot($)
    handoffSince = null
    yielded = await boardOn($)
    sid = await $.session.id()
    home = (await $.env.get('HOME').catch(() => undefined)) ?? $.plugin.root.split('/.claude/')[0] ?? ''
    demo = false
    hidden = (await $.store.get('hidden').catch(() => undefined)) === true
    const g = await $.store.get('guard').catch(() => undefined)
    // Lead prompts into a cold ticket session must not be refused: nobody is at that pane to send twice (t1106-13 · t1105-09, 6.11).
    const inTicket = await $.env.get('TICKET_ID').catch(() => undefined)
    guard = g === 'warn' || g === 'off' ? g : inTicket ? 'warn' : 'refuse'
    await $.command.register({
      name: 'cacheclock',
      description: '缓存钟:显示 / 隐藏。hide 隐藏,status 看明细与本会话冷写,demo 用 60 秒缓存演示,auto 恢复,skip 这段停手不再提醒,handoff 一键交接(/relay coldhandoff),guard refuse|warn|off 设冷发拦截',
      argumentHint: '[hide|status|demo|auto|skip|handoff|guard refuse|warn|off]',
      immediate: true,
    })
    await $.command.register({
      name: 'keepwarm',
      description: '缓存钟:保温,变冷前 45 秒发一个后台小 ping。默认 2 小时,/keepwarm 90m 自定窗口,/keepwarm off 停',
      argumentHint: '[90m|2h|off]',
      immediate: true,
    })
    $.clock.every(1000, () => {
      void tick($).catch(() => undefined)
      void warmTick($).catch(err => log($, `keep warm tick failed: ${String(err)}`))
    })
    void detect($).catch(() => undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // 引擎若为 ping 的 fork 起回合,那不是人的回合。
    if (!(pinging && e.text === PING_PROMPT)) {
      working = true
      stoppedWhy = ''
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // 子 agent 的回合不碰主会话缓存。
    if (e.agentId === undefined) {
      working = false
      lastBusyAt = await $.clock.now()
      ackedAt = 0
      if (e.usage?.model) lastModel = e.usage.model
      void restart($, e.usage?.cache_creation_input_tokens ?? 0).catch(err => log($, `restart failed: ${String(err)}`))
    }
    return result
  })

  // 压缩后上下文换了一段,旧钟作废,等下一次回复。
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      await stopWarm($, '保温已停:会话刚压缩。', false).catch(() => undefined)
      await setClock($, null).catch(() => undefined)
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim().toLowerCase()
    const own = text.startsWith('/keepwarm') || text.startsWith('/cacheclock') || text === PING_PROMPT.toLowerCase()
    const kind = e.origin?.kind ?? ''
    // 人回来了:人发的消息停掉保温,本 mod 自己的命令不算。
    if (!own && !BACKGROUND.has(kind)) {
      stoppedWhy = ''
      void stopWarm($, '保温已停:你发了消息。').catch(() => undefined)
    }
    if (guard === 'off' || !HUMAN.has(kind) || text.startsWith('/')) return next(e)
    const c = await getClock($).catch(() => null)
    const now = await $.clock.now().catch(() => 0)
    if (!c || !c.lastEnd || now - c.lastEnd < c.ttlMs || c.tokens < GUARD_MIN) return next(e)
    const price = `缓存 ${ago(now - c.lastEnd - c.ttlMs)}变冷;这条会按写价重写 ${short(c.tokens)} tokens ${usd(coldUsd(c))}(热的时候只要 ${usd(warmUsd(c)) || '读价'})。`
    if (guard === 'warn' || ackedAt === c.lastEnd) {
      coldPending = true
      if (guard === 'warn') toast($, `缓存钟:${price}`)
      return next(e)
    }
    ackedAt = c.lastEnd
    void log($, `refused a cold send of ${short(c.tokens)} ${usd(coldUsd(c))}`)
    return { drop: `缓存钟:${price}再发一次就照付;大会话建议先 /relay go 交接到新会话。` }
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const w = await getWarm($)
    if (arg === 'off' || (!arg && w)) {
      await stopWarm($, '保温已关。', false)
      return { text: '保温已关。/keepwarm 可再开。' }
    }
    const windowMs = arg ? parseWindow(arg) : DEFAULT_WINDOW
    if (windowMs === null) return { text: '/keepwarm 接时长(90m、2h、1h30m)或 off。' }
    if (w) await stopWarm($, '换新窗口。', false)
    if ((await startWarm($, windowMs)) === 'none') return { text: '还没有可保温的:Claude 第一次回复之后才能保温。' }
    return { text: `保温已开:缓存变冷前约 45 秒发一个后台小 ping,${dur(windowMs)}、${MAX_PINGS} 次 ping 或你发消息时自停。/keepwarm off 停。` }
  })

  on('ui.press', { plugin: 'cache-clock', element: 'keepwarm' }, async ($, e) => {
    if (await getWarm($)) await stopWarm($, '保温已关。')
    else if ((await startWarm($)) === 'on') toast($, `保温已开(${dur(DEFAULT_WINDOW)})。/keepwarm off 停。`)
    return { element: e.element }
  })

  on('command.run', { command: 'cacheclock' }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const arg = words[0] ?? ''
    if (arg === 'status') return { text: await statusText($) }
    // board ◷ 段的 [▾](先不)与 [一键交接]。
    if (arg === 'skip') {
      dismissedFor = lastBusyAt
      invalidate($)
      return { text: '这段停手不再提醒保温。' }
    }
    if (arg === 'handoff') return { text: await coldHandoff($) }
    if (arg === 'guard') {
      const mode = words[1]
      if (mode !== 'refuse' && mode !== 'warn' && mode !== 'off') return { text: '/cacheclock guard 接 refuse、warn 或 off。' }
      guard = mode
      await $.store.set('guard', mode).catch(() => undefined)
      return { text: mode === 'refuse' ? '冷发拦截:拦一次并报价,再发放行。' : mode === 'warn' ? '冷发拦截:只报价,不拦。' : '冷发拦截:关。' }
    }
    if (arg === 'demo' || arg === 'auto') demo = arg === 'demo'
    const hide = arg === 'hide' || (arg !== 'demo' && arg !== 'auto' && arg !== 'show' && !hidden)
    await setHidden($, hide)
    const c = await getClock($)
    if (c) await setClock($, { ...c, ...ttl(), now: await $.clock.now() })
    if (hide) return { text: '缓存钟已在所有会话隐藏。/cacheclock 再显示。' }
    return { text: `缓存钟已显示:${lengthLabel(ttl())}。/cacheclock hide 隐藏,/cacheclock status 看明细。` }
  })

  on('classic.Stop', async ($, e, next) => {
    bgLive = (e.background_tasks ?? []).filter(t => BG_TYPES.has(t.type) && LIVE.has(t.status)).length
    return next(e)
  })

  on('ui.press', { plugin: 'cache-clock', element: 'nudge-warm' }, async ($, e) => {
    if (!(await getWarm($)) && (await startWarm($)) === 'on') toast($, `保温已开(${dur(DEFAULT_WINDOW)})。/keepwarm off 停。`)
    return { element: e.element }
  })
  on('ui.press', { plugin: 'cache-clock', element: 'nudge-skip' }, async ($, e) => {
    dismissedFor = lastBusyAt
    invalidate($)
    return { element: e.element }
  })
  on('ui.press', { plugin: 'cache-clock', element: 'rewarm' }, async ($, e) => {
    if ((await startWarm($)) === 'on') toast($, `保温已开(${dur(DEFAULT_WINDOW)})。/keepwarm off 停。`)
    return { element: e.element }
  })
  // 一键交接本身在 relay(切片 3);这里只交给它的命令。
  on('ui.press', { plugin: 'cache-clock', element: 'coldhandoff' }, async ($, e) => {
    await coldHandoff($)
    return { element: e.element }
  })

  on('ui.press', { plugin: 'cache-clock', element: 'handoff' }, async ($, e) => {
    await handoff($)
    return { element: e.element }
  })
  on('ui.press', { plugin: 'cache-clock', element: 'hide' }, async ($, e) => {
    const wasWarm = (await getWarm($)) !== null
    await stopWarm($, '保温已停:缓存钟已隐藏。', false)
    await setHidden($, true)
    toast($, `缓存钟已隐藏${wasWarm ? ',保温已停' : ''}。/cacheclock 再显示。`)
    return { element: e.element }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const c = await getClock($)
    if (yielded || hidden || !c || !c.lastEnd || e.props.hasSurvey) return next(e)
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const noop = () => undefined
    // D-3 / INV-2:一轮在跑时只有一个绿点,不报时间。
    if (working || e.props.isWorking) {
      return (
        <Box flexDirection="column">
          {rest}
          <Text key="dot" color={GOOD}>
            ●
          </Text>
        </Box>
      )
    }
    const { nudge } = await idleState($, c, await getWarm($))
    const nudgeRow =
      handoffSince !== null ? (
        <Text color={WARN}>写交接中…</Text>
      ) : nudge === 'warm' ? (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text color={WARN}>{`你 5 分钟没动 · 冷了重写 ${usd(coldUsd(c)) || short(c.tokens)}`}</Text>
          <Button key="nudge-warm" label="保温 2h" variant="primary" onPress={noop} />
          <Button key="nudge-skip" label="先不" role="dismiss" onPress={noop} />
        </Box>
      ) : nudge === 'stopped' ? (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text color={BAD}>{stoppedWhy}</Text>
          <Button key="rewarm" label="再保温" onPress={noop} />
          <Button key="coldhandoff" label="一键交接" variant="primary" onPress={noop} />
        </Box>
      ) : nudge === 'cold' ? (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Button key="coldhandoff" label="一键交接 ≈$0" variant="primary" onPress={noop} />
          <Text dimColor>不发 Claude 请求:continuity 写 checkpoint,拼 GOAL / 计划 / git,再 /clear。</Text>
        </Box>
      ) : null
    const left = c.lastEnd + c.ttlMs - c.now
    const tokens = `${short(c.tokens)} tokens`
    const warmCost = usd(warmUsd(c))
    const coldCost = usd(coldUsd(c))
    const w = await getWarm($)
    const warmButton = w ? <Button key="keepwarm" label="停止保温" onPress={noop} /> : <Button key="keepwarm" label="保温" onPress={noop} />
    const warmRow = w ? <Text color={w.cold || w.error ? BAD : COLD}>{warmLine(w, left)}</Text> : null
    const tip = <Text dimColor>{TIP}</Text>

    if (left > 0) {
      const share = left / c.ttlMs
      const filled = Math.max(1, Math.round(share * BAR))
      const color = left <= 60_000 ? BAD : share < 0.5 ? WARN : GOOD
      return (
        <Box flexDirection="column">
          {rest}
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
            <Text>
              <Text color={color}>◷ 缓存热 </Text>
              <Text bold color={color}>
                {mmss(left)}
              </Text>
              <Text> </Text>
              <Text color={color}>{'━'.repeat(filled)}</Text>
              <Text dimColor>{'━'.repeat(BAR - filled)}</Text>
              <Text dimColor>{` ${lengthLabel(c)}。`}</Text>
              <Text dimColor>
                {warmCost && coldCost ? `现在回复读 ${tokens} ${warmCost},冷了重写 ${coldCost}。` : `现在回复 ${tokens} 只按缓存读价。`}
              </Text>
            </Text>
            <Box flexDirection="row" gap={1}>
              {warmButton}
              <Button key="hide" label="隐藏" role="dismiss" onPress={noop} />
            </Box>
          </Box>
          {warmRow}
          {nudgeRow}
          {tip}
        </Box>
      )
    }

    // 演示模式总显示交接按钮,小会话也能拍。
    const big = c.tokens >= BIG || c.ttlSource === 'demo'
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Text>
            <Text color={COLD}>❄ 缓存已冷</Text>
            <Text dimColor>{`(${ago(-left)})。下一条消息按全价重写 ${tokens}${coldCost ? ` ${coldCost}` : ''}。`}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            {big ? <Button key="handoff" label="交接到新会话" variant="primary" onPress={noop} /> : null}
            {warmButton}
            <Button key="hide" label="隐藏" role="dismiss" onPress={noop} />
          </Box>
        </Box>
        {warmRow}
        {nudgeRow}
        {c.note ? <Text dimColor>{c.note}</Text> : null}
        {tip}
      </Box>
    )
  })
}
