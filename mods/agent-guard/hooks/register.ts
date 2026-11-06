import type { EngineInterface, Register } from 'claude-code'

import { HOWTO, LEAD_MAIN_MOVES, READ_ONLY, devstackResetDeny, gitWrites, leadMoveDeny, mainRepoDeny, npmInstalls, npmSharedDeny, repoList, resolvePath, worktreeLine } from './rules'
import { ITX_TIMEOUT_MS, keepLocalHit, readsEnv, itxCommand, writesRedirect, localAck, localDeny, localException, mixedDeny, routeSteps } from './heavy-route'
import type { Run } from './review-gate'
import { faultToast, gitMerges, reviewGate } from './review-gate'
import { docsOnlyDrift, ffBranchesDeny, ffGateHead, ffHeadDeny, ffLogDeny, ffNotAncestorDeny, ffUnjudgedDeny, mergeMessage, mergeWordsIn, missingNoteLines, noteDeny, noteFaultToast, noteGateLog, noteShaDeny, reviewedSha, specGateRun, specVerdictDeny } from './merge-note'

/**
 * S11: omd-lite was renamed piw. The default names both; a list configured earlier (plugin manifest or settings.json)
 * that still says only `omd-lite` is widened with `piw`, so the renamed directory is guarded without a settings edit.
 */
export const DEFAULT_REQUIRED_REPOS = 'myapp,otherapp,oh-my-dag,omd-lite,piw'
export const withRenamedRepos = (repos: string[]): string[] =>
  repos.includes('omd-lite') && !repos.includes('piw') ? [...repos, 'piw'] : repos

/**
 * S9 (0.3.9): specGateRepos 默认带上 claude-mods / piw —— 19.10 漏掉的三片都是在 claude-mods 用
 * `git merge --no-ff` 手收的,而 reviewGateRepos(默认 myapp)一道机器判词都不查。
 */
const DEFAULT_SPEC_GATE_REPOS = 'myapp,claude-mods,piw'

// Worktrees already handed to an agent, across sessions: one directory, one dispatch.
const LEDGER_KEY = 'dispatched'

/**
 * S8 (0.3.8):快进要落的分支头已经走过闸判过的那个头(head_end)时,判这条快进还能不能走。返回拒绝文字,或 null(放行)。
 * head_end 不在这条分支的祖先链上 = 这份日志判的不是这条分支(rebase 过、拿错了日志),没有可比性 → 拒。
 * 是祖先 = 闸判完分支只往前走了(典型是闸那段时间 main 被 docs 推进):闸后带进来的只有 docs/*.md 就放行,
 * 其余重跑闸。闸自己的 git 命令起不来时放行,但要说一句(toast),不静默放过。
 */
async function ffDriftDeny(
  run: Run,
  fault: (why: string) => void,
  at: { dir: string; branch: string; head: string; logPath: string; headEnd: string },
): Promise<string | null> {
  const { dir, branch, head, logPath, headEnd } = at
  const git = (...a: string[]) => run(['git', '-C', dir, ...a])
  const anc = await git('merge-base', '--is-ancestor', headEnd, head)
  if (!anc || (anc.exitCode !== 0 && anc.exitCode !== 1)) {
    fault(`git merge-base 判不了 ${branch}`)
    return null
  }
  if (anc.exitCode === 1) return ffNotAncestorDeny(branch, logPath, headEnd)
  // 闸后进来的路径取并集:净差异给「两棵树差了什么」,区间里每个提交各自动过的文件补上「加过又删掉的」
  // 与「log --name-only 不给差异的 merge 提交」这两头——少一边都会把代码改动读成没有。
  const [net, each] = await Promise.all([
    git('diff', '--name-only', headEnd, head),
    git('log', '--format=', '--name-only', `${headEnd}..${head}`),
  ])
  if (!net || net.exitCode !== 0) {
    fault(`git diff 判不了 ${branch}`)
    return null
  }
  if (!each || each.exitCode !== 0) {
    fault(`git log 判不了 ${branch}`)
    return null
  }
  const drift = [...new Set([...net.stdout.split('\n'), ...each.stdout.split('\n')])]
  if (docsOnlyDrift(drift)) return null
  const bad = drift.filter(p => !docsOnlyDrift([p])).slice(0, 3)
  return `${ffHeadDeny(branch, head, logPath, headEnd)}(闸后进来的不全是 docs/*.md:${bad.join(' · ')})`
}

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 10_000 })
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

