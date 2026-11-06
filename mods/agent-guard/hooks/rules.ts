// Pure rules, kept apart so the tests can call them directly.

// Agent types that never write.
export const READ_ONLY = new Set(['Explore', 'Plan', 'claude-code-guide', 'statusline-setup'])

// `WORKTREE: /abs/path` or `WORKTREE: none` on a line of its own.
export function worktreeLine(prompt: string): string | null {
  const m = /^WORKTREE:\s*(\S+)\s*$/m.exec(prompt)
  return m ? (m[1] ?? null) : null
}

export const repoList = (csv: string): string[] =>
  csv.split(',').map(s => s.trim()).filter(Boolean)

export const HOWTO =
  '做法:先建独占 worktree(MyApp:scripts/dev/agent-wt.sh <name>;其他仓:git worktree add ../<仓>-<name> -b agent/<name>),' +
  '把路径写进 prompt 单独一行「WORKTREE: <绝对路径>」,让子 agent 只在那里改、跑闸、提交;纯调研不写代码的写「WORKTREE: none」。'

// ---- 子 agent 在主 worktree 里的 git 写 ----

const GIT_WRITE = new Set(['commit', 'merge', 'reset', 'update-ref', 'rebase', 'cherry-pick', 'push', 'switch', 'revert', 'pull', 'am', 'clean', 'restore'])
// Global options that take a value as the next token.
export const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

// Subcommands that write only in some forms: `args` are the words after the subcommand.
export function isGitWrite(sub: string, args: string[]): boolean {
  if (GIT_WRITE.has(sub)) return true
  if (sub === 'checkout') return true
  if (sub === 'stash') return !['list', 'show'].includes(args[0] ?? '')
  if (sub === 'branch') return args.some(a => ['-D', '-d', '--delete', '-f', '--force', '-m', '-M'].includes(a))
  if (sub === 'tag') {
    if (args.some(a => ['-l', '--list', '-v', '--verify', '-n'].includes(a))) return false
    return args.some(a => !a.startsWith('-') || ['-d', '--delete'].includes(a))
  }
  return false
}

// Splits a shell line into commands of words; quotes keep `&&` / `;` / `git commit` inside a string inert.
export function shellCommands(line: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let cur = ''
  let has = false
  let q: string | null = null
  const word = () => { if (has) words.push(cur); cur = ''; has = false }
  const cmd = () => { word(); if (words.length) out.push(words); words = [] }
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    if (q) {
      if (c === q) q = null
      else if (c === '\\' && q === '"' && i + 1 < line.length) cur += line[++i]
      else cur += c
    } else if (c === "'" || c === '"') { q = c; has = true }
    else if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true }
    else if (c === ' ' || c === '\t') word()
    else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') cmd()
    else { cur += c; has = true }
  }
  cmd()
  return out
}

export const resolvePath = (base: string, p: string, home: string): string => {
  const abs = p === '~' || p.startsWith('~/') ? home + p.slice(1) : p.startsWith('/') ? p : `${base}/${p}`
  const parts: string[] = []
  for (const s of abs.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') parts.pop()
    else parts.push(s)
  }
  return '/' + parts.join('/')
}

// Each git write in the line with the directory it runs in. A `cd` into a directory that does not
// exist fails and leaves the shell where it was, which is how a cleaned-up worktree lands a commit
// in the main checkout; so the walk only moves on a `cd` whose target exists.
export async function gitWrites(
  line: string,
  startCwd: string,
  home: string,
  isDir: (abs: string) => Promise<boolean>,
): Promise<{ dir: string; verb: string; override?: true }[]> {
  const found: { dir: string; verb: string; override?: true }[] = []
  let cwd = startCwd
  for (const all of shellCommands(line)) {
    // `FOO=1 git commit` is still a git commit: skip leading assignments, remember the lead's explicit override.
    let k = 0
    while (k < all.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(all[k] as string)) k++
    const override = all.slice(0, k).includes(`${MAIN_CHECKOUT_OVERRIDE}=1`)
    const w = all.slice(k)
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
      if (t === '-C') { dir = resolvePath(dir, w[++i] ?? '.', home) }
      else if (GIT_VALUE_OPTS.has(t)) i++
      else if (t.startsWith('-')) continue
      else break
    }
    const sub = w[i]
    if (sub === undefined) continue
    const args = w.slice(i + 1)
    if (!isGitWrite(sub, args)) continue
    const verb = sub === 'branch' && args.some(a => ['-f', '--force', '-m', '-M'].includes(a)) ? 'branch -f' : sub
    found.push(override ? { dir, verb, override } : { dir, verb })
  }
  return found
}

