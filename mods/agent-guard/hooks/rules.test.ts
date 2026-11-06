import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_REQUIRED_REPOS, withRenamedRepos } from './register'
import { READ_ONLY, devstackResetDeny, isolatedDbUrl, npmInstalls, repoList, supabaseResets, worktreeLine } from './rules'

describe('agent-guard rules', () => {
  test('reads the WORKTREE line only on a line of its own', () => {
    expect(worktreeLine('do it\nWORKTREE: /home/user/repos/myapp-x\nmore')).toBe('/home/user/repos/myapp-x')
    expect(worktreeLine('WORKTREE: none')).toBe('none')
    expect(worktreeLine('write the WORKTREE: line yourself')).toBe(null)
  })

  test('repo list and read-only types', () => {
    expect(repoList(' myapp, otherapp ,,oh-my-dag')).toEqual(['myapp', 'otherapp', 'oh-my-dag'])
    expect(READ_ONLY.has('Explore')).toBe(true)
    expect(READ_ONLY.has('general-purpose')).toBe(false)
  })

  test('S11: omd-lite 改名 piw —— 默认值两个名字都有;只写 omd-lite 的旧配置自动补上 piw,别的不动', () => {
    expect(repoList(DEFAULT_REQUIRED_REPOS)).toEqual(['myapp', 'otherapp', 'oh-my-dag', 'omd-lite', 'piw'])
    expect(withRenamedRepos(['myapp', 'omd-lite'])).toEqual(['myapp', 'omd-lite', 'piw'])
    expect(withRenamedRepos(['omd-lite', 'piw'])).toEqual(['omd-lite', 'piw'])
    expect(withRenamedRepos(['myapp', 'otherapp'])).toEqual(['myapp', 'otherapp'])
    expect(withRenamedRepos(repoList(DEFAULT_REQUIRED_REPOS))).toEqual(repoList(DEFAULT_REQUIRED_REPOS))
  })

  test('14.10:npm 装包类命令连同所在目录被认出;npm run / test / exec 不算', async () => {
    const isDir = async (p: string) => p === '/w' || p === '/w/tools/x'
    expect(await npmInstalls('npm i -D @jazzer.js/core', '/w', '/h', isDir)).toEqual([{ dir: '/w', verb: 'i' }])
    expect(await npmInstalls('cd tools/x && npm ci', '/w', '/h', isDir)).toEqual([{ dir: '/w/tools/x', verb: 'ci' }])
    expect(await npmInstalls('npm --prefix tools/x install', '/w', '/h', isDir)).toEqual([{ dir: '/w/tools/x', verb: 'install' }])
    expect(await npmInstalls('npm install --package-lock-only', '/w', '/h', isDir)).toEqual([{ dir: '/w', verb: 'install' }])
    expect(await npmInstalls('npm run verify:mobile && npm test && npx vitest run', '/w', '/h', isDir)).toEqual([])
    expect(await npmInstalls('echo "npm install"', '/w', '/h', isDir)).toEqual([])
  })

  test('31.10:认出每种起法的 supabase db reset,连同 --db-url 与 ACK 前缀;字符串里出现的不算', () => {
    expect(supabaseResets('npx supabase db reset')).toEqual([{ dbUrl: null, ack: null }])
    expect(supabaseResets('./node_modules/.bin/supabase --workdir db db reset')).toEqual([{ dbUrl: null, ack: null }])
    expect(supabaseResets('npm exec --offline --yes --package=supabase@2.119.0 -- supabase db reset --db-url x')).toEqual([{ dbUrl: 'x', ack: null }])
    expect(supabaseResets("DEVSTACK_RESET_ACK='理由' sh -lc 'npx -y supabase db reset --db-url=u'")).toEqual([{ dbUrl: 'u', ack: '理由' }])
    expect(supabaseResets("env DEVSTACK_RESET_ACK= yarn supabase db reset")).toEqual([{ dbUrl: null, ack: null }])
    for (const c of ['echo "supabase db reset"', "rg 'db reset'", 'npx supabase migration up', 'npx supabase db push', 'npx supabase db diff -f reset']) {
      expect(supabaseResets(c)).toEqual([])
    }
  })

  test('31.10:--db-url 只有读得出端口且不是 54322 才算隔离栈', () => {
    expect(isolatedDbUrl('postgresql://postgres:postgres@127.0.0.1:55432/postgres')).toBe(true)
    expect(isolatedDbUrl('postgres://u@localhost/db')).toBe(true)
    expect(isolatedDbUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toBe(false)
    expect(isolatedDbUrl('postgresql://postgres@[::1]:54322/postgres')).toBe(false)
    expect(isolatedDbUrl('$DB_URL')).toBe(false)
    expect(isolatedDbUrl('postgresql://postgres@$HOST/postgres')).toBe(false)
    expect(isolatedDbUrl('')).toBe(false)
  })

  test('31.10:ACK 只放行主会话;一行里有一个放不过就拒', () => {
    expect(devstackResetDeny("DEVSTACK_RESET_ACK='x' npx supabase db reset", false)).toBe(null)
    expect(devstackResetDeny("DEVSTACK_RESET_ACK='x' npx supabase db reset", true)).toContain('子 agent 带了也不放行')
    expect(devstackResetDeny('npx supabase db reset --db-url postgresql://p@127.0.0.1:55432/p && npx supabase db reset', false)).toContain('共享开发栈')
    expect(devstackResetDeny('npx supabase migration up', true)).toBe(null)
  })
})
