// S8(MyApp docs/plan/myapp-merge-note-brief.md):合并说明本身要机械含三行 —— 被审 SHA / 判词 / 闸日志。
// G-R 管的是「这个分支该不该合」(碰敏感路径要有判词);S8 管的是「合进去的那一刻,记录跟着走」:
// 合并提交的说明(多个 -m 或 -F 文件)里必须有这三行,否则事后没人从 git log 里读得出审的是哪一版、
// 判词在哪、那一轮闸的日志在哪。作用面与 G-R 一致:配置仓(reviewGateRepos)主 worktree 里的 git merge。
// 例外是 `--ff-only` 的快进:它不生成提交,git 回「Fast-forward (no commit created; -m option ignored)」,
// 说明里那三行哪里都不落,要求它只是仪式。那种 merge 改判「要快进主干的分支头 = 闸日志末尾的 head_end,
// 或者在它之后只推进了 docs/*.md」,说明里只认闸日志那一行(见 ffGateHead 与那几条 ff* 拒绝文字)。
// S9:同一道合并闸上还多一条判据 —— 把 omdl/* 那一版合进来,要有一份绑到同一个被审提交的**规格判词**
// (factory/dev/spec-check.mjs <run> 写进 <runs>/<run>/spec-verdict.json):判官问够 3 遍取并集、判完之后
// 任务书一个字没改过、missing · extra · wrong 要么全空要么带理由接受过。19.10 规格重审漏掉的三片都是 lead 在
// claude-mods 手收的,而上面这些只管 reviewGateRepos(默认 myapp),那些合并一道机器判词都不查。

import { GIT_VALUE_OPTS, shellCommands } from './rules'

// `git merge` 的控制类参数:不是一次合并,本条不查(与 review-gate 的 MERGE_CONTROL 同)。
const MERGE_CONTROL = new Set(['--abort', '--continue', '--quit', '--skip'])
// 取值的说明类参数;-F / --file 的值是文件路径,与 -m 的说明文本分开处理。
const MESSAGE_OPTS = new Set(['-F', '--file'])

// 说明里必须机械含到的三行,顺序即拒绝文字里「缺 …」的顺序。
// 「闸日志」那一行带捕获组:快进那条判法要拿它的绝对路径。
const GATE_LOG_LINE = /^闸日志: (\/\S+)$/m
const NOTE_LINES: [string, RegExp][] = [
  ['被审 SHA', /^被审 SHA: [0-9a-f]{40}$/m],
  ['判词', /^判词: \S/m],
  ['闸日志', GATE_LOG_LINE],
]

/**
 * 一条 `git merge …` 命令给的合并说明;null = 不是合并,本条不查。
 * `words` 是那条命令的词表(带或不带 `git` 前缀都行)。多个 -m 按 git 语义用空行拼成段落;
 * -F / --file 读文件(相对 `cwd`,即这条 merge 实际跑着的目录),读不到 → null(git 自己也读不到那个文件,
 * 合并不会发生)。既没有 -m 也没有 -F → git 用默认说明「Merge branch 'x'」→ 空串 = 没说明 = 拦。
 */
export async function mergeMessage(
  words: string[],
  readFile: (p: string) => Promise<string | null>,
  cwd: string,
): Promise<string | null> {
  const at = words[0] === 'git' ? words.indexOf('merge') : -1
  const args = at < 0 ? words : words.slice(at + 1)
  if (args.some(a => MERGE_CONTROL.has(a))) return null
  const parts: string[] = []
  for (let i = 0; i < args.length; i++) {
    const t = args[i] as string
    if (t === '-m') {
      if (args[i + 1] !== undefined) parts.push(args[++i] as string)
    } else if (MESSAGE_OPTS.has(t) || t.startsWith('--file=')) {
      const f = t.startsWith('--file=') ? t.slice('--file='.length) : args[++i]
      if (f === undefined) return null
      const text = await readFile(f.startsWith('/') ? f : `${cwd.replace(/\/+$/, '')}/${f}`)
      if (text === null) return null
      return text
    }
  }
  return parts.join('\n\n').trim()
}