// The main checkout's directory name of the session's repo (a worktree reports its main repo).
async function repoName($: EngineInterface): Promise<string | null> {
  const common = await git($, await $.session.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) return null
  return common.replace(/\/\.git\/?$/, '').split('/').pop() ?? null
}

// Why the declared worktree is not usable, or null when it is.
async function checkWorktree($: EngineInterface, path: string): Promise<string | null> {
  if (!path.startsWith('/')) return `WORKTREE 要写绝对路径,现在是 ${path}`
  const st = await $.fs.stat(path, { resolve: true }).catch(() => null)
  if (!st) return `${path} 不存在`
  const gitDir = await git($, path, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const common = await git($, path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!gitDir || !common) return `${path} 不是 git 目录`
  if (gitDir === common) return `${path} 是主仓库,不是 worktree`
  const dirty = await git($, path, ['status', '--porcelain'])
  if (dirty === null) return `读不到 ${path} 的 git status`
  if (dirty !== '') return `${path} 有未提交改动,不是干净的新目录`
  const ledger = ((await $.store.get(LEDGER_KEY).catch(() => undefined)) as string[] | undefined) ?? []
  if (ledger.includes(st.realPath ?? path)) return `${path} 之前已经派给过一个 agent,一个目录只派一次`
  return null
}

// A main worktree: its git dir is the common dir. A non-repo or an unreadable one is not.
async function isMainWorktree($: EngineInterface, dir: string): Promise<boolean> {
  const gitDir = await git($, dir, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const common = await git($, dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return !!gitDir && gitDir === common
}

// A worktree whose node_modules entries are symlinks into another checkout (scripts/dev/agent-wt.sh):
// an install there writes through the links. The npm project root is the nearest dir with package.json up to the git top.
async function sharesNodeModules($: EngineInterface, dir: string): Promise<boolean> {
  const top = await git($, dir, ['rev-parse', '--show-toplevel'])
  if (!top) return false
  for (const root of [dir, top]) {
    try {
      const r = await $.process.run(['bash', '-c', 'for e in "$1"/node_modules/* "$1"/node_modules/.bin; do [ -L "$e" ] && exit 0; done; exit 1', '_', root], { timeoutMs: 5_000 })
      if (r.exitCode === 0) return true
    } catch { /* unreadable → keep checking */ }
  }
  return false
}

// S9 判不出被审提交:接不回这条 merge 的说明,或说明里没有「被审 SHA: <40 位>」那一行 ——
// 判不出判词要绑的是哪一版,放行等于没判(S8 对 myapp 另有它自己的三行判法)。
const specNoteDeny = (branch: string, why: string): string =>
  `agent-guard(S9):${why} —— 合 ${branch} 要先写三行说明:被审 SHA: <这次被审的 40 位 sha> / 判词: <spec-verdict.json 的路径 | 不需审> / 闸日志: <路径>。`

// S9 自己判不了(列不出 <runs> 下的判词目录)时的提示:放行,但要说一句,不静默放过。
const specFaultToast = (why: string): string => `agent-guard(S9):判不了合并说明(${why}),已放行`

// <runs> 根目录:OMDL_RUNS,没有则 $HOME/.omd-lite/runs(与 factory/dev/omdl-merge.sh · spec-check.mjs 同一处)。
const runsRoot = async ($: EngineInterface): Promise<string> =>
  (await $.env.get('OMDL_RUNS').catch(() => undefined)) ??
  `${(await $.env.get('HOME').catch(() => undefined)) ?? ''}/.omd-lite/runs`

/**
 * 一份判词对应的任务书**现在**内容的 sha256 —— spec-check.mjs 判的时候记下同一个值(判词里的 spec 字段记路径、
 * specSha 记内容);两个值对不上就是判完之后任务书被改过,那份判词说的不是这一版要求的事。
 * 判词读不出形状 / 没有 spec / 那个文件读不到 / sha256sum 跑不起来 → null(当不匹配:判不出任务书有没有改,
 * 不能因此放行)。一份判词一条自己的:同一个片名续跑出来的判词可能来自另一个仓的检出,spec 路径不一样,
 * 内容也就可能不一样。钩子模块只许 import 相对路径与 claude-code,所以 sha 走一条 `sha256sum`。
 */
const specShaNow = async (run: Run, text: string): Promise<string | null> => {
  const spec = (() => {
    try {
      const v = JSON.parse(text) as { spec?: unknown }
      return typeof v.spec === 'string' && v.spec !== '' ? v.spec : null
    } catch {
      return null
    }
  })()
  if (!spec) return null
  const sha = await run(['sha256sum', spec])
  if (!sha || sha.exitCode !== 0) return null
  const hex = sha.stdout.trim().split(/\s+/)[0] ?? ''
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null
}

/**
 * S9 (0.3.9):把 omdl/<片名> 那一版合进配置仓(specGateRepos)的主 worktree,要有一份绑到**同一个被审提交**的规格判词:
 * 判官问够 3 遍取并集、判完之后任务书没被改过、missing · extra · wrong 要么全空要么带理由接受过(0.3.10 起)。
 * 被审 SHA 取合并说明里那一行(与 S8 同一份说明);读不出就拒:判不出判词要绑哪一版,放行等于没判。
 * 判词在 <runs>/<片名>/ 与续跑的 <片名>-r<数字>/ 下(列目录用一条 bash glob;读得到哪几份看哪几份)。
 * 列不出 runs 目录 → 放行并 toast 一行,同 S8 的故障处置;读不动的判词文件跳过;读不出说明 → 拒(判不出要绑哪一版)。
 */
async function specGateDeny(
  $: EngineInterface,
  run: Run,
  branches: string[],
  words: string[] | null,
  dir: string,
  fault: (why: string) => void,
): Promise<string | null> {
  for (const b of branches) {
    const name = specGateRun(b)
    if (!name) continue // land/* · fix/* · lead 自己的分支:这一条不管
    let msg: string
    try {
      msg = (await mergeMessage(words ?? [], async p => String(await $.fs.read(p)), dir)) ?? ''
    } catch (err) {
      return specNoteDeny(b, `这条 merge 的说明读不出来(${err instanceof Error ? err.message : String(err)})`)
    }
    const sha = reviewedSha(msg)
    if (!sha) return specNoteDeny(b, '这条 merge 的说明接不回,或说明里没有「被审 SHA: <40 位>」那一行')
    // 一条 bash glob 列出这一片这一版的候选(脚本自带 exit 0:零个候选是「跑过了、没有」,不是「没跑起来」;
    // 退出非 0 = shell 自己没跑成 = 判不了,放行并 toast,不静默放过)。
    const ls = await run([
      'bash', '-c',
      'for f in "$1/$2/spec-verdict.json" "$1/$2"-r[0-9]*/spec-verdict.json; do [ -f "$f" ] && printf "%s\\n" "$f"; done; exit 0',
      '_', await runsRoot($), name,
    ])
    if (!ls || ls.exitCode !== 0) {
      fault(`列不出 ${name} 的 spec-verdict.json(${ls ? `退出 ${ls.exitCode}` : 'bash 起不来'})`)
      return null
    }
    const candidates: { path: string; text: string; specSha: string | null }[] = []
    for (const p of ls.stdout.split('\n').filter(l => l !== '')) {
      const text = await $.fs.read(p).then(String, () => null)
      if (text !== null) candidates.push({ path: p, text, specSha: await specShaNow(run, text) })
    }
    // 每份候选的任务书内容自己算过(续跑目录的 spec 路径可能不同);第 4 个参数传 null = 没有兜底,读不到就是读不到。
    const why = specVerdictDeny(b, sha, candidates, null)
    if (why) return why
  }
  return null
}

/**
 * 重命令送 build box(0.3.12,owner 31.10:dev box 一直轻,不靠各会话记得去 build box)。命中白名单的命令改写成经 remote-run
 * 在 build box 上跑;改不了的在 heavyRouteRepos 里拒(owner 2.11:靠提醒不管用),只有发版 · 合并打戳 · 执行体沙箱 · 主会话 ack
 * 照本机跑;别的仓只记不停(lead 2.11)。每次命中白名单都在 heavy-route.jsonl 记一行(验收的分母),写失败不挡命令。
 * 返回 { command } = 改写;{ deny } = 拒;null = 原样。
 */
async function routeHeavy(
  $: EngineInterface,
  e: { command?: unknown; agentId?: string },
  repos: string[],
): Promise<{ command: string } | { deny: string } | null> {
  const command = String(e.command ?? '')
  const steps = routeSteps(command)
  const kinds = [...new Set(steps.flatMap(s => s.kinds))]
  if (!kinds.length) return null
  const kind = kinds.join('+')
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const cwd = await $.session.cwd()
  // 第一条重命令在哪个目录跑:照 gitWrites 的走法,cd 到存在的目录才算移动。
  let dir = cwd
  for (const s of steps) {
    if (s.kinds.length) break
    if (s.cd === undefined) continue
    const abs = resolvePath(dir, s.cd, home)
    if ((await $.fs.stat(abs, { resolve: true }).catch(() => null))?.kind === 'dir') dir = abs
  }
  const [top, common] = (await git($, dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']))?.split('\n') ?? []
  const repo = common ? (common.replace(/\/\.git\/?$/, '').split('/').pop() ?? null) : null
  const log = async (route: 'buildbox' | 'local' | 'ack' | 'deny', reason: string) => {
    const row = JSON.stringify({
      ts: new Date().toISOString(), route, reason, repo, kind, cwd,
      session: await $.session.id().catch(() => undefined), agent: e.agentId,
    })
    try {
      await $.process.run(['bash', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s\\n" "$2" >> "$1"', '_', `${home}/.omd-lite/readings/heavy-route.jsonl`, row], { timeoutMs: 5_000 })
    } catch { /* 记账写不进不挡命令 */ }
  }
  if (steps.some(s => s.remote)) return (await log('buildbox', 'explicit'), null)
  // 执行体沙箱(sandbox-exec 都设 SANDBOX_ARM)里不改写:沙箱黑洞了 tailnet、git 替身拒 push,改写了也连不上 build box:remote-run 退 75 留队，显式 REMOTE_RUN_ALLOW_LOCAL=1 + 理由才回落;执行体本来排 gate-slot(lead myapp-34 31.10)
  if (await $.env.get('SANDBOX_ARM').catch(() => undefined)) return (await log('local', 'executor-sandbox'), null)
  // ACK 只认主会话(同 DEVSTACK_RESET_ACK);子 agent 带了照改写。
  const ack = localAck(command)
  if (ack && !e.agentId) return (await log('ack', ack), null)
  const exception = localException(command, cwd)
  if (exception) return (await log('local', exception), null)
  const rel = top && cwd.startsWith(`${top}/`) ? cwd.slice(top.length + 1) : ''
  const keep = keepLocalHit(command)
  const why = keep ? `keep-local:${keep}` : readsEnv(command) ? 'reads-env' : steps.find(s => s.local)?.local
  if (why) {
    if (!top || !repo || !repos.includes(repo)) return (await log('local', why), null)
    await log('deny', `deny-local:${why}`)
    return { deny: localDeny(why, kind, command, top, rel) }
  }
  if (!top || !repo) return (await log('local', 'no-repo'), null)
  // ponytail: build box 上只有 MyApp 的镜像与依赖缓存,别的仓(OtherApp 等)的重命令先放本机记账;build box 配好 OtherApp 后把它加进 heavyRouteRepos 默认值,改为改写。
  if (!repos.includes(repo)) return (await log('local', `${repo}-not-on-buildbox`), null)
  const foreign = [
    ...(/\$\(|`/.test(command) ? ['$(…)'] : []),
    ...(writesRedirect(command) ? ['>'] : []),
    ...steps.flatMap(s => s.foreign),
  ]
  if (foreign.length) return (await log('deny', `mixed:${foreign[0]}`), { deny: mixedDeny(kind, foreign) })
  await log('buildbox', ack ? 'rewrite-subagent-ack-ignored' : 'rewrite')
  return { command: itxCommand(command, top, rel) }
}

export const register: Register = (on, options) => {
  const required = withRenamedRepos(repoList(String(options.requireWorktreeRepos ?? DEFAULT_REQUIRED_REPOS)))
  const reviewed = repoList(String(options.reviewGateRepos ?? 'myapp'))
  const specGate = repoList(String(options.specGateRepos ?? DEFAULT_SPEC_GATE_REPOS))
  const devstackGuard = repoList(String(options.devstackGuardRepos ?? 'myapp'))
  const heavyRepos = repoList(String(options.heavyRouteRepos ?? 'myapp'))

  // G-R: anyone (lead or subagent) merging a branch into a configured repo's main checkout needs a review verdict
  // when the branch touches the repo's sensitive paths. A fault in the gate lets the merge through with a toast.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    // 31.10:MyApp 的共享开发栈多会话共用,子 agent 照写错的任务书 reset 了两次;只写在 AGENTS.md 里拦不住。
    const resetDeny = devstackResetDeny(command, !!e.agentId)
    if (resetDeny) {
      const repo = await repoName($)
      if (repo && devstackGuard.includes(repo)) return { deny: resetDeny }
    }
    const merges = await gitMerges(
      command,
      await $.session.cwd(),
      (await $.env.get('HOME').catch(() => undefined)) ?? '',
      async p => (await $.fs.stat(p, { resolve: true }).catch(() => null))?.kind === 'dir',
    )
    const notes = mergeWordsIn(command, merges) // S8: 每个 merge 自己的说明参数,与 merges 同序
    for (const [i, m] of merges.entries()) {
      if (!(await isMainWorktree($, m.dir))) continue
      const top = await git($, m.dir, ['rev-parse', '--show-toplevel'])
      const repo = top?.split('/').pop() ?? ''
      const words = notes[i] // S8 与 S9 共用:接不回这条 merge 的 -m / -F 时,各自说各自的
      const run = async (argv: string[]) => {
        try {
          const r = await $.process.run(argv, { timeoutMs: 60_000 })
          return { exitCode: r.exitCode, stdout: r.stdout }
        } catch {
          return null
        }
      }
      // S9:放在 reviewGateRepos 那个 continue 之前 —— claude-mods / piw 不在审查仓名单里,放到后面就走不到这一条。
      // --ff-only 不生成提交、说明不落盘,判词绑不上那一版(快进归 S8 的 head_end 判法管,见下面)。
      if (top && specGate.includes(repo) && !words?.includes('--ff-only')) {
        const why = await specGateDeny($, run, m.branches, words, m.dir, w => $.ui.toast(specFaultToast(w)))
        if (why) return { deny: why }
      }
      if (!top || !reviewed.includes(repo)) continue
      for (const b of m.branches) {
        const g = await reviewGate(run, m.dir, b)
        if (g.kind === 'deny') return { deny: g.text }
        if (g.kind === 'fault') $.ui.toast(faultToast(b, g.text))
      }
      // S8 (same reach as G-R): the merge message itself carries the record — 被审 SHA / 判词 / 闸日志 —
      // so what was reviewed and which gate log holds it travel with the merge commit. A fault here
      // lets the merge through with a toast, as G-R's does. A --ff-only merge creates no commit, so its
      // message lands nowhere: there the record to check is the branch head the gate judged (head_end).
      if (!words) {
        $.ui.toast(noteFaultToast(`接不回这条 merge 的 -m / -F(${m.branches.join(' ')})`))
        continue
      }
      let msg: string
      try {
        // A merge that is not one at all (--abort) reads as no message here and is denied, never passed over.
        msg = (await mergeMessage(words, async p => String(await $.fs.read(p)), m.dir)) ?? ''
      } catch (err) {
        $.ui.toast(noteFaultToast(err instanceof Error ? err.message : String(err)))
        continue
      }
      if (words.includes('--ff-only')) {
        if (m.branches.length > 1) return { deny: ffBranchesDeny(m.branches) }
        const branch = m.branches[0] as string
        const logPath = noteGateLog(msg)
        if (!logPath) return { deny: ffLogDeny(repo) }
        let log: string
        try {
          log = String(await $.fs.read(logPath))
        } catch {
          // The gate log is someone else's file: unreadable here says nothing about whether it is green.
          $.ui.toast(noteFaultToast(`读不到闸日志 ${logPath}`))
          continue
        }
        // The gate wrapper writes exit=<code>, then the head it judged as head_end=<sha> branch=<name>.
        const headEnd = ffGateHead(log)
        if (!/^exit=0$/m.test(log) || !headEnd) return { deny: ffUnjudgedDeny(logPath) }
        const rp = await run(['git', '-C', m.dir, 'rev-parse', '--verify', `${branch}^{commit}`])
        if (!rp) $.ui.toast(noteFaultToast(`git rev-parse 起不来(${branch})`))
        else if (rp.exitCode !== 0) $.ui.toast(noteFaultToast(`git rev-parse 判不出 ${branch} 的头(退出 ${rp.exitCode})`))
        else if (rp.stdout.trim() !== headEnd) {
          const why = await ffDriftDeny(run, w => $.ui.toast(noteFaultToast(w)), {
            dir: m.dir, branch, head: rp.stdout.trim(), logPath, headEnd,
          })
          if (why) return { deny: why }
        }
        continue
      }
      const missing = missingNoteLines(msg)
      if (missing.length) return { deny: noteDeny(repo, missing) }
      const sha = reviewedSha(msg) as string
      const obj = await run(['git', '-C', m.dir, 'cat-file', '-e', `${sha}^{commit}`])
      if (!obj) $.ui.toast(noteFaultToast(`git cat-file 起不来(${sha})`))
      else if (obj.exitCode !== 0) return { deny: noteShaDeny(repo, sha) }
    }
    // 重命令送 build box 放在 reset 拦截与合并闸之后:它们拒的先拒。改写只在这一处(多个钩子改写同一调用的合并规则没有文档)。
    let routed: { command: string } | { deny: string } | null = null
    try {
      routed = await routeHeavy($, e, heavyRepos)
    } catch (err) {
      $.ui.toast(`agent-guard:重命令送 build box 判不了(${err instanceof Error ? err.message : String(err)}),这条照原样在本机跑`)
    }
    if (routed && 'deny' in routed) return { deny: routed.deny }
    if (!routed) return next(e)
    const timeout = typeof e.timeout === 'number' && e.timeout > ITX_TIMEOUT_MS ? e.timeout : ITX_TIMEOUT_MS
    return next({ ...e, command: routed.command, timeout })
  }).catch(($, e, next) => next(e))

  // A subagent (its events carry agentId; the lead's do not) must not write git in a main checkout.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!e.agentId) return next(e)
    const writes = await gitWrites(
      String(e.command ?? ''),
      await $.session.cwd(),
      (await $.env.get('HOME').catch(() => undefined)) ?? '',
      async p => (await $.fs.stat(p, { resolve: true }).catch(() => null))?.kind === 'dir',
    )
    for (const w of writes) {
      if (await isMainWorktree($, w.dir)) return { deny: mainRepoDeny(w.verb, w.dir) }
    }
    const installs = await npmInstalls(
      String(e.command ?? ''),
      await $.session.cwd(),
      (await $.env.get('HOME').catch(() => undefined)) ?? '',
      async p => (await $.fs.stat(p, { resolve: true }).catch(() => null))?.kind === 'dir',
    )
    for (const n of installs) {
      if (await sharesNodeModules($, n.dir)) return { deny: npmSharedDeny(n.verb, n.dir) }
    }
    return next(e)
    // A fault in the guard itself must not stop every command.
  }).catch(($, e, next) => next(e))

  // The lead too: in a configured repo's main checkout, HEAD and branch refs move only by merge or commit.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const writes = await gitWrites(
      String(e.command ?? ''),
      await $.session.cwd(),
      (await $.env.get('HOME').catch(() => undefined)) ?? '',
      async p => (await $.fs.stat(p, { resolve: true }).catch(() => null))?.kind === 'dir',
    )
    for (const w of writes) {
      if (!LEAD_MAIN_MOVES.has(w.verb) || w.override) continue
      if (!(await isMainWorktree($, w.dir))) continue
      const common = await git($, w.dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      const repo = common?.replace(/\/\.git\/?$/, '').split('/').pop() ?? ''
      if (required.includes(repo)) return { deny: leadMoveDeny(w.verb, w.dir) }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.isolation === 'worktree') {
      return { deny: `agent-guard:isolation: "worktree" 在本环境会让多个 agent 共用同一个目录(04.10 事故)。${HOWTO}` }
    }
    const type = e.subagent_type ?? 'general-purpose'
    if (READ_ONLY.has(type)) return next(e)

    const declared = worktreeLine(e.prompt)
    if (declared === 'none') return next(e)
    if (declared === null) {
      const repo = await repoName($)
      if (repo && required.includes(repo)) {
        return { deny: `agent-guard:${repo} 里派 ${type} 子 agent 要在 prompt 里写一行「WORKTREE: <绝对路径>」。${HOWTO}` }
      }
      return next(e)
    }

    const why = await checkWorktree($, declared)
    if (why) return { deny: `agent-guard:${why}。${HOWTO}` }
    const st = await $.fs.stat(declared, { resolve: true })
    const ledger = ((await $.store.get(LEDGER_KEY).catch(() => undefined)) as string[] | undefined) ?? []
    await $.store.set(LEDGER_KEY, [...ledger, st.realPath ?? declared].slice(-2000))
    return next(e)
    // A fault in the guard itself must not stop every dispatch.
  }).catch(($, e, next) => next(e))
}
