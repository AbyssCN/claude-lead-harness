// Pure readers and writers of GOAL.md (C-1), the RELAY line (C-2) and the prompts relay sends.

export const SECTIONS = ['原话', '终点状态', '验收', '清单', '抢占规则', '停机条件', '不许停的情况', 'effort', '改道账'] as const
export type SectionName = (typeof SECTIONS)[number]

// C-1, verbatim: the shape every GOAL.md relay writes follows.
export const GOAL_TEMPLATE = [
  '# GOAL: <一句话终点>',
  '## 原话            用户原话,逐字',
  '## 终点状态        做完时世界长什么样(可观察,不写过程)',
  '## 验收            每行一条可跑命令 + 期望;relay 在 done 时逐条跑',
  '## 清单            - [ ] 项(每项勾选要带证据:提交号/命令输出路径)',
  '## 抢占规则        命中即改道、不停:P0 类列表(本仓具体化,如:p95 延迟 > X ms)',
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

export type Check = { isDone: boolean; text: string }

export function checklist(md: string): Check[] {
  const out: Check[] = []
  for (const line of section(md, '清单')) {
    const m = line.match(/^\s*[-*]\s*\[([ xX✓])\]\s*(.+)$/)
    if (m) out.push({ isDone: m[1] !== ' ', text: (m[2] ?? '').trim() })
  }
  return out
}

export const currentItem = (md: string): string => checklist(md).find(c => !c.isDone)?.text ?? ''

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
  | { kind: 'owner'; question: string }
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
    case 'owner':
      return { kind: 'owner', question: rest }
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
  const lines = meaningful(answer)
  if (lines.length && /^RELAY\s*[:：]/i.test(bare(lines[lines.length - 1] ?? ''))) lines.pop()
  const last = lines[lines.length - 1]
  if (!last) return false
  if (/[?？]\s*$/.test(last) || ASKING.test(last)) return true
  return lines.slice(-3).filter(l => OPTION.test(l)).length >= 2
}

// The tail of a command's output for the failing-acceptance prompt.
export const tail = (text: string, n = 40): string => text.replace(/\s+$/, '').split('\n').slice(-n).join('\n')

export const PROTOCOL = [
  '每轮回答最后一行单独写一行 RELAY(relay 机械解析):',
  '`RELAY: continue phase=<plan|build|review|chore|wait>` 还有活 · `RELAY: done` 认为做完(relay 亲自跑验收)·',
  '`RELAY: owner <一句问题>` 只限终点本身要改 · `RELAY: replan <原因> -> <新项>` 命中抢占规则改道(不停)。',
  'phase=wait 只在确有在跑的 omd-lite run / 子 agent 时写。整理完、阶段总结、问「要不要继续」、给选项都不是停机条件。',
].join('\n')

export const kickoffPrompt = (path: string): string =>
  `[relay] GOAL 已写好并激活:${path}。先读它,从「清单」最上面未勾项开工,按 GOAL 推进,直到「验收」命令全过。\n${PROTOCOL}`

const WAKE_STEP = '看在跑的 run / 子 agent 结果 → 读 diff 对任务书 → 合并 → 推进最上面未勾项 → 更新 GOAL 清单(带证据)与 _NEXT.md'

export const continuePrompt = (path: string, phase: string, item: string, note = ''): string =>
  `[relay] 按 GOAL 继续:${path}(phase=${phase}${item ? `;当前项:${item}` : ''})。${note}每次醒来:${WAKE_STEP}。末行照写 RELAY 行。`

export const nudgePrompt = (path: string): string =>
  `[relay] 上一轮没有以 RELAY 行收尾,或停在了问句 / 选项上。整理、总结、问要不要继续都不是停机条件:按 GOAL ${path} 直接做下一步;只有终点本身要 owner 改才写 RELAY: owner <问题>。\n${PROTOCOL}`

export const waitInvalidPrompt = (path: string): string =>
  `[relay] 你写了 phase=wait,但现在没有在跑的 omd-lite run,也没有在跑的子 agent:没有在等的东西,wait 不成立。按 GOAL ${path} 推进下一项;真要等外部的事,先把它启动起来再写 wait。`

export const heartbeatPrompt = (path: string, minutes: number): string =>
  `[relay] 心跳:已等 ${minutes} 分钟。查在等的 run / 子 agent:结束了就收结果,按 GOAL ${path} 推进;还在跑就再写 RELAY: continue phase=wait。`

export const acceptFailPrompt = (path: string, a: Acceptance, got: number | string, out: string): string =>
  `[relay] 你写了 RELAY: done,但验收没过(GOAL ${path}):\n\`${a.command}\` 期望退出码 ${a.exitCode},实际 ${got}。输出末尾:\n\`\`\`\n${out}\n\`\`\`\n修好再写 RELAY: done;验收命令本身写错了就改 GOAL 的「验收」节并在改道账说明。`

export const noAcceptancePrompt = (path: string): string =>
  `[relay] 你写了 RELAY: done,但 GOAL ${path} 的「验收」节没有可跑的命令(每行要有一个 \`命令\`,可写「→ exit 0」)。补上验收命令并跑过,再写 RELAY: done。`

export type ContextFile = { name: string; text: string }

const CONTEXT_CAP = 12_000
const clip = (text: string): string => (text.length > CONTEXT_CAP ? `${text.slice(0, CONTEXT_CAP)}\n…(截断)` : text)

// The one message the fork answers: turn the user's line into a GOAL.md that follows C-1.
export function goalPrompt(line: string, files: readonly ContextFile[], day: string): string {
  return [
    `你是这个仓库的 lead,替用户把他的一句话目标写成 GOAL.md(docs/plan/${day}/GOAL.md)。relay 会机械地读它:驱动 loop、在 RELAY: done 时逐条跑「验收」命令、按 effort 表切 effort、往改道账追加。`,
    '',
    `用户的原话(逐字):${line}`,
    '',
    '严格照下面模板的九个二级标题、原样标题文字和顺序写,不增不删,每节写本仓具体内容(标题后的说明文字删掉,换成内容):',
    GOAL_TEMPLATE,
    '',
    '要求:',
    '- 第一行 `# GOAL: <一句话终点>`。',
    '- 原话:用户这句原话逐字放第一行(`> ` 引用),会话里他与本目标有关的原话也逐字引上。',
    '- 终点状态:做完时可观察的世界(文件、命令输出、页面行为),不写过程。',
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

// Makes a generated GOAL safe for relay to read: fences stripped, a title, the user's line verbatim
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
