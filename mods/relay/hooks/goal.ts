// Pure readers and writers of GOAL.md (C-1), the RELAY line (C-2) and the prompts relay sends.

export const SECTIONS = ['原话', '终点状态', '高度', '验收', '清单', '抢占规则', '停机条件', '不许停的情况', 'effort', '改道账'] as const
export type SectionName = (typeof SECTIONS)[number]

// C-1, verbatim: the shape every GOAL.md relay writes follows.
export const GOAL_TEMPLATE = [
  '# GOAL: <一句话终点>',
  '## 原话            owner 原话,逐字',
  '## 终点状态        做完时世界长什么样(可观察,不写过程)',
  '## 高度            四行必填:再往上一层(这个做完下一步想发生什么;碰业务方向才问 owner,其余 lead 自答)· 长期化(哪条能变成一直在跑的 mod / cron / 闸 / 读数)· 难目标(至少一个带数的指标,取不合理那档)· 外部判官(验收里哪条是工具跑出来的,点名)',
  '## 验收            每行一条可跑命令 + 期望;relay 在 done 时逐条跑',
  '## 清单            - [ ] 项(每项勾选要带证据:提交号/命令输出路径)',
  '## 抢占规则        命中即改道、不停:P0 类列表(本仓具体化,如 myapp:p95 延迟 > X ms)',
  '## 停机条件        done:验收全过 · owner:列出哪些属 owner 岔口 · stuck:同一项 3 轮无新证据 · 预算:轮数/墙钟上限',
  '## 不许停的情况    整理完、阶段性总结、「要不要继续」、给选项 —— 都不是停机条件',
  '## effort          phase → effort(默认 plan=xhigh · build=medium · review=high · chore=low)',
  '## 改道账          relay 追加:时间 · 触发 · 从哪项转到哪项',
].join('\n')

