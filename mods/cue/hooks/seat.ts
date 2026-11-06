// Pure helpers: the seat prompt (C-3), reply parsing, edit measure, stats. No engine here.

export type Cue = { title: string; prompt: string }
export type ForkLog = {
  ts: number
  kind: 'answer' | 'enhance'
  engine: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}
export type Edit = 'equal' | 'edited' | 'discarded'
export type PickLog = { ts: number; slot: '1' | '2' | 'enhance'; text: string; edited?: Edit; ratio?: number; v?: string }
/**
 * One popup outcome (phone): sent as is, sent direction B, sent a rewrite typed under Other, discarded, overtaken by a newer
 * prompt, or sent by itself after five minutes unanswered (a turn owner did not start).
 */
export type PopAction = 'send' | 'alt' | 'rewrite' | 'discard' | 'stale' | 'auto'
/** `tapped`: on a stale row, whether owner had picked it (true) or the dialog was taken down unanswered (false). */
export type PopLog = { ts: number; action: PopAction; text?: string; tapped?: boolean; v?: string }
/** The seat prompt's version, stamped on picks and popups so /cue stats can compare versions; unstamped rows are v1. */
export const PROMPT_VERSION = 'v6'
export type Tier = 'planning' | 'not'
/** Shadow mode: the fork's tier for an answer, logged next to the keyword verdict; it picks no shape. */
export type ShadowLog = { turnId: string; ts: number; tier: Tier | null; reason: string | null; v1: boolean; head: string }

/** Popup labels: compared with `$.ui.ask`'s answer exactly; anything else is Other (a rewrite). */
export const SEND = '发送'
export const ALT = '方向 B'
export const DROP = '放弃'
/** The option that sends the previous card's prompt owner tapped but that came too late to send. */
export const PREV = '发上一题的'
/**
 * Characters of each prompt shown in the popup's question. AskUserQuestion's schema sets no cap on
 * `question`, but on a phone the options sit below the question: ~700 CJK characters is about a
 * screen and a half, long enough for nearly every cue and short enough that 发送 / 放弃 stay a
 * short scroll away. A longer prompt is clipped there and written whole into the transcript.
 */
export const POP_CHARS = 700

const MAX_ANSWER = 6000
const MAX_DRAFT = 4000

const PLAIN = '说人话(owner 29.10):像同事当面交代一件事那样写，短句、口语，一句一个意思。先一句说要发生什么，再说为什么，最后说怎么算做完。不写「判官 / 读数 / 闸 / 判据 / 差集 / 起片 / 落盘」这类行话，换成大白话(「检查」「量出来的数」「算做完」);英文缩写和代码名只在执行方非用不可时出现，出现就顺手说一句是什么。路径、提交号只留执行方真要用的一两个，不堆在正文里。整条控制在 200 字以内，能三句说完就别写一段。'

const SHAPE_HEAD = '每条 prompt 写成 owner 的口吻,是一条完整的指令,按顺序含:'
const SHAPE_TAIL = '限定终点和边界,不规定做法和第一步。点名执行方最可能漏的那一处。'
/** 五项按名字拆开:规划层要在其中两项之间插新项,按序号插容易插错位置。 */
const ITEMS = {
  what: '1. 一句话要什么(回答在等拍板时,第一句就是 owner 的拍板 + 一句理由)',
  facts: '2. 关键事实或证据指针(文件路径、提交号、读数、复现步骤),只放模型会用到的;对原因的猜测标成「待证伪的假设」放在事实之后,不当结论写',
  bounds: '3. 边界:范围尽量写成正向的(只动哪里、哪些行为保持不变),禁令只留真护栏;顺手写进你的自查(最可能错的那个结论先验)和更简单替代的判断',
  done: '4. 判据:怎么算做完,能写成可跑命令就写命令,能写成穷尽式(「每个改到的 X 都……」)就写穷尽式;修 bug 先要一条能在这个 bug 上变红的命令,重构 / 迁移先留改动前的基线;多步的每步带自己的验证,绿了再走下一步',
  handoff: '5. 停在哪、回我什么:点名证据的形态(命令输出原文、前后数字、它修的是原因不是症状的论证),不收「已完成」;可逆的做完再报,只有要 owner 拍板的才停(例:「验完给我读数,不要问要不要继续」);大改动先停在一段复述 + 计划处',
}
/** 规划层才出现的两项,加在「判据」项末尾的那半句(改字号时它们是噪音)。 */
const RAW_MATERIAL = '2b. 原始材料与工具:这件事顶级的人从什么没被消化过的材料起(PDF 行号 · 迁移文件 · 流水 · 台账),用什么工具与方法;被执行仓 docs/methods/ 有现成方法卡就点名 slug 并抄它的 instruments'
const OUTSIDE_JUDGE = ';判据里必须点名一条外部判官 —— 工具跑出来的命令,模型的判词不算'
const FOUR_Q = '4b. 先答四问再写:① 该领域顶级的人在这会做什么我们没要求的 ② 他们从什么原始材料起 ③ 他们用什么方法与工具 ④ 除了你和我,什么能证明结果对;答不出的写「无」,写进 prompt 的只有答得出的'