// 说明缺哪几行;三行齐了返回 []。
export function missingNoteLines(msg: string): string[] {
  return NOTE_LINES.filter(([, re]) => !re.test(msg)).map(([name]) => name)
}

// 说明里「被审 SHA:」那一行的 40 位值;没有这一行 → null(那是 missingNoteLines 的事)。
export function reviewedSha(msg: string): string | null {
  return /^被审 SHA: ([0-9a-f]{40})$/m.exec(msg)?.[1] ?? null
}

// 说明里「闸日志:」那一行的绝对路径;没有这一行 → null(那是 missingNoteLines 的事)。
export function noteGateLog(msg: string): string | null {
  return GATE_LOG_LINE.exec(msg)?.[1] ?? null
}

/**
 * 一份闸日志里闸判过的分支头(闸的包装写的:首行 base=…,末尾 exit=<码> 与 head_end=<sha> branch=<名>):
 * 最后一行 head_end 的 40 位值 —— 一份日志里闸跑过多轮,判过的是最后一轮。没有这样的行 → null。
 * 快进不落说明,真正要证的是「快进进主干的分支头就是这一行」,所以取最后一行而不是第一行。
 */
export function ffGateHead(log: string): string | null {
  const ends = [...log.matchAll(/^head_end=([0-9a-f]{40})\b/gm)]
  return ends.length ? (ends[ends.length - 1] as RegExpExecArray)[1] as string : null
}

// 形状对、仓里却没有这个提交:补零或编出来的 SHA 只有跑 git 才看得出来。
export const noteShaDeny = (repo: string, sha: string): string =>
  `agent-guard(S8):被审 SHA ${sha} 在仓里不是一个提交(git cat-file -e 找不到)—— 合进 ${repo} 主干的说明要写闸判过的那个提交的完整 SHA。`

// 拒绝文字。缺哪几行就说哪几行,后面是三行的写法与最省事的做法。
export const noteDeny = (repo: string, missing: string[]): string =>
  `agent-guard(S8):合并说明缺「${missing.join(' · ')}」—— 合进 ${repo} 主干的说明要机械含三行:` +
  '被审 SHA: <sha> / 判词: <路径 | 不需跨模型审(needs-cross-review 0)> / 闸日志: <路径>。' +
  '用 scripts/dev/omdl-merge.sh 合,或 -m 里自己写全。'

// 闸自己判不了(接不回词表 / 读说明文件抛)时的提示:放行,但要说一句。
export const noteFaultToast = (why: string): string => `agent-guard(S8):判不了合并说明(${why}),已放行`

// 快进:说明里没有闸日志那一行(快进不生成提交,没有说明可落,闸日志只能从命令词里读)。
export const ffLogDeny = (repo: string): string =>
  `agent-guard(S8):快进缺「闸日志: <路径>」—— 快进 ${repo} 主干要指向判过这个分支头的那份闸日志(末尾有 exit=0 与 head_end=<sha>)。`

// 快进:闸日志读到了,但里面没有闸绿(exit=0)与分支头(head_end)这两行,判不出闸判的是哪个头。
export const ffUnjudgedDeny = (path: string): string =>
  `agent-guard(S8):闸日志 ${path} 里没有 exit=0 与 head_end 两行,判不出闸绿时的分支头。`

// 快进:现在要合进主干的分支头不是闸判过的那个头 —— 闸判完分支又动过。
export const ffHeadDeny = (branch: string, head: string, path: string, headEnd: string): string =>
  `agent-guard(S8):${branch} 现在是 ${head},闸日志 ${path} 判的是 ${headEnd} —— 闸判过之后分支又动过,重跑闸再快进。`

// 快进:闸日志判的那个头压根不在这条分支的祖先链上(rebase 过 / 拿的是别的分支的日志),两份记录没有可比性。
export const ffNotAncestorDeny = (branch: string, path: string, headEnd: string): string =>
  `agent-guard(S8):闸日志 ${path} 判的 ${headEnd} 不是 ${branch} 的祖先 —— 这份日志判的不是这条分支,重跑闸再快进。`

