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
export type PickLog = { ts: number; slot: '1' | '2' | 'enhance'; text: string; edited?: Edit; ratio?: number }

const MAX_ANSWER = 6000
const MAX_DRAFT = 4000

const SHAPE = [
  '每条 prompt 写成用户的口吻,是一条完整的指令,按顺序含:',
  '1. 一句话要什么(回答在等拍板时,第一句就是用户的拍板 + 一句理由)',
  '2. 关键事实或证据指针(文件路径、提交号、读数),只放模型会用到的',
  '3. 边界:不碰什么、不做什么;顺手写进你的自查(最可能错的那个结论先验)和更简单替代的判断',
  '4. 判据:怎么算做完,能写成可跑命令就写命令',
  '5. 停在哪、回我什么(例:「验完给我读数,不要问要不要继续」)',
  '限定终点和边界,不规定做法和第一步。点名执行方最可能漏的那一处。',
]

function menu(commands: string[]): string {
  return commands.length > 0
    ? `可以用这些真实存在的命令开头(只用这些):${commands.map(c => '/' + c).join(' ')}`
    : '不要以 slash 命令开头。'
}

/** C-3: the lead in the user's seat writes the next prompt after an answer. */
export function seatPrompt(answer: string, commands: string[]): string {
  const tail = answer.length > MAX_ANSWER ? '…' + answer.slice(-MAX_ANSWER) : answer
  return [
    '你是这个仓库的 lead(总架构师),但现在你坐在用户的位置上:主 session 的 agent 刚回答完下面这条。用户下一句要发什么,才能让模型想得最深、方向最对?替他写好,他按一下就进输入框,改几个字就发。',
    '',
    '怎么想(不要写进输出):',
    '- 先判这条回答停在哪:在等用户拍板?做完但没验证?方向本身可能错?还是有明显的下一步?',
    '- 站在 lead 的标准看回答:哪个结论是推出来的而不是看到的?有没有更简单的替代?有没有被跳过的脏场景(并发、部分失败、读失败显示成 0、量级膨胀)?',
    '- 用你从对话和仓库规则里知道的事实,不编造路径和命令。',
    '',
    ...SHAPE,
    '',
    '给几条:',
    '- 默认只给 1 条:你作为 lead 推荐的下一步。自查和更简单替代的判断写进它的边界和判据里,不要拆成别的条。',
    '- 只有回答停在真岔口(两个方向都站得住、取决于用户的偏好)时,才追加第 2 条「方向 B」;否则不给。',
    '',
    menu(commands),
    '',
    '只输出 JSON 数组,长度 1 或 2:[{"title":"按钮上的短标题,≤18 字","prompt":"完整 prompt"}],不要其他文字。',
    '',
    '<最新回答>',
    tail,
    '</最新回答>',
  ].join('\n')
}

/** /enhance: rewrite the user's rough draft into the full structure, keeping his intent. */
export function enhancePrompt(draft: string, commands: string[]): string {
  const text = draft.length > MAX_DRAFT ? draft.slice(0, MAX_DRAFT) + '…' : draft
  return [
    '你是这个仓库的 lead(总架构师),但现在你坐在用户的位置上:他在输入框里写了一份粗稿(下方 <草稿>),要发给主 session 的 agent。把它改写成能让模型想得最深、方向最对的完整 prompt。',
    '',
    '规则(不要写进输出):',
    '- 粗稿里的意图、拍板和原话决定一律保留,不加他没要的新方向;粗稿含糊处按对话上下文补成具体的事实与指针,补不出就留给模型去查,不编造路径和命令。',
    '- 粗稿已经是 slash 命令开头的,保留那个命令开头。',
    '',
    ...SHAPE,
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

export function stats(forks: ForkLog[], picks: PickLog[]): string {
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
  const pct = (k: Edit) => (resolved.length ? Math.round((count(k) / resolved.length) * 100) + '%' : '-')
  return [
    `cue stats · 生成 ${n} 次(回答后 ${forks.filter(f => f.kind === 'answer').length} · /enhance ${forks.filter(f => f.kind === 'enhance').length})`,
    `tokens 合计:缓存读 ${read} · 缓存写 ${write} · 输入 ${input} · 输出 ${output}`,
    `每次平均:缓存读 ${avg(read)} · 缓存写 ${avg(write)} · 输入 ${avg(input)} · 输出 ${avg(output)}`,
    `按下 ${picks.length} 次:1 = ${bySlot('1')} · 2(方向 B)= ${bySlot('2')} · /enhance = ${bySlot('enhance')}`,
    `发出时:原样 ${count('equal')}(${pct('equal')})· 改写 ${count('edited')}(${pct('edited')})· 弃用 ${count('discarded')}(${pct('discarded')})· 未发 ${picks.length - resolved.length} · 平均改写比例 ${meanRatio}`,
  ].join('\n')
}