const NPM_INSTALL = new Set(['install', 'i', 'in', 'ins', 'add', 'ci', 'clean-install', 'uninstall', 'un', 'rm', 'remove', 'update', 'up', 'upgrade', 'dedupe', 'ddp', 'prune', 'link', 'ln'])

// Each npm command in the line that writes node_modules / the lockfile, with the directory it runs in
// (`cd` walk as in gitWrites; `--prefix <dir>` moves it).
export async function npmInstalls(
  line: string,
  startCwd: string,
  home: string,
  isDir: (abs: string) => Promise<boolean>,
): Promise<{ dir: string; verb: string }[]> {
  const found: { dir: string; verb: string }[] = []
  let cwd = startCwd
  for (const w of shellCommands(line)) {
    if (w[0] === 'cd') {
      const target = w[1] === undefined || w[1] === '--' ? home : (w[1] as string)
      const abs = resolvePath(cwd, target, home)
      if (await isDir(abs)) cwd = abs
      continue
    }
    if (w[0] !== 'npm') continue
    let dir = cwd
    let sub: string | undefined
    for (let i = 1; i < w.length; i++) {
      const t = w[i] as string
      if (t === '--prefix' || t === '-C') { dir = resolvePath(dir, w[++i] ?? '.', home); continue }
      if (t.startsWith('--prefix=')) { dir = resolvePath(dir, t.slice(9), home); continue }
      if (t.startsWith('-')) continue
      if (sub === undefined) sub = t
    }
    if (sub !== undefined && NPM_INSTALL.has(sub)) found.push({ dir, verb: sub })
  }
  return found
}

export const npmSharedDeny = (verb: string, dir: string): string =>
  `agent-guard:子 agent 不许在 ${dir} 跑 npm ${verb} —— 这个 worktree 的 node_modules 是软链到主仓的(agent-wt.sh),` +
  '装包会改坏主仓与所有并行片的依赖(14.10 两次事故:约 340 个包被改名,主仓 dev server 500)。' +
  '要新依赖:放进自带 package.json 的独立目录(如 tools/<名>/),在 /tmp 装好再拷;或停下报告由主会话装。'

// The main checkout's HEAD and branch refs move only through `git merge` (G-R and the S8 merge note gate it) or a commit.
// 18.10: a workflow subagent's `git checkout <sha>` detached the main checkout, and the lead's `git branch -f main` skipped every gate.
export const MAIN_CHECKOUT_OVERRIDE = 'MYAPP_MAIN_CHECKOUT'
export const LEAD_MAIN_MOVES = new Set(['checkout', 'switch', 'reset', 'update-ref', 'branch -f'])

export const leadMoveDeny = (verb: string, dir: string): string =>
  `agent-guard:主仓库 ${dir} 里不许 git ${verb}(lead 也一样):主仓 HEAD 与分支只经 git merge 或提交移动,merge 有 G-R 与合并说明两道闸。` +
  '快进 main 用 `git merge --ff-only <分支> -m "…"`(说明里带被审 SHA / 判词 / 闸日志);切分支、恢复文件去 worktree 里做。' +
  `确实要在主仓做(如事故恢复),命令前缀写 ${MAIN_CHECKOUT_OVERRIDE}=1,会留在会话记录里。`

export const mainRepoDeny = (verb: string, dir: string): string =>
  `agent-guard:子 agent 不许在主仓库 ${dir} 里执行 git ${verb}(worktree 被清掉后 cd 失败,提交会落到主仓 main,11.10 事故)。` +
  '先 `cd` 到你的 WORKTREE 行里的目录再操作;如果那个目录不存在了,停下来报告,不要在主仓补救。'

// ---- 共享开发栈不许 supabase db reset ----

export const DEVSTACK_RESET_ACK = 'DEVSTACK_RESET_ACK'
export const SHARED_DEVSTACK_PORT = '54322'
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
// 跟着取值的 supabase 全局选项:取值那个词不能当子命令读。
const SUPABASE_VALUE_OPTS = new Set(['--workdir', '--profile', '--network-id', '-o', '--output', '--dns-resolver'])

const baseName = (w: string): string => w.split('/').pop() ?? ''
const isSupabase = (w: string): boolean => /^supabase(@\S*)?$/.test(baseName(w))