/**
 * 闸判过的那个头(head_end)到分支头之间进来的改动:只放行 docs/ 下的 Markdown。空数组也放行
 * (= 闸后没有文件改动,只有提交)。docs/ 下也有闸会跑的东西(docs/design/tests/*.mjs、原型 *.tw.html
 * 被 check-sync 判),所以只认 docs/*.md,其余一律当代码。G-R 能放过测试与探针,是因为它审的是代码;
 * 快进闸判的就是这些测试本身,闸后再改测试等于这道闸没跑过。
 */
export function docsOnlyDrift(paths: string[]): boolean {
  return paths.filter(p => p !== '').every(p => p.startsWith('docs/') && p.endsWith('.md'))
}

// 快进:一条 merge 合的不是一个分支,head_end 只判一个分支的头。
export const ffBranchesDeny = (branches: string[]): string =>
  `agent-guard(S8):这条快进合的是 ${branches.join(' · ')},闸日志末尾的 head_end 只判一个分支的头 —— 拆成一条条 merge,每条带自己那份闸日志。`

// A `git merge` command's words (as shellCommands splits them), the subcommand found past git's global options.
const isMerge = (w: string[]): boolean => {
  if (w[0] !== 'git') return false
  for (let i = 1; i < w.length; i++) {
    const t = w[i] as string
    if (GIT_VALUE_OPTS.has(t)) i++
    else if (t.startsWith('-')) continue
    else return t === 'merge'
  }
  return false
}

/**
 * 每个 merge 各自的命令词表,与 `gitMerges` 的结果一一同序(gitMerges 已判出哪条命令合哪个分支,
 * 这里把说明参数接回去)。按行内次序两两配对:一条 merge 命令的词表含这个 merge 的全部分支名、
 * 且没有控制类参数时才算它;配不上 → null,让调用方当闸故障处理(放行 + toast),不静默放过。
 */
export function mergeWordsIn(line: string, merges: { branches: string[] }[]): (string[] | null)[] {
  const cmds = shellCommands(line).filter(isMerge)
  const taken = new Set<number>()
  return merges.map(m => {
    const i = cmds.findIndex((w, k) =>
      !taken.has(k) && !w.some(a => MERGE_CONTROL.has(a)) && m.branches.every(b => w.includes(b)))
    if (i < 0) return null
    taken.add(i)
    return cmds[i] as string[]
  })
}

/**
 * S9:omdl/<片名> 这一片的 run 名(判词目录名,spec-check.mjs 吃的就是它);别的前缀 —— land/* · fix/* ·
 * lead 自己的分支 —— 不是这一条的管法,返回 null(调用方当不管处理)。
 * 全是点的名字(`omdl/..`)也当不管:那会把判词路径指到 <runs> 外面去(git 自己就拒这种 ref 名,这里是手写命令那一条路)。
 */
export function specGateRun(branch: string): string | null {
  const name = /^omdl\/([^/]+)$/.exec(branch)?.[1]
  return name && !/^\.+$/.test(name) ? name : null
}

// 判词文件的形状(S9a 写,S9c 续):head 绑被审提交,missing · extra · wrong 三组,再带 specSha(判的时候
// 任务书内容的 sha256)与 runs(判官问了几遍,取并集前一共问过多少遍)—— 三组全空只是必要条件。
type SpecVerdict = { head: string; missing: string[]; extra: string[]; wrong: string[]; specSha?: string; runs?: number; accepted?: { why?: unknown } }

// S9c:判官至少要问这么几遍才当这一片的读数(一遍就刷绿的判词不算 —— 同一片重跑到绿是常事,
// 13031fb 连跑 5 次判绿 1/5,3 次并集的行为级召回 94%)。旧判词没有 runs 一键,一律按不足 3 拒。
const SPEC_RUNS = 3