const sectionOf = (heading: string): SectionName | null => {
  const name = heading.replace(/^##\s*/, '').trim()
  return SECTIONS.find(s => new RegExp(`^${s}(?![\\p{L}\\p{N}_])`, 'iu').test(name)) ?? null
}

// Body lines of one `## <name>` section (heading excluded), [] when absent.
export function section(md: string, name: SectionName): string[] {
  const out: string[] = []
  let inside = false
  for (const line of md.split('\n')) {
    if (/^##\s/.test(line)) inside = sectionOf(line) === name
    else if (/^#\s/.test(line)) inside = false
    else if (inside) out.push(line)
  }
  return out
}

export const goalTitle = (md: string): string => md.match(/^#\s*GOAL\s*[:：]\s*(.+)$/m)?.[1]?.trim() ?? ''

export type Check = { isDone: boolean; text: string; waitsOn: number | null }

const WAIT_TAG = /\s*⏸#(\d+)\s*$/

export function checklist(md: string): Check[] {
  const out: Check[] = []
  for (const line of section(md, '清单')) {
    const m = line.match(/^\s*[-*]\s*\[([ xX✓])\]\s*(.+)$/)
    if (!m) continue
    const raw = (m[2] ?? '').trim()
    const tag = raw.match(WAIT_TAG)
    out.push({ isDone: m[1] !== ' ', text: raw.replace(WAIT_TAG, ''), waitsOn: tag ? Number(tag[1]) : null })
  }
  return out
}

/** 清单里还能做的项:没勾,也没挂在一件还没答的「待 owner」上(owner 勾掉那件,挡住的项就回来)。 */
export function openWork(md: string): Check[] {
  const waiting = new Set(parked(md).filter(p => !p.isDone).map(p => p.n))
  return checklist(md).filter(c => !c.isDone && (c.waitsOn === null || !waiting.has(c.waitsOn)))
}

export const currentItem = (md: string): string => openWork(md)[0]?.text ?? ''

// ---- 待 owner:relay 挂单的战略岔口(不在 C-1 的十节里,挂第一件时追加在文末)
export const PARKED = '待 owner'
export type Parked = { n: number; isDone: boolean; question: string; recommend: string; blocks: string }

export function parked(md: string): Parked[] {
  const out: Parked[] = []
  let inside = false
  for (const line of md.split('\n')) {
    if (/^#{1,2}\s/.test(line)) inside = line.replace(/^##\s*/, '').trim() === PARKED
    else if (inside) {
      const m = line.match(/^\s*[-*]\s*\[([ xX✓])\]\s*#(\d+)\s+(.+)$/)
      if (!m) continue
      const [question = '', ...rest] = (m[3] ?? '').split(/\s+·\s+/)
      const field = (k: string) => rest.find(r => r.startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? ''
      out.push({ n: Number(m[2]), isDone: m[1] !== ' ', question: question.trim(), recommend: field('推荐'), blocks: field('挡住') })
    }
  }
  return out
}

const sameQuestion = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '')
// 「 · 」是待 owner 行的字段分隔符,正文里的换成「 / 」,读回来才是整句
const oneField = (t: string): string => t.replace(/\s+/g, ' ').replace(/ · /g, ' / ').trim()

/**
 * Parks one question: a `- [ ] #n 问题 · 推荐:… · 挡住:…` line under 待 owner, and the blocked checklist item
 * tagged `⏸#n` so currentItem / openWork skip it. A question already open there is not parked twice.
 */
export function park(md: string, asked: string, advice: string, item: string): { md: string; n: number; isNew: boolean; isTagged: boolean } {
  const question = oneField(asked)
  const recommend = oneField(advice)
  const open = parked(md).find(p => !p.isDone && sameQuestion(p.question, question))
  const n = open?.n ?? Math.max(0, ...parked(md).map(p => p.n)) + 1
  let out = md
  if (!open) {
    const entry = `- [ ] #${n} ${question} · 推荐:${recommend || '(没写推荐)'}${item ? ` · 挡住:${item}` : ''}`
    const lines = out.replace(/\s+$/, '').split('\n')
    const start = lines.findIndex(l => /^##\s/.test(l) && l.replace(/^##\s*/, '').trim() === PARKED)
    if (start < 0) out = `${lines.join('\n')}\n\n## ${PARKED}\n${entry}\n`
    else {
      let end = lines.length
      for (let i = start + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i] ?? '')) { end = i; break }
      let at = end
      while (at > start + 1 && (lines[at - 1] ?? '').trim() === '') at--
      lines.splice(at, 0, entry)
      out = `${lines.join('\n')}\n`
    }
  }
  let tagged = false
  if (item) {
    const waiting = new Set(parked(out).filter(p => !p.isDone).map(p => p.n))
    let inList = false
    out = out
      .split('\n')
      .map(l => {
        if (/^#{1,2}\s/.test(l)) inList = /^##\s/.test(l) && sectionOf(l) === '清单'
        if (tagged || !inList) return l
        const m = l.match(/^(\s*[-*]\s*\[ \]\s*)(.+?)\s*$/)
        const text = (m?.[2] ?? '').replace(WAIT_TAG, '')
        const tag = (m?.[2] ?? '').match(WAIT_TAG)
        if (!m || text !== item || (tag && waiting.has(Number(tag[1])))) return l
        tagged = true
        return `${m[1]}${text} ⏸#${n}`
      })
      .join('\n')
  }
  return { md: out, n, isNew: !open, isTagged: tagged }
}

/** 早上的那份汇总:没答的待 owner 项,每条带推荐和它挡住的项。空串 = 没有。 */
export function parkedSummary(md: string): string {
  const open = parked(md).filter(p => !p.isDone)
  if (!open.length) return ''
  return [
    `要你定的 ${open.length} 件(「${PARKED}」):`,
    ...open.map(p => `#${p.n} ${p.question}\n   推荐:${p.recommend || '(没写推荐)'}${p.blocks ? `\n   挡住:${p.blocks}` : ''}`),
  ].join('\n')
}

export const ledger = (md: string): string[] => section(md, '改道账').filter(l => /^\s*[-*]\s/.test(l)).map(l => l.trim())

export type Acceptance = { command: string; exitCode: number; line: string }

// Each list line of 验收 with a `code span` is a command; an expectation written as
// `exit N` / `退出码 N` outside the span is the exit code wanted, 0 when unstated.
export function acceptance(md: string): Acceptance[] {
  const out: Acceptance[] = []
  for (const line of section(md, '验收')) {
    if (!/^\s*(?:[-*]|\d+[.)])\s/.test(line)) continue
    const m = line.match(/`([^`]+)`/)
    if (!m || !m[1]?.trim()) continue
    const rest = line.replace(m[0], ' ')
    const want = rest.match(/(?:exit(?:\s*code)?|退出码|退)\s*[=:：]?\s*(\d+)/i)
    out.push({ command: m[1].trim(), exitCode: want ? Number(want[1]) : 0, line: line.trim() })
  }
  return out
}

export type Altitude = { line: string; filled: boolean; asksOwner: boolean }

const ALTITUDE_KEYS = new Set(['再往上一层', '长期化', '难目标', '外部判官'])
const ASKS_OWNER = /→\s*问\s*owner\s*[:：]/

// 高度 (myapp 10.17 GOAL §高度; grill 铁律 8): the four depth lines a GOAL answers before relay drives
// it, one each, in any order — a line the fork left out is simply absent, never faked. `filled` is the
// reading the section is judged on, so 「无」 and an empty answer do not count. `asksOwner` is the
// 追问链 tail: only the answer that has to climb to owner carries `→ 问 owner:` (≤ 1 per GOAL wanted).
export function altitude(md: string): Altitude[] {
  const out: Altitude[] = []
  for (const raw of section(md, '高度')) {
    const line = raw.trim()
    const m = line.match(/^[-*]\s*\*\*(.+?)\*\*\s*[:：]\s*(.*)$/)
    if (!m || !ALTITUDE_KEYS.has(m[1] ?? '')) continue
    const answer = (m[2] ?? '').trim()
    out.push({ line, filled: answer !== '' && answer !== '无', asksOwner: ASKS_OWNER.test(line) })
  }
  return out
}

// Appends one ledger line at the end of 改道账 (adding the section when missing).
export function appendLedger(md: string, entry: string): string {
  const lines = md.replace(/\s+$/, '').split('\n')
  const start = lines.findIndex(l => /^##\s/.test(l) && sectionOf(l) === '改道账')
  if (start < 0) return `${lines.join('\n')}\n\n## 改道账\n${entry}\n`
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i] ?? '')) {
      end = i
      break
    }
  }
  let at = end
  while (at > start + 1 && (lines[at - 1] ?? '').trim() === '') at--
  lines.splice(at, 0, entry)
  return `${lines.join('\n')}\n`
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const mmdd = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`
}
export const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const ledgerLine = (ms: number, reason: string, item: string): string => `- ${mmdd(ms)} ${hhmm(ms)} · 触发 ${reason} · → ${item}`

export type Relay =
  | { kind: 'continue'; phase: string | null }
  | { kind: 'done' }
  | { kind: 'owner'; question: string; recommend: string }
  | { kind: 'replan'; reason: string; item: string }
  | { kind: 'none' }

const meaningful = (answer: string): string[] =>
  answer
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !/^`{3,}\w*$/.test(l))

const bare = (line: string): string => line.replace(/^[>*_`\s]+|[*_`\s]+$/g, '')

// C-2: the RELAY line must be the answer's last line.
export function parseRelay(answer: string): Relay {
  const last = meaningful(answer).pop()
  const m = last ? bare(last).match(/^RELAY\s*[:：]\s*(continue|done|owner|replan)\b\s*(.*)$/i) : null
  if (!m) return { kind: 'none' }
  const rest = (m[2] ?? '').trim()
  switch (m[1]?.toLowerCase()) {
    case 'continue':
      return { kind: 'continue', phase: rest.match(/phase\s*=\s*([\w-]+)/i)?.[1]?.toLowerCase() ?? null }
    case 'done':
      return { kind: 'done' }
    case 'owner': {
      const [question = '', ...rec] = rest.split(/\s*[|｜]\s*推荐\s*[:：]\s*/)
      return { kind: 'owner', question: question.trim(), recommend: rec.join(' ').trim() }
    }
    default: {
      const [reason = '', ...item] = rest.split(/\s*(?:->|→)\s*/)
      return { kind: 'replan', reason: reason.trim(), item: item.join(' → ').trim() }
    }
  }
}

const ASKING = /(要不要|是否继续|还是说|你来定|你选|选哪|请选择|需要我|要我继续|shall i|should i|want me to|which option)/i
const OPTION = /^(?:[-*]\s*)?(?:[A-D][).、:]|选项\s*[A-D1-9]|方案\s*[A-D1-9])/