// supabase 那个词之后的参数;这一条不是 supabase 命令就是 null。
function supabaseArgs(w: string[]): string[] | null {
  if (w[0] === undefined) return null
  if (isSupabase(w[0])) return w.slice(1)
  if ((w[0] === 'yarn' || w[0] === 'pnpm') && isSupabase(w[1] ?? '')) return w.slice(2)
  const exec = w[0] === 'npx' || w[0] === 'bunx' ? 1
    : (w[0] === 'npm' || w[0] === 'pnpm' || w[0] === 'yarn') && ['exec', 'x', 'dlx'].includes(w[1] ?? '') ? 2
    : 0
  if (!exec) return null
  for (let i = exec; i < w.length; i++) {
    const t = w[i] as string
    if (t === '-p' || t === '--package') { i++; continue }
    if (t.startsWith('-')) continue
    return isSupabase(t) ? w.slice(i + 1) : null
  }
  return null
}

// 一条命令行里每一个 supabase db reset:带的 --db-url(没带是 null)与前缀上的 ACK 理由(没有或为空是 null)。
// `bash -c '…'` 的那一串在 shellCommands 里是一个词,要拆开再认;外层的环境变量前缀传给里面的命令。
export function supabaseResets(line: string, inheritedAck: string | null = null): { dbUrl: string | null; ack: string | null }[] {
  const found: { dbUrl: string | null; ack: string | null }[] = []
  for (const all of shellCommands(line)) {
    let k = 0
    let ack = inheritedAck
    for (;;) {
      const t = all[k]
      if (t === 'env') { k++; continue }
      if (t === undefined || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) break
      if (t.startsWith(`${DEVSTACK_RESET_ACK}=`)) ack = t.slice(DEVSTACK_RESET_ACK.length + 1) || null
      k++
    }
    const w = all.slice(k)
    if (SHELLS.has(baseName(w[0] ?? ''))) {
      const c = w.findIndex((t, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(t))
      if (c > 0 && w[c + 1] !== undefined) found.push(...supabaseResets(w[c + 1] as string, ack))
      continue
    }
    const args = supabaseArgs(w)
    if (!args) continue
    const pos: string[] = []
    let dbUrl: string | null = null
    for (let i = 0; i < args.length; i++) {
      const t = args[i] as string
      if (t === '--db-url') { dbUrl = args[++i] ?? ''; continue }
      if (t.startsWith('--db-url=')) { dbUrl = t.slice(9); continue }
      if (SUPABASE_VALUE_OPTS.has(t)) { i++; continue }
      if (!t.startsWith('-')) pos.push(t)
    }
    if (pos[0] === 'db' && pos[1] === 'reset') found.push({ dbUrl, ack })
  }
  return found
}

// --db-url 能认出指向的不是共享栈:读得出端口且不是 54322;没写端口是 Postgres 默认的 5432。
// 读不出来的(如 "$DB_URL",钩子里看不到展开后的值)当共享栈。
export function isolatedDbUrl(url: string): boolean {
  const m = /^postgres(?:ql)?:\/\/([^/?#]*)/.exec(url)
  if (!m) return false
  const host = (m[1] as string).split('@').pop() as string
  if (host === '' || host.includes('$')) return false
  const port = /:(\d+)$/.exec(host)?.[1] ?? (/^\[[^\]]*\]$|^[^:]+$/.test(host) ? '5432' : null)
  return port !== null && port !== SHARED_DEVSTACK_PORT
}

// 拒绝文字;这一行里每个 reset 都放得过就是 null。只有主会话(isSubagent 为 false)的 ACK 前缀算数。
export function devstackResetDeny(line: string, isSubagent: boolean): string | null {
  const bad = supabaseResets(line).find(r => !(r.dbUrl !== null && isolatedDbUrl(r.dbUrl)) && !(r.ack && !isSubagent))
  if (!bad) return null
  return 'agent-guard:不许对共享开发栈跑 supabase db reset —— 本机 npx supabase start 起的那套(Postgres 在 127.0.0.1:54322)' +
    '由多个会话共用,reset 会清掉别的会话正在用的数据(31.10 一个子 agent 照写错的任务书 reset 了两次)。共享栈只许 migration up。' +
    '要重放迁移、跑 SQL 探针:bash supabase/ci/replay-local.sh(一次性 postgres 容器,跑完即删);' +
    '要一整套 Supabase:python3 scripts/dev/run_isolated_stack.py --logs <仓外、非软链的绝对目录> -- <验证命令>' +
    '(私有端口,验证命令拿到的 DATABASE_URL / PG* 指向它);对已起好的隔离栈 reset 写 --db-url <它的地址>(端口不是 54322)。' +
    `真要重置共享栈只有主会话能做:命令前缀写 ${DEVSTACK_RESET_ACK}='<理由>',会留在会话记录里;子 agent 带了也不放行,停下报告。`
}