/** 规划层 = 这条在问方向(GOAL / 方案 / 任务书 / 切片),不在问一处改动(任务书 S16d §1)。 */
// 不收 plan:子串命中 MyApp / planner / docs/plan/。GOAL 只认大写,英文正文里的 goal 不是信号。
const PLANNING_MARKERS = [/\/goal\b/i, /\/contract\b/i, /\bgrill\b/i, /GOAL|SDD|方案|契约|任务书|切片/]

export function isPlanningTier(text: string): boolean {
  return PLANNING_MARKERS.some((m) => m.test(text))
}

/** cue 的结构:五项(规划层加两项、判据项加半句);只讲顶级的人**怎么做**,不派身份。 */
export function shape(planning: boolean): string[] {
  return planning
    ? [
        SHAPE_HEAD,
        ITEMS.what,
        ITEMS.facts,
        RAW_MATERIAL,
        ITEMS.bounds,
        ITEMS.done + OUTSIDE_JUDGE,
        FOUR_Q,
        ITEMS.handoff,
        SHAPE_TAIL,
      ]
    : [SHAPE_HEAD, ITEMS.what, ITEMS.facts, ITEMS.bounds, ITEMS.done, ITEMS.handoff, SHAPE_TAIL]
}

function menu(commands: string[]): string {
  return commands.length > 0
    ? `可以用这些真实存在的命令开头(只用这些):${commands.map(c => '/' + c).join(' ')}`
    : '不要以 slash 命令开头。'
}

const MAX_SAID = 600

/** What the turn being answered came from, and what owner last said (newest last). */
export type SeatContext = { unattended?: boolean; said?: string[] }

const UNATTENDED = '这一轮不是 owner 发起的(run 结束的叫醒、后台任务回执):owner 多半不在,卡片会堆到他回来,那时多半已经过时。默认 cues 给空数组,让 lead 自己接着转。只在两种时候给 1 条:① 回答停下来等 owner 拍板(战略岔口,lead 自己不能裁);② 一个阶段到头了(GOAL 的判据达到、一批片全部收完、同一个前提上连续失败),要站高一层定下一阶段的方向。这条只写方向和判据,不写这一轮的操作细节。'