// D-14: the answer (before its RELAY line) ends on a question or a menu of options.
export function endsAsking(answer: string): boolean {
  return askedLine(answer) !== null
}

// The question the answer ends on (its last line, or its last three lines when they are a menu), null when none.
export function askedLine(answer: string): string | null {
  const lines = meaningful(answer)
  if (lines.length && /^RELAY\s*[:：]/i.test(bare(lines[lines.length - 1] ?? ''))) lines.pop()
  const last = lines[lines.length - 1]
  if (!last) return null
  if (/[?？]\s*$/.test(last) || ASKING.test(last)) return bare(last)
  const menu = lines.slice(-3).filter(l => OPTION.test(l))
  return menu.length >= 2 ? menu.map(bare).join(' / ') : null
}

// 「要不要继续」这类:答案永远是继续,不值得挂给 owner。
const ASKS_TO_GO_ON = /(要不要继续|是否继续|要我继续|需要我继续|继续吗|接着做吗|shall i (continue|proceed)|should i (continue|proceed)|want me to (continue|proceed))/i
export const asksToGoOn = (line: string): boolean => ASKS_TO_GO_ON.test(line)

// The tail of a command's output for the failing-acceptance prompt.
export const tail = (text: string, n = 40): string => text.replace(/\s+$/, '').split('\n').slice(-n).join('\n')