// 解析不出这个形状一律当「没判过」:坏 JSON、缺字段、head 不是字符串、三组不是数组 ——
// 判不出核过不核过,不能因此放行(放行要有一份读得出形状且绑住这一版的判词)。
function parseSpecVerdict(text: string): SpecVerdict | null {
  try {
    const v = JSON.parse(text) as Partial<SpecVerdict> | null
    const ok = typeof v?.head === 'string' &&
      Array.isArray(v.missing) && Array.isArray(v.extra) && Array.isArray(v.wrong)
    return ok ? (v as SpecVerdict) : null
  } catch {
    return null
  }
}

/**
 * 这一片这一版有没有过机器规格判:任一份候选解析成功、head 就是这次要合的那个 sha、判官问够 SPEC_RUNS 遍、
 * specSha 等于钩子读到的任务书当前内容的 sha256、且(三组全空 或 `accepted.why` 非空)→ null(放行)。
 * 候选是 <runs>/<片名>/spec-verdict.json 与续跑的 <runs>/<片名>-r<数字>/spec-verdict.json(读到的那些由调用方给;
 * 列目录 / 读文件读不动的处置在钩子那层,不在这里)。`specShaNow` 是任务书当前内容的 sha256;候选自带 specSha 时用它
 * (不同候选的 spec 路径可能不同,任务书内容也就可能不同 —— 钩子那层按每份候选自己的路径算好了传进来),
 * 没有就拿这个当兜底;两者都没有 = 读不到任务书 → 当不匹配。
 * 否则回一段拒绝文字:查了哪些文件、每份为什么不放行、下一步跑哪条命令 —— 「没判过」要能一眼看出是哪一份判词的什么毛病。
 */
export function specVerdictDeny(
  branch: string,
  sha: string,
  candidates: { path: string; text: string; specSha?: string | null }[],
  specShaNow: string | null,
): string | null {
  const name = specGateRun(branch) ?? branch
  const why: string[] = []
  for (const { path, text, specSha } of candidates) {
    const v = parseSpecVerdict(text)
    if (!v) {
      why.push(`${path}:解析不了(坏 JSON 或不是判词形状)`)
      continue
    }
    if (v.head !== sha) {
      why.push(`${path}:head 不同(判词 ${v.head.slice(0, 9)} · 要合的 ${sha.slice(0, 9)})`)
      continue
    }
    if (!(typeof v.runs === 'number' && v.runs >= SPEC_RUNS)) {
      why.push(`${path}:runs 不足 ${SPEC_RUNS}(判官一共只问了 ${typeof v.runs === 'number' ? v.runs : 0} 遍 —— 重跑到绿的那一遍不算数)`)
      continue
    }
    const now = specSha === undefined ? specShaNow : specSha
    if (v.specSha !== now) {
      const said = typeof v.specSha === 'string' ? v.specSha.slice(0, 9) : '没记(旧判词)'
      why.push(`${path}:任务书改过(判词记的 specSha ${said} · 任务书现在的 ${now ? now.slice(0, 9) : '读不到'})`)
      continue
    }
    const accepted = typeof v.accepted?.why === 'string' && v.accepted.why.trim() !== ''
    if (v.missing.length + v.extra.length + v.wrong.length && !accepted) {
      why.push(`${path}:判词没过(missing ${v.missing.length} · extra ${v.extra.length} · wrong ${v.wrong.length})`)
      continue
    }
    return null
  }
  if (!why.length) {
    why.push(`查过 ${name}/spec-verdict.json 与 ${name}-r<数字>/spec-verdict.json:没有 spec-verdict.json`)
  }
  return `agent-guard(S9):${branch} 这次合并没有一份绑到 ${sha.slice(0, 9)}、判官问够 ${SPEC_RUNS} 遍、任务书一个字没改过的规格判词 —— ${why.join(';')}。` +
    `下一步:node <lead-harness>/factory/dev/spec-check.mjs ${name}(一次跑 ${SPEC_RUNS} 遍取并集;有条目时修掉,或逐条看过后 --accept --why "<理由>" 接受)`
}