/** C-3: lead in owner's seat writes the next prompt after an answer. */
export function seatPrompt(answer: string, commands: string[], ctx: SeatContext = {}): string {
  const tail = answer.length > MAX_ANSWER ? '…' + answer.slice(-MAX_ANSWER) : answer
  const said = (ctx.said ?? []).map((t) => (t.length > MAX_SAID ? '…' + t.slice(-MAX_SAID) : t))
  return [
    '你是 lead(这个仓库的总架构师 / lead),但现在你坐在 owner 的位置上:主 session 的 agent 刚回答完下面这条。owner 下一句要发什么,才能让模型想得最深、方向最对?替他写好,他按一下就进输入框,改几个字就发。',
    '',
    '执行方读过 CLAUDE.md,控制回路、外部判官、根因、分级这些方法它都知道,你不用复述。你要做的是让这一轮真的用上它们:把方法落成这件事里的具体数字和具体命令。',
    '',
    '先问:owner 想让接下来发生什么?不是下一个任务,是任务上面那一层的结果。修一个 crash 的上一层是「app 一直不 crash」,做一页季度报告的上一层是「负责人更早发现问题,把钱和人挪到对的地方」。往上走到 owner 真正在追的那一层就停,不要空到「去赚钱」。',
    '',
    '然后看这件事到哪了:判据已经达到,剩下的只是再找一个漏网面、再多证一格这类边际加固 → 不再往这件事里深挖,下一句写成收尾;只有还没达到判据,或者它挡着别的线时,才接着在它上面做。空出来的槽位补什么、run 结束后接着做哪条线,lead 被 delegate 叫醒后自己排,你不在每一轮里替它派。',
    '',
    '再把这个结果写成一个能自己转起来的回路:它实现之后哪个读数会变,变到多少(敢定一个比顺手的更狠的数);由什么读出这个数,可以是命令、测试或真实数据,执行方自己说的不算;读数没到就接着做,不用回来问。要让它长期在跑、不再需要 owner 一条条派任务,说出先要接上哪些数据和工具。同一个前提上已经失败过两次,接下来要发生的就是先验这个前提,不是第三个修法。',
    '',
    '写之前想清楚,这件事做得最好的人会多做什么:从什么还没被消化过的原始材料开始,用什么工具和方法,靠什么证明结果对。把名词换成动词(「一份 deck」换成「让忙人在 30 分钟里相信一条因果并拍板」),看看还该借哪些领域的做法:借他们做的事,不扮演他们。答得出的才写进去。',
    '',
    'lead 是 CEO,owner 是董事长。写之前先替 owner 把这件事 grill 一遍:沿决策树把每个岔口走到底。技术和执行上的岔口(选型、接缝、施工顺序、拿不准选哪个)由执行方自己裁,或者派 agent、开 council、跑实验、检索去解,不回来问;只有战略岔口留给 owner:不可逆、钱与权限、对外发出、产品方向与客户、两边都站得住的业务取舍。按回答的形状选技能,能组合就组合(开头只能放一个命令,第二个写进正文「…然后 /xxx」):还没定方向、要逼问一条决策线 → /grill;宽解岔口或要比几个候选 → /bestof;方案定了要交执行 → /contract;不清楚做到哪了 → /recall;改动出手前要知道会弄坏什么 → /blast-radius;审已写的 diff → /code-review。只点名菜单里真有的命令。',
    '',
    '用 owner 的口吻写成一段:要发生什么、为什么要紧、怎么算做完、已知事实(只用对话和仓库里看得到的,不编造;猜测标成待证伪)、最容易做错的那一处。不写做法,也不写第一步。事情小就写两三句。',
    '',
    PLAIN,
    '',
    '停下条件是常设的:owner 说过一次就一直有效,不用每轮重申。只有这一轮新冒出一件要 owner 拍板的事,才写那一件;不写「停下来找我的条件不变 / 照旧 / 只有……才停」这类收尾。owner 上一条已经说过的高度、并行项和停下条件,这一轮没变就不再写。结尾落在这一轮唯一新的那件事上(新判据、新读数、新岔口),句式也别套上一条的模板。',
    '',
    '给几条:',
    '- 回答只是在等已经在跑的东西(收片、run、CI、子 agent),owner 上一条要求仍然有效、没有新的话要说:cues 给空数组。',
    '- 否则默认只给 1 条:你作为 lead 推荐的下一步。自查和更简单替代的判断写进这一段里,不要拆成别的条。',
    '- 只有回答停在真岔口(两个方向都站得住、取决于 owner 的偏好)时,才追加第 2 条「方向 B」;否则不给。',
    ...(ctx.unattended ? ['', UNATTENDED] : []),
    '',
    menu(commands),
    '',
    '只输出一个 JSON 对象:{"tier":"planning" 或 "not","tierReason":"一句理由","cues":[{"title":"按钮上的短标题,≤18 字","prompt":"完整 prompt"}]},cues 长度 0 到 2,不要其他文字。tier 判的是上面这条回答:回答主体在定下一步做什么(GOAL 内容 / 范围 / 切片 / 任务书或契约 / 设计或方法取舍 / 采纳或不采纳某工具),并给出推荐或记下决定,或者列出待拍板项并附推荐 → planning;收片 / 状态 / 等待回执 / 查 bug / 解释 / 交付报告 → not。',
    '',
    ...(said.length
      ? ['', '<owner 最近发过的>(多半就是你前几轮写的;跟它们重复的句子和收尾不再写)', ...said.map((t) => `- ${t}`), '</owner 最近发过的>']
      : []),
    '',
    '<最新回答>',
    tail,
    '</最新回答>',
  ].join('\n')
}