export const PROTOCOL = [
  '每轮回答最后一行单独写一行 RELAY(relay 机械解析):',
  '`RELAY: continue phase=<plan|build|review|chore|wait>` 还有活 · `RELAY: done` 认为做完(relay 亲自跑验收)·',
  '`RELAY: owner <一句问题> | 推荐: <你的推荐>` 只限战略岔口(不可逆 · 钱与权限 · 对外发出 · 产品方向):relay 把它挂进 GOAL「待 owner」、标住当前项,你接着做下一项,不等回复 ·',
  '`RELAY: replan <原因> -> <新项>` 命中抢占规则改道(不停)。',
  '其余岔口(选型、判法、合不合、先做哪个)按你自己的推荐直接定,在改道账或决策账记一行,不问。',
  'phase=wait 只在确有在跑的 omd-lite run / 子 agent / 后台 shell 或 Monitor 时写。整理完、阶段总结、问「要不要继续」、给选项都不是停机条件。',
].join('\n')

export const kickoffPrompt = (path: string): string =>
  `[relay] GOAL 已写好并激活:${path}。先读它,从「清单」最上面未勾项开工,按 GOAL 推进,直到「验收」命令全过。\n${PROTOCOL}`

// /goal finished while a turn ran: delivered after that turn's next tool result, so the lead learns now (23.10 otherapp
// wrote its own GOAL.md over relay's while the kickoff queued behind its turn).
export const midTurnKickoff = (path: string): string =>
  `${kickoffPrompt(path)}\n这份是 relay 按 /goal 写的,不要自己再写 GOAL.md(要改就在这份上改);这一轮手上的事做完就按它开工,本轮回答末行起照写 RELAY 行。`

const WAKE_STEP = '看在跑的 run / 子 agent 结果 → 读 diff 对任务书 → 合并 → 推进最上面未勾项 → 更新 GOAL 清单(带证据)与 _NEXT.md'

