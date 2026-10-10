import type { EngineInterface, Register } from 'claude-code'

import { howto, parseConfig, READ_ONLY, repoList, worktreeLine } from './rules'
import type { RepoConfig } from './rules'

// Worktrees already handed to an agent, across sessions: one directory, one dispatch.
const LEDGER_KEY = 'dispatched'

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 10_000 })
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

// The main checkout of the session's repo (a worktree reports its main repo): its path and directory name.
async function mainRepo($: EngineInterface): Promise<{ root: string; name: string } | null> {
  const common = await git($, await $.session.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) return null
  const root = common.replace(/\/\.git\/?$/, '')
  const name = root.split('/').pop()
  return name ? { root, name } : null
}

// The repo's own `.claude/agent-guard.json`, read from its main checkout.
async function repoConfig($: EngineInterface, root: string): Promise<RepoConfig> {
  const text = await $.fs.read(`${root}/.claude/agent-guard.json`).then(t => t as string, () => null)
  return parseConfig(text)
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

export const register: Register = (on, options) => {
  const required = repoList(String(options.requireWorktreeRepos ?? ''))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const repo = await mainRepo($)
    const config = repo ? await repoConfig($, repo.root) : parseConfig(null)
    const HOWTO = howto(config.worktreeCommand)

    if (e.isolation === 'worktree') {
      return { deny: `agent-guard:isolation: "worktree" 会让多个 agent 共用同一个目录,不用它。${HOWTO}` }
    }
    const type = e.subagent_type ?? 'general-purpose'
    if (READ_ONLY.has(type)) return next(e)

    const declared = worktreeLine(e.prompt)
    if (declared === 'none') return next(e)
    if (declared === null) {
      if (repo && (config.requireWorktree || required.includes(repo.name))) {
        return { deny: `agent-guard:${repo.name} 里派 ${type} 子 agent 要在 prompt 里写一行「WORKTREE: <绝对路径>」。${HOWTO}` }
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