/** /enhance: rewrite owner's rough draft into the full structure, keeping his intent. */
export function enhancePrompt(draft: string, commands: string[]): string {
  const text = draft.length > MAX_DRAFT ? draft.slice(0, MAX_DRAFT) + '…' : draft
  return [
    '你是 lead(这个仓库的总架构师 / lead),但现在你坐在 owner 的位置上:他在输入框里写了一份粗稿(下方 <草稿>),要发给主 session 的 agent。把它改写成能让模型想得最深、方向最对的完整 prompt。',
    '',
    '规则(不要写进输出):',
    '- 粗稿里的意图、拍板和原话决定一律保留,不加他没要的新方向;粗稿含糊处按对话上下文补成具体的事实与指针,补不出就留给模型去查,不编造路径和命令。',
    '- 粗稿已经是 slash 命令开头的,保留那个命令开头。',
    '- '+PLAIN,
    '',
    ...shape(isPlanningTier(draft)),
    '',
    menu(commands),
    '',
    '只输出 JSON 数组,长度 1:[{"title":"≤18 字","prompt":"完整 prompt"}],不要其他文字。',
    '',
    '<草稿>',
    text,
    '</草稿>',
  ].join('\n')
}

/**
 * Reply → cues plus the fork's tier. The `{tier, tierReason, cues}` object is tried first; anything
 * else falls back to the bare array, whose tier is null (unread), never 'not' (judged).
 */
export function parseReply(text: string, known: Set<string>, max = 2): { cues: Cue[]; tier: Tier | null; tierReason: string | null } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const o = JSON.parse(text.slice(start, end + 1)) as { tier?: unknown; tierReason?: unknown; cues?: unknown }
      if (Array.isArray(o.cues)) {
        const tier = o.tier === 'planning' || o.tier === 'not' ? o.tier : null
        const tierReason = tier && typeof o.tierReason === 'string' ? o.tierReason : null
        return { cues: parseCues(JSON.stringify(o.cues), known, max), tier, tierReason }
      }
    } catch {
      // not an object reply: the bare array below
    }
  }
  return { cues: parseCues(text, known, max), tier: null, tierReason: null }
}