export const parkedPrompt = (path: string, n: number, question: string, item: string): string =>
  `[relay] 「${question}」已挂进 GOAL ${path} 的「${PARKED}」(#${n}),早上一起给 owner,不等回复。${item ? `接着做下一项:${item}。` : ''}末行照写 RELAY 行。`

export const continuePrompt = (path: string, phase: string, item: string, note = ''): string =>
  `[relay] 按 GOAL 继续:${path}(phase=${phase}${item ? `;当前项:${item}` : ''})。${note}每次醒来:${WAKE_STEP}。末行照写 RELAY 行。`

// D-6 (契约 2026-10-23-relay-orphan-goal,原文):the note of the one prompt relay sends after a revive.
export const REVIVE_NOTE = '属主进程断了，已复活。'
export const REVIVE_WAITING_NOTE =
  '属主进程断了，已复活。这份 GOAL 在等 owner:这一轮只重新挂单，不改任何文件、不提交，带 ⏸ 的清单项一个字都不改，末行写 RELAY: owner <待 owner 里原来的问题> | 推荐: <原来的推荐>。'

// Every line of the GOAL carrying ⏸, in order and verbatim: what a waiting-owner revive turn must leave as it found.
export const waitLines = (md: string): string[] => md.split('\n').filter(l => l.includes('⏸'))

export const nudgePrompt = (path: string): string =>
  `[relay] 上一轮没有以 RELAY 行收尾,或停在了问句 / 选项上。整理、总结、问要不要继续都不是停机条件:按 GOAL ${path} 直接做下一步;战略岔口写 RELAY: owner <问题> | 推荐: <推荐>(挂单不停)。\n${PROTOCOL}`

export const idleNudgePrompt = (pending: string): string =>
  `[relay] 上一轮不是 owner 推的,却停在了问他上;他多半不在,这一问会让工厂空等。技术岔口按你的推荐直接定,记一行决策账,接着做下一件。战略岔口(不可逆 · 钱与权限 · 对外发出 · 产品方向)在回答最后一行写 RELAY: owner <问题> | 推荐: <推荐>,relay 把它记进 ${pending},早上一起给 owner;然后去做不依赖它的活。`

export const ownerReplyNote = (path: string): string =>
  `[relay] 这是 owner 的回复。它答了 ${path}「${PARKED}」里的哪几件,就把那几行勾成 [x] 并在行尾写上他的答案;被它们挡住的清单项会自动回到清单。`

export const waitInvalidPrompt = (path: string): string =>
  `[relay] 你写了 phase=wait,但现在没有在跑的 omd-lite run、子 agent、后台 shell 或 Monitor:没有在等的东西,wait 不成立。按 GOAL ${path} 推进下一项;真要等外部的事,先把它启动起来再写 wait。`

export const heartbeatPrompt = (path: string, minutes: number): string =>
  `[relay] 心跳:已等 ${minutes} 分钟。查在等的 run / 子 agent / 后台任务:结束了就收结果,按 GOAL ${path} 推进;还在跑就再写 RELAY: continue phase=wait。`

export const acceptFailPrompt = (path: string, a: Acceptance, got: number | string, out: string): string =>
  `[relay] 你写了 RELAY: done,但验收没过(GOAL ${path}):\n\`${a.command}\` 期望退出码 ${a.exitCode},实际 ${got}。输出末尾:\n\`\`\`\n${out}\n\`\`\`\n修好再写 RELAY: done;验收命令本身写错了就改 GOAL 的「验收」节并在改道账说明。`

export const noAcceptancePrompt = (path: string): string =>
  `[relay] 你写了 RELAY: done,但 GOAL ${path} 的「验收」节没有可跑的命令(每行要有一个 \`命令\`,可写「→ exit 0」)。补上验收命令并跑过,再写 RELAY: done。`

export type ContextFile = { name: string; text: string }

const CONTEXT_CAP = 12_000
const clip = (text: string): string => (text.length > CONTEXT_CAP ? `${text.slice(0, CONTEXT_CAP)}\n…(截断)` : text)

