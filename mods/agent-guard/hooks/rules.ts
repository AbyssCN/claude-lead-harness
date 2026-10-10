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

// A repo's own `.claude/agent-guard.json`.
export type RepoConfig = {
  // Non-read-only subagents dispatched in this repo must carry a WORKTREE line.
  requireWorktree: boolean
  // How to make a worktree in this repo, shown in the deny message; `<name>` is a placeholder.
  worktreeCommand: string | null
}

export function parseConfig(text: string | null): RepoConfig {
  const none: RepoConfig = { requireWorktree: false, worktreeCommand: null }
  if (text === null) return none
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    if (typeof j !== 'object' || j === null) return none
    return {
      requireWorktree: j.requireWorktree === true,
      worktreeCommand: typeof j.worktreeCommand === 'string' && j.worktreeCommand.trim() ? j.worktreeCommand.trim() : null,
    }
  } catch {
    return none
  }
}

export const DEFAULT_WORKTREE_COMMAND = 'git worktree add ../<repo>-<name> -b agent/<name>'

export const howto = (worktreeCommand: string | null = null): string =>
  `做法:先建独占 worktree(${worktreeCommand ?? DEFAULT_WORKTREE_COMMAND}),` +
  '把路径写进 prompt 单独一行「WORKTREE: <绝对路径>」,让子 agent 只在那里改、跑闸、提交;纯调研不写代码的写「WORKTREE: none」。'
