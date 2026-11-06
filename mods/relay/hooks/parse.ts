// Pure readers of the files and command output the status is built from.

// `df -BG --output=avail <path>` → free gigabytes.
export function parseDf(stdout: string): number | null {
  const m = stdout.trim().split('\n').pop()?.trim().match(/^(\d+)G$/)
  return m ? Number(m[1]) : null
}

// Open rows of docs/plan/DECISIONS-PENDING.md: `| 12 | 问题 | …`, a struck-out
// question (~~…~~) or one marked 关闭 counts as closed.
export function openDecisionRows(md: string): string[] {
  return md
    .split('\n')
    .filter(l => /^\|\s*\d+\s*\|/.test(l))
    .map(l => l.split('|')[2]?.trim() ?? '')
    .filter(q => q !== '' && !q.startsWith('~~') && !/关闭/.test(q))
}

// Open bullets under a GOAL.md's `## §9` heading; struck-out ones are settled.
export function openGoalNine(md: string): string[] {
  const out: string[] = []
  let inside = false
  for (const line of md.split('\n')) {
    if (/^## /.test(line)) inside = /^## §9/.test(line)
    else if (inside && /^- /.test(line) && !/^- ~~/.test(line)) out.push(line.slice(2).trim())
  }
  return out
}

export const short = (s: string, n = 60): string => {
  const plain = s.replace(/\*\*/g, '').replace(/`/g, '')
  return plain.length > n ? `${plain.slice(0, n)}…` : plain
}

/** What the handoff needs of one run: the fields of delegate's C-0 `DelegateRun` it prints (relay does not depend on delegate). */
export type HandoffRun = { label: string; state: string; round?: number; maxRounds?: number; failureClass?: string; stuck?: string }

const MAX_RUN_LINES = 12
const REDISPATCH = /-p2(-r\d+)?$/
const RESUMED = /^(.*)-r\d+$/

/**
 * G-9: the handoff's section on runs still going and on what became of the failed ones (auto-redispatch `-p2`, resume `-rN`).
 * `runs` are this session's own (`$.delegate.runs()`), never other sessions' (those are for /ops); null = delegate unreadable.
 */
export function runsSection(runs: readonly HandoffRun[] | null): string {
  if (runs === null) return '本 session 的 run 和重派状态:读不到(delegate 没装或没启用),交接里请自己核对在跑的 run。'
  if (!runs.length) return '本 session 的 run 和重派状态:没有 run。'
  const labels = new Set(runs.map(r => r.label))
  const byLabel = new Map(runs.map(r => [r.label, r]))
  const order = [...runs].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running'))
  const lines = order.slice(0, MAX_RUN_LINES).map(r => {
    const bits = [r.label, r.state]
    if (r.round !== undefined && r.maxRounds !== undefined) bits.push(`第 ${r.round}/${r.maxRounds} 轮`)
    if (r.failureClass) bits.push(r.failureClass)
    if (r.stuck) bits.push(r.stuck)
    const notes: string[] = []
    const p2 = `${r.label}-p2`
    if (REDISPATCH.test(r.label)) notes.push('自动重派的结果,同一 label 不再自动重派')
    else if (labels.has(p2)) notes.push(`已自动重派为 ${p2}(${byLabel.get(p2)?.state})`)
    else if (r.state !== 'running' && r.failureClass === 'provider') notes.push('provider 失败,没有 -p2 重派')
    const resumed = [...labels].find(l => RESUMED.exec(l)?.[1] === r.label)
    if (resumed) notes.push(`已续跑为 ${resumed}(${byLabel.get(resumed)?.state})`)
    return `- ${bits.join(' · ')}${notes.length ? `  → ${notes.join(';')}` : ''}`
  })
  const more = order.length - lines.length
  return ['本 session 的 run 和重派状态(逐条写进交接的「在跑的东西」,在跑的写清怎么收):', ...lines, ...(more > 0 ? [`- 另有 ${more} 个 run 未列出`] : [])].join('\n')
}

// The note the agent reads once the threshold is passed: beside a relay / background prompt under a GOAL, or as the
// prompt /relay go submits. runs: this session's runs for the 「在跑的 run 和重派状态」section; undefined leaves it out.
// clear: the anchor the handoff's first line must carry and what relay itself sees running (subagents, background tasks).
export function handoffNote(tokens: number, path: string, runs?: readonly HandoffRun[] | null, clear?: { anchor: string; inflight: string }): string {
  return [
    `[relay] 上下文已到 ${Math.round(tokens / 1000)}k。写交接到 ${path}(覆盖写),供清空上下文后的新 session 接着做。交接只是记录,不是收尾的信号:手上的事照常做,做不完的写进「下一步」。` +
      (clear ? `交接第一行单独写 relay-anchor: ${clear.anchor}(原样照抄;relay 用它核对交接写在 owner 最后一条消息之后)。` : '') +
      '必须包含:',
    '1. 当前目标与用户最近的原话要求;2. 已完成(带提交号 / 文件路径);3. 在跑的东西(子 agent、MiniMax 片、后台命令)及怎么收;',
    '4. 下一步按顺序;5. 开工要读的文件;6. 若本 session 有 /loop 或 goal,原样写出它的 prompt,新 session 要重新启动;7. 等用户拍板的事项:每项写问题 · 我的推荐 · 备选各一行,要看图的把截图绝对路径逐张列出(清空后用户看不到之前发过的图)。',
    ...(runs === undefined ? [] : [runsSection(runs)]),
    ...(clear ? [`relay 此刻看到的子 agent 与后台任务(逐条带 id 和任务原文写进第 3 节):\n${clear.inflight || '- 无'}`] : []),
    '会话内的子 agent / Workflow 先收完再写(/clear 会丢掉它们);外部的 MiniMax run、tmux 进程不受影响,写进交接即可。',
    '写完后,回复最后一行单独写 HANDOFF-READY。之后会 /clear 并让新 session 读这个文件。不要在没写完交接时写这个标记。',
  ].join('\n')
}

/** One answer owner has not answered yet: given after his last message, kept verbatim. */
export type Said = { at: number; origin: string; text: string }

// pp.kk.vvvv hh:mm, local time.
const two = (n: number): string => String(n).padStart(2, '0')
export const fiTime = (ms: number): string => {
  const d = new Date(ms)
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/**
 * The side file relay writes before a /clear (<handoff>.last.md): owner's last message, the answers after it he has
 * not answered, and what was running, all verbatim. The model's handoff is its reading; this is the record.
 */
export function lastBlock(person: { text: string; at: number } | null, unseen: readonly Said[], inflight: string): string {
  return [
    person ? `## owner 最后一条消息(${fiTime(person.at)} · sha ${anchorOf(person.text)})` : '## owner 最后一条消息',
    person ? person.text : '(本 session 里 relay 没记到 owner 的消息)',
    `## 之后的回答(${unseen.length} 条,owner 未回应)`,
    ...unseen.flatMap((u, i) => [`### ${i + 1} · ${fiTime(u.at).slice(11)} · 来源 ${u.origin || '未知'}`, u.text]),
    '## 在跑的东西(clear 时刻)',
    inflight || '- 无',
    '(以上为 clear 前原文,relay 写入,逐字)',
  ].join('\n')
}

// checkpoint: continuity 给上一段 session 写的 checkpoint(没有就是 null);clear 前已补存过一次,是 clear 那一刻的。
// degraded: 那份是降级版(§1/§2 空或回落写的),只信交接,别拿它当事实。
// goals: 仓里的目标文件(最新的 docs/plan/*/GOAL.md 与 docs/plan 下的 LOOP-GOAL.md),交接漏写 loop / goal 时新 session 从这里拿。
// 交接是 agent 写的意图与下一步,checkpoint 是 MiniMax 从 transcript 蒸馏的历史;两份互证。
// active: relay 激活中的 GOAL(D-20):续接 prompt 必带它的路径与 phase,新 session 里 relay 已重新接上续跑。
// last: clear 前 relay 写的旁车原文与路径(lastBlock);有它时新 session 第一件事是用 SendUserFile 把旁车文件发给 owner。
// 原文不进 prompt、也不让模型复述:10-23 让新会话逐字贴回上一段回答,6 个会话里 3 个被 reasoning_extraction 拦停。
export const resumePrompt = (
  path: string,
  checkpoint: string | null = null,
  goals: readonly string[] = [],
  active: { path: string; phase: string } | null = null,
  degraded = false,
  last: { text: string; path: string; auto: boolean } | null = null,
): string =>
  (last
    ? `[relay] 上一段上下文已${last.auto ? '自动' : '按 /relay go '}清空。开工第一件事:用 SendUserFile 把 ${last.path} 发给 owner(display: render,status: ${last.auto ? 'proactive' : 'normal'}),` +
      `那是 clear 前他还没回应的回答,由文件带给他;不要读它、不要在回答里复述它。然后读交接 ${path}`
    : `[relay] 上一段上下文已自动清空。先读交接 ${path}`) +
  (checkpoint
    ? `,再读 continuity checkpoint ${checkpoint} 补细节(两者冲突时以交接为准)${degraded ? '(这份是降级版,只信交接,别拿它当事实)' : ''}`
    : '') +
  (goals.length ? `,再读目标文件 ${goals.join('、')}` : '') +
  `;与 git log / 仓内文件冲突时以后者为准。若交接里有 /loop 或 goal,用相同 prompt 重新启动` +
  (goals.length ? '(交接没写就按目标文件里的 loop 写法重启)' : '') +
  (active
    ? `;交接「等用户拍板」里的事不要列给用户、不要等:战略岔口(不可逆 · 钱与权限 · 对外发出 · 产品方向)确认已在 GOAL「待 owner」节里(没有就照 RELAY: owner <问题> | 推荐: <推荐> 挂上),其余按交接里的推荐直接定、记进决策账;然后按「下一步」接着做。` +
      `\n激活中的 GOAL:${active.path}(phase=${active.phase})。relay 已在新 session 接上自动续跑:按它的清单推进,每轮回答最后一行照写 RELAY 行。`
    : `;${last ? '发完文件后第二件事' : '开工第一件事'}:把交接「等用户拍板」里的每一项列给用户(问题 · 推荐 · 备选),有截图的用 Read 逐张读出来让用户看到,没有待裁项就说一句没有;列完再按「下一步」接着做。`)

export const isReadyAnswer = (answer: string): boolean => /^\s*HANDOFF-READY\s*$/m.test(answer)

// The answer as owner should read it: the HANDOFF-READY marker is relay's, not his.
export const withoutReady = (answer: string): string => answer.replace(/^\s*HANDOFF-READY\s*$/gm, '').trimEnd()

const FNV_OFFSET = BigInt('0xcbf29ce484222325')
const FNV_PRIME = BigInt('0x100000001b3')
const MASK64 = BigInt('0xffffffffffffffff')

/**
 * The anchor a handoff opens with: FNV-1a 64 over the UTF-16 code units of owner's last message, first 12 hex.
 * It catches a handoff written before owner's last word, not tampering; relay only ever compares it with itself.
 */
export function anchorOf(text: string): string {
  let h = FNV_OFFSET
  for (let i = 0; i < text.length; i++) h = ((h ^ BigInt(text.charCodeAt(i))) * FNV_PRIME) & MASK64
  return h.toString(16).padStart(16, '0').slice(0, 12)
}