// The one message the fork answers: turn owner's line into a GOAL.md that follows C-1.
export function goalPrompt(line: string, files: readonly ContextFile[], day: string): string {
  return [
    `你是 lead,替 owner 把他的一句话目标写成 GOAL.md(docs/plan/${day}/GOAL.md)。relay 会机械地读它:驱动 loop、在 RELAY: done 时逐条跑「验收」命令、按 effort 表切 effort、往改道账追加。`,
    '',
    `owner 的原话(逐字):${line}`,
    '',
    '严格照下面模板的十个二级标题、原样标题文字和顺序写,不增不删,每节写本仓具体内容(标题后的说明文字删掉,换成内容):',
    GOAL_TEMPLATE,
    '',
    '要求:',
    '- 第一行 `# GOAL: <一句话终点>`。',
    '- 原话:owner 这句原话逐字放第一行(`> ` 引用),会话里他与本目标有关的原话也逐字引上。',
    '- 终点状态:做完时可观察的世界(文件、命令输出、页面行为),不写过程。',
    '- 高度:四行每行以「**再往上一层**」「**长期化**」「**难目标**」「**外部判官**」之一开头;每行只写 lead 自己的答案(材料:PRODUCT.md · _NEXT.md · DECISIONS-PENDING · 现有读数与闸);真要升到 owner 的格(命中 owner 四类,或另开 GOAL 且碰业务方向)才在行末写「→ 问 owner:<一句>」,运营与调度不许写;答不出写「无」,但「无」不算答了 —— 至少两行不是「无」。',
    '- 验收:每行 `- \\`命令\\` → exit 0`,命令在仓根直接可跑、不交互、10 分钟内结束,合起来能证明终点状态;用仓里真有的脚本(看 CLAUDE.md、package.json 惯例)。',
    '- 清单:`- [ ] 项`,按先后排,每项小到一两轮能交付;不写做法与第一步。',
    '- 抢占规则:本仓的 P0 类(线上回归、性能超预算、数据错、安全、主干红)具体化成可判断的条件;命中即 RELAY: replan,不停。',
    '- 停机条件:done / owner(只列真正改终点的岔口)/ stuck(同一项 3 轮无新证据)/ 预算。',
    '- 不许停的情况:照模板写明整理完、阶段总结、问要不要继续、给选项都不是停机条件。',
    '- effort:每行 `- <phase>=<low|medium|high|xhigh|max>`,至少含 plan、build、review、chore。',
    '- 改道账:留空(relay 追加)。',
    '只输出 GOAL.md 的 markdown 本身:不要代码围栏、不要前言或说明。',
    '',
    '仓库上下文:',
    ...(files.length ? files.map(f => `=== ${f.name} ===\n${clip(f.text)}`) : ['(没有 CLAUDE.md / _NEXT.md / TODO / 上一份 GOAL)']),
  ].join('\n')
}

// Makes a generated GOAL safe for relay to read: fences stripped, a title, owner's line verbatim
// under 原话, and every C-1 section present (missing ones appended with the template's hint).
export function normalizeGoal(raw: string, line: string): string {
  let md = raw.trim().replace(/^```\w*\n/, '').replace(/\n```\s*$/, '').trim()
  const titleAt = md.search(/^#\s*GOAL\s*[:：]/m)
  if (titleAt > 0) md = md.slice(titleAt)
  if (titleAt < 0) md = `# GOAL: ${line}\n\n${md}`
  const hints = new Map(GOAL_TEMPLATE.split('\n').slice(1).map(l => [sectionOf(l), l.replace(/^##\s*\S+\s*/, '')]))
  for (const name of SECTIONS) {
    if (md.split('\n').some(l => /^##\s/.test(l) && sectionOf(l) === name)) continue
    md += `\n\n## ${name}\n${name === '原话' ? '' : `(待补:${hints.get(name) ?? ''})`}`
  }
  if (!section(md, '原话').some(l => l.includes(line))) {
    const lines = md.split('\n')
    const at = lines.findIndex(l => /^##\s/.test(l) && sectionOf(l) === '原话')
    lines.splice(at + 1, 0, `> ${line}`)
    md = lines.join('\n')
  }
  return `${md.trim()}\n`
}
