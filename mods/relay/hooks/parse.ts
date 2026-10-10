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

// The note the agent reads beside the prompt once the threshold is passed.
export function handoffNote(tokens: number, path: string): string {
  return [
    `[relay] 上下文已到 ${Math.round(tokens / 1000)}k。先把这条消息处理完,然后写交接到 ${path}(覆盖写),供清空上下文后的新 session 接着做。必须包含:`,
    '1. 当前目标与用户最近的原话要求;2. 已完成(带提交号 / 文件路径);3. 在跑的东西(子 agent、外部 run(omd-lite 等)、后台命令)及怎么收;',
    '4. 下一步按顺序;5. 开工要读的文件;6. 若本 session 有 /loop 或 goal,原样写出它的 prompt,新 session 要重新启动;7. 等用户拍板的事项。',
    '会话内的子 agent / Workflow 先收完再写(/clear 会丢掉它们);外部 run(omd-lite 等)、tmux 进程不受影响,写进交接即可。',
    '写完后,回复最后一行单独写 HANDOFF-READY。之后会自动 /clear 并让新 session 读这个文件。不要在没写完交接时写这个标记。',
  ].join('\n')
}

// checkpoint: omd continuity hook 给上一段 session 写的 checkpoint(没有就是 null);clear 前已补存过一次,是 clear 那一刻的。
// goals: 仓里的目标文件(最新的 docs/plan/*/GOAL.md 与 docs/plan 下的 LOOP-GOAL.md),交接漏写 loop / goal 时新 session 从这里拿。
// 交接是 agent 写的意图与下一步,checkpoint 是模型从 transcript 蒸馏的历史;两份互证。
// active: relay 激活中的 GOAL(D-20):续接 prompt 必带它的路径与 phase,新 session 里 relay 已重新接上续跑。
export const resumePrompt = (
  path: string,
  checkpoint: string | null = null,
  goals: readonly string[] = [],
  active: { path: string; phase: string } | null = null,
): string =>
  `[relay] 上一段上下文已自动清空。先读交接 ${path}` +
  (checkpoint ? `,再读 omd checkpoint ${checkpoint} 补细节(两者冲突时以交接为准)` : '') +
  (goals.length ? `,再读目标文件 ${goals.join('、')}` : '') +
  `;与 git log / 仓内文件冲突时以后者为准。若交接里有 /loop 或 goal,用相同 prompt 重新启动` +
  (goals.length ? '(交接没写就按目标文件里的 loop 写法重启)' : '') +
  `;然后按「下一步」接着做。` +
  (active
    ? `\n激活中的 GOAL:${active.path}(phase=${active.phase})。relay 已在新 session 接上自动续跑:按它的清单推进,每轮回答最后一行照写 RELAY 行。`
    : '')

export const isReadyAnswer = (answer: string): boolean => /^\s*HANDOFF-READY\s*$/m.test(answer)
