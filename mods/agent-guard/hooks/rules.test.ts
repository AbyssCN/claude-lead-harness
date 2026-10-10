import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_WORKTREE_COMMAND, howto, parseConfig, READ_ONLY, repoList, worktreeLine } from './rules'

describe('agent-guard rules', () => {
  test('reads the WORKTREE line only on a line of its own', () => {
    expect(worktreeLine('do it\nWORKTREE: /tmp/repos/app-x\nmore')).toBe('/tmp/repos/app-x')
    expect(worktreeLine('WORKTREE: none')).toBe('none')
    expect(worktreeLine('write the WORKTREE: line yourself')).toBe(null)
  })

  test('repo list and read-only types', () => {
    expect(repoList(' app, api ,,lib')).toEqual(['app', 'api', 'lib'])
    expect(repoList('')).toEqual([])
    expect(READ_ONLY.has('Explore')).toBe(true)
    expect(READ_ONLY.has('general-purpose')).toBe(false)
  })

  test('repo config', () => {
    expect(parseConfig(null)).toEqual({ requireWorktree: false, worktreeCommand: null })
    expect(parseConfig('not json')).toEqual({ requireWorktree: false, worktreeCommand: null })
    expect(parseConfig('{"requireWorktree": true, "worktreeCommand": "scripts/wt.sh <name>"}')).toEqual({
      requireWorktree: true,
      worktreeCommand: 'scripts/wt.sh <name>',
    })
    expect(howto().includes(DEFAULT_WORKTREE_COMMAND)).toBe(true)
    expect(howto('scripts/wt.sh <name>').includes('scripts/wt.sh <name>')).toBe(true)
  })
})
