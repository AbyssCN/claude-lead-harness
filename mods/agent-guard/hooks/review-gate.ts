// G-R(MyApp docs/plan/10.11/px-gates-invariants.md):敏感路径合并前要跨模型审判词。
// 在配置的仓库的主 worktree 里 `git merge <分支>`:该分支相对 HEAD 碰了敏感路径(仓内 scripts/dev/needs-cross-review.sh
// HEAD <分支> 退出 2)→ 要有判词文件且最新一份结论是 SHIP / MERGE,否则拒。判词在该分支或 main 上找:
// docs/reviews/<分支名 / 换 ->.md(review-launch.sh 产出),兼容旧路径 docs/plan/*/<片名>-review.md · -rereview.md
// (按文件名,或正文里提到这个分支);取最近一次提交的那份。
// 15.10 判词绑 SHA:判词要写「被审 SHA:<sha>」,该 SHA 是分支的祖先,且它之后分支上的提交只碰 docs / 测试,
// 否则拒 —— 拿到 SHIP 之后再追加改代码的提交,旧判词不再作数。

import { GIT_VALUE_OPTS, resolvePath, shellCommands } from './rules'

// `git merge` options that take the next word as their value.
const MERGE_VALUE_OPTS = new Set(['-m', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--cleanup', '--into-name'])
const MERGE_CONTROL = new Set(['--abort', '--continue', '--quit', '--skip'])

// Each `git merge` in the line with the directory it runs in and the branches it names (cd walk as in gitWrites).
export async function gitMerges(
  line: string,
  startCwd: string,
  home: string,
  isDir: (abs: string) => Promise<boolean>,
): Promise<{ dir: string; branches: string[] }[]> {
  const found: { dir: string; branches: string[] }[] = []
  let cwd = startCwd
  for (const w of shellCommands(line)) {
    if (w[0] === 'cd') {
      const target = w[1] === undefined || w[1] === '--' ? home : (w[1] as string)
      const abs = resolvePath(cwd, target, home)
      if (await isDir(abs)) cwd = abs
      continue
    }
    if (w[0] !== 'git') continue
    let dir = cwd
    let i = 1
    for (; i < w.length; i++) {
      const t = w[i] as string
      if (t === '-C') dir = resolvePath(dir, w[++i] ?? '.', home)
      else if (GIT_VALUE_OPTS.has(t)) i++
      else if (t.startsWith('-')) continue
      else break
    }
    if (w[i] !== 'merge') continue
    const rest = w.slice(i + 1)
    if (rest.some(a => MERGE_CONTROL.has(a))) continue
    const branches: string[] = []
    for (let j = 0; j < rest.length; j++) {
      const t = rest[j] as string
      if (MERGE_VALUE_OPTS.has(t)) j++
      else if (!t.startsWith('-')) branches.push(t)
    }
    if (branches.length) found.push({ dir, branches })
  }
  return found
}

export type Verdict = 'SHIP' | 'MERGE' | 'FIX-FIRST'

// The verdict of a review report: the first line that starts with 结论 (after markdown marks: `## 结论` ·
// `**结论**` · `- 结论`) and carries a token decides; a bare `## 结论` heading reads the next non-empty line.
// 「上一轮结论:… FIX-FIRST」in the middle of a line does not count. Two different tokens there → null (undecided).
export function verdictOf(md: string): Verdict | null {
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string
    const m = /^[\s#>*-]*结论/.exec(l)
    if (!m) continue
    let text = l.slice(m[0].length)
    if (/^[\s*::]*$/.test(text) && /^#{1,6}\s/.test(l)) text = lines.slice(i + 1).find(x => x.trim() !== '') ?? ''
    const tokens = new Set(text.match(/\b(FIX-FIRST|SHIP|MERGE)\b/g) ?? [])
    if (tokens.size === 0) continue
    return tokens.size === 1 ? ([...tokens][0] as Verdict) : null
  }
  return null
}

// 「被审 SHA:<sha>」行(markdown 修饰同结论行);没有 → null。
export function reviewedShaOf(md: string): string | null {
  const m = /^[\s#>*-]*被审\s*SHA[\s*::]*`?([0-9a-f]{7,40})\b/m.exec(md)
  return m ? (m[1] as string) : null
}

// 审后追加的提交里允许的路径:docs/ 下与任何 .md、测试文件、supabase/ci 的探针 SQL。其余都要重审。
export function postReviewBlockers(paths: string[]): string[] {
  const ok = (p: string) =>
    p.startsWith('docs/') || p.endsWith('.md') ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)__tests__\//.test(p) ||
    /^supabase\/ci\/[^/]+_probes\.sql$/.test(p)
  return paths.filter(p => p !== '' && !ok(p))
}

export const slugOf = (branch: string): string => branch.replace(/\//g, '-')
export const LEGACY_RE = /^docs\/plan\/[^/]+\/(.+?)-(?:re)?review\.md$/

// Verdict files named for this branch: docs/reviews/<slug>.md, or a legacy <片名>-review.md / -rereview.md
// where 片名 is the last segment of the branch, with or without a leading goalNNNN-.
export function verdictPaths(branch: string, files: string[]): string[] {
  const seg = branch.split('/').pop() ?? branch
  const pieces = new Set([seg, seg.replace(/^goal\d+-/, '')])
  return files.filter(f => f === `docs/reviews/${slugOf(branch)}.md` || pieces.has(LEGACY_RE.exec(f)?.[1] ?? '\0'))
}

// ERE that finds the branch name as a whole token (not the prefix of a longer branch name).
export const branchMention = (branch: string): string =>
  `(^|[^A-Za-z0-9/_.-])${branch.replace(/[.[\]()*+?{}|^$\\]/g, '\\$&')}($|[^A-Za-z0-9/_.-])`

export type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string } | null>
export type Gate = { kind: 'pass' } | { kind: 'deny'; text: string } | { kind: 'fault'; text: string }

const launchHint = (branch: string) =>
  `起审:在主仓跑 bash scripts/dev/review-launch.sh ${branch}(omdl/* 分支的实现者是 MiniMax,脚本只生成任务书,改派 Opus 审);` +
  `审完把判词(结论:SHIP)合进 ${branch} 或 main,再合并。`

export async function reviewGate(run: Run, dir: string, branch: string): Promise<Gate> {
  const nc = await run(['bash', '-c', 'cd "$1" && exec bash scripts/dev/needs-cross-review.sh HEAD "$2"', '_', dir, branch])
  if (!nc) return { kind: 'fault', text: 'needs-cross-review.sh 没跑起来' }
  if (nc.exitCode === 0) return { kind: 'pass' }
  if (nc.exitCode !== 2) return { kind: 'fault', text: `needs-cross-review.sh 退出码 ${nc.exitCode}` }
  const hits = nc.stdout.split('\n').filter(l => l.startsWith('  ')).map(l => l.trim().split(/\s+/)[0])
  const touched = `${hits.slice(0, 3).join(' · ')}${hits.length > 3 ? ` 等 ${hits.length} 个` : ''}`
  const git = (...a: string[]) => run(['git', '-C', dir, ...a])

  const newest = new Map<string, { ref: string; at: number }>()
  for (const ref of [branch, 'main']) {
    const ls = await git('ls-tree', '-r', '--name-only', ref, '--', 'docs/reviews', 'docs/plan')
    if (!ls || ls.exitCode !== 0) {
      if (ref === branch) return { kind: 'fault', text: `读不到 ${branch} 的文件表` }
      continue
    }
    const named = verdictPaths(branch, ls.stdout.split('\n'))
    const gr = await git('grep', '-l', '-E', '-e', branchMention(branch), ref, '--', 'docs/plan')
    const mentioned = gr && gr.exitCode === 0
      ? gr.stdout.split('\n').map(l => l.slice(ref.length + 1)).filter(p => LEGACY_RE.test(p))
      : []
    for (const p of new Set([...named, ...mentioned])) {
      const log = await git('log', '-1', '--format=%ct', ref, '--', p)
      const at = Number(log?.stdout.trim() || NaN)
      if (!Number.isFinite(at)) continue
      const prev = newest.get(p)
      if (!prev || at > prev.at) newest.set(p, { ref, at })
    }
  }
  const head = `agent-guard(G-R):合并 ${branch} 会碰敏感路径(${touched}),合并前要跨模型审判词「结论:SHIP」或 MERGE。`
  if (newest.size === 0) {
    return { kind: 'deny', text: `${head}没找到判词:查了 docs/reviews/${slugOf(branch)}.md 与 docs/plan/*/<片名>-review.md · -rereview.md(${branch} 与 main 上)。${launchHint(branch)}` }
  }
  const [path, { ref }] = [...newest].sort((a, b) => b[1].at - a[1].at || Number(b[0].startsWith('docs/reviews/')) - Number(a[0].startsWith('docs/reviews/')))[0] as [string, { ref: string; at: number }]
  const md = await git('show', `${ref}:${path}`)
  if (!md || md.exitCode !== 0) return { kind: 'fault', text: `读不到 ${ref}:${path}` }
  const v = verdictOf(md.stdout)
  if (v === 'SHIP' || v === 'MERGE') {
    const sha = reviewedShaOf(md.stdout)
    if (!sha) {
      return { kind: 'deny', text: `${head}判词 ${ref}:${path} 没写「被审 SHA:<sha>」,判不了审的是不是现在这一版。在报告第一节补上审查时分支 head 的 SHA(review-launch.sh 的任务书「审查对象」行有),或重起一轮审。` }
    }
    const anc = await git('merge-base', '--is-ancestor', sha, branch)
    if (!anc) return { kind: 'fault', text: `判不了 ${sha} 是不是 ${branch} 的祖先` }
    if (anc.exitCode !== 0) {
      return { kind: 'deny', text: `${head}判词 ${ref}:${path} 的被审 SHA ${sha} 不在 ${branch} 的历史里(分支被改写过,或 SHA 抄错)—— 重起一轮审。` }
    }
    const d = await git('diff', '--name-only', `${sha}..${branch}`)
    if (!d || d.exitCode !== 0) return { kind: 'fault', text: `读不到 ${sha}..${branch} 的改动` }
    const bad = postReviewBlockers(d.stdout.split('\n'))
    if (bad.length) {
      return { kind: 'deny', text: `${head}判词审的是 ${sha},之后 ${branch} 又改了非 docs / 测试的文件(${bad.slice(0, 3).join(' · ')}${bad.length > 3 ? ` 等 ${bad.length} 个` : ''})—— 旧判词不作数,重起一轮审(review-launch.sh ${branch})。` }
    }
    return { kind: 'pass' }
  }
  if (v === 'FIX-FIRST') {
    return { kind: 'deny', text: `${head}最新判词 ${ref}:${path} 是 FIX-FIRST —— 先修,再复审(review-launch.sh ${branch} 重起一轮),判词 SHIP 后再合并。` }
  }
  return { kind: 'deny', text: `${head}最新判词 ${ref}:${path} 里读不出唯一的结论行(要一行「结论:SHIP」或「结论:FIX-FIRST」)。${launchHint(branch)}` }
}

export const faultToast = (branch: string, why: string): string =>
  `agent-guard(G-R):判不了 ${branch} 要不要判词(${why}),已放行;请手动跑 scripts/dev/needs-cross-review.sh HEAD ${branch}`