/** Reply → 1–2 cues; drops malformed items and those opening with an unknown slash command. */
export function parseCues(text: string, known: Set<string>, max = 2): Cue[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: Cue[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { title, prompt } = item as { title?: unknown; prompt?: unknown }
    if (typeof prompt !== 'string' || !prompt.trim()) continue
    const body = prompt.trim()
    // A slash command the session does not have would fail when sent: drop it.
    const cmd = /^\/([\w:.-]+)/.exec(body)
    if (cmd && !known.has(cmd[1]!)) continue
    if (out.some(c => c.prompt === body)) continue
    const head = typeof title === 'string' && title.trim() ? title.trim() : body.slice(0, 18)
    out.push({ title: oneLine(head), prompt: body })
    if (out.length === max) break
  }
  return out
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function clip(s: string, room: number): string {
  const n = Math.max(4, room)
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** How much of the filled text the sent text changed: 0 = same, 1 = nothing kept. */
export function editRatio(filled: string, sent: string): number {
  const a = filled.trim()
  const b = sent.trim()
  if (a === b) return 0
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 0
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  return Math.min(1, Math.max(0, 1 - (pre + suf) / longest))
}

export function editKind(ratio: number): Edit {
  return ratio === 0 ? 'equal' : ratio >= 0.8 ? 'discarded' : 'edited'
}

/** The popup's question: the prompt(s), clipped to POP_CHARS each; ends in a question mark as `$.ui.ask` asks. */
export function popupQuestion(items: Cue[], prev?: string | null): { question: string; clipped: boolean } {
  let clipped = false
  const body = (c: Cue) => {
    if (c.prompt.length <= POP_CHARS) return c.prompt
    clipped = true
    return c.prompt.slice(0, POP_CHARS) + `…(截断,全文 ${c.prompt.length} 字已写在对话里)`
  }
  const [a, b] = items
  const parts = [`cue · ${a!.title}`, '', body(a!)]
  if (b) parts.push('', `—— ${ALT} · ${b.title} ——`, body(b))
  if (prev) parts.push('', '—— 上一题你点过、但来不及发的(没替你发)——', body({ title: '', prompt: prev }))
  parts.push('', `「${SEND}」原样发出${b ? `,「${ALT}」发第二条` : ''}${prev ? `,「${PREV}」发上一题那条` : ''};在 Other 里改写会发你改后的文字。发送吗?`)
  return { question: parts.join('\n'), clipped }
}

/** The popup's answer → what to send (null = nothing) and how to log it. */
export function popupOutcome(answer: string | null, items: Cue[], prev?: string | null): { action: PopAction; text: string | null } {
  if (answer === null || answer === DROP) return { action: 'discard', text: null }
  // The engine fills this in when a message is sent while the dialog is still open.
  if (answer.startsWith('[User did not answer this question')) return { action: 'stale', text: null }
  if (answer === SEND) return { action: 'send', text: items[0]!.prompt }
  if (answer === ALT && items[1]) return { action: 'alt', text: items[1].prompt }
  if (answer === PREV && prev) return { action: 'send', text: prev }
  const typed = answer.trim()
  return typed ? { action: 'rewrite', text: typed } : { action: 'discard', text: null }
}

/** Where a fresh cue went (vet.ts `route`), one row each; `evidence` is the line a stale verdict quoted. */
export type VetLog = { ts: number; turnId: string; route: 'owner' | 'park' | 'void' | 'popup'; title: string; verdict?: string; reason?: string; evidence?: string | null; sensitive?: string | null; words?: string[] }

export function stats(forks: ForkLog[], picks: PickLog[], pops: PopLog[] = [], vets: VetLog[] = []): string {
  const sum = (k: keyof Omit<ForkLog, 'ts' | 'kind' | 'engine'>) => forks.reduce((s, f) => s + (f[k] || 0), 0)
  const n = forks.length
  const avg = (v: number) => (n ? Math.round(v / n) : 0)
  const read = sum('cache_read_input_tokens')
  const write = sum('cache_creation_input_tokens')
  const input = sum('input_tokens')
  const output = sum('output_tokens')
  const bySlot = (s: PickLog['slot']) => picks.filter(p => p.slot === s).length
  const resolved = picks.filter(p => p.edited)
  const count = (k: Edit) => resolved.filter(p => p.edited === k).length
  const meanRatio = resolved.length
    ? (resolved.reduce((s, p) => s + (p.ratio ?? 0), 0) / resolved.length).toFixed(2)
    : '-'
  const popCount = (k: PopAction) => pops.filter(p => p.action === k).length
  const pct = (k: Edit) => (resolved.length ? Math.round((count(k) / resolved.length) * 100) + '%' : '-')
  return [
    `cue stats · 生成 ${n} 次(回答后 ${forks.filter(f => f.kind === 'answer').length} · /enhance ${forks.filter(f => f.kind === 'enhance').length})`,
    `tokens 合计:缓存读 ${read} · 缓存写 ${write} · 输入 ${input} · 输出 ${output}`,
    `每次平均:缓存读 ${avg(read)} · 缓存写 ${avg(write)} · 输入 ${avg(input)} · 输出 ${avg(output)}`,
    `按下 ${picks.length} 次:1 = ${bySlot('1')} · 2(方向 B)= ${bySlot('2')} · /enhance = ${bySlot('enhance')}`,
    `发出时:原样 ${count('equal')}(${pct('equal')})· 改写 ${count('edited')}(${pct('edited')})· 弃用 ${count('discarded')}(${pct('discarded')})· 未发 ${picks.length - resolved.length} · 平均改写比例 ${meanRatio}`,
    `手机弹窗 ${pops.length} 次:发送 ${popCount('send')} · 方向 B ${popCount('alt')} · 改写 ${popCount('rewrite')} · 放弃 ${popCount('discard')} · 被新消息顶掉 ${popCount('stale')} · 5 分钟没人点自动发送 ${popCount('auto')}`,
    ...(vets.length ? [`发出前核现状 ${vets.length} 次:照常弹 ${vets.filter((v) => v.route === 'popup').length} · 作废(过时或核不了)${vets.filter((v) => v.route === 'void').length} · 敏感改发手机 ${vets.filter((v) => v.route === 'park').length} · owner 自己的轮次 ${vets.filter((v) => v.route === 'owner').length}`] : []),
    ...byVersion(resolved, pops),
  ].join('\n')
}

function byVersion(resolved: PickLog[], pops: PopLog[]): string[] {
  const ver = (r: { v?: string }) => r.v ?? 'v1'
  const versions = [...new Set([...resolved.map(ver), ...pops.map(ver)])].sort()
  return versions.map((v) => {
    const ps = resolved.filter((p) => ver(p) === v)
    const n = (k: Edit) => ps.filter((p) => p.edited === k).length
    const pct = (k: Edit) => `${n(k)}(${ps.length ? Math.round((n(k) / ps.length) * 100) : 0}%)`
    const pp = pops.filter((p) => ver(p) === v)
    const pc = (...a: PopAction[]) => pp.filter((p) => a.includes(p.action)).length
    return `${v}:原样 ${pct('equal')}· 改写 ${pct('edited')}· 弃用 ${pct('discarded')}· 弹窗 发送 ${pc('send', 'alt')} · 改写 ${pc('rewrite')} · 放弃 ${pc('discard')}`
  })
}
