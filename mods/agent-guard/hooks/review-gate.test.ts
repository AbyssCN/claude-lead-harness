// claude plugin test /home/user/repos/claude-mods/agent-guard
import { describe, expect, test } from 'claude-code/testing'
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { branchMention, gitMerges, postReviewBlockers, reviewedShaOf, verdictOf, verdictPaths } from './review-gate'

const MAIN = '/r/myapp'
const WT = '/r/myapp-wt'
const OTHER = '/r/otherapp'
const dirs = new Set([MAIN, WT, OTHER, '/r'])

type Files = Record<string, Record<string, { at: number; md: string }>> // ref → path → file
// after: 分支 → 被审 SHA 之后改过的文件(缺省 = 没改);notAncestor: 被审 SHA 不在其历史里的分支。
type World = { toasts: string[]; touch: Record<string, number>; files: Files; after: Record<string, string[]>; notAncestor: Set<string> }

// A fake MyApp: MAIN / OTHER are main worktrees, WT a linked one. `touch` is needs-cross-review's exit code per branch.
function world(on: On, cwd: string, w: Partial<World> = {}): World {
  const s: World = { toasts: [], touch: {}, files: {}, after: {}, notAncestor: new Set(), ...w }
  mock.env(on, { HOME: '/home/t' })
  on('session.cwd', () => ({ value: cwd }))
  on('fs.stat', (_, e) => {
    if (!dirs.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } as never
  })
  on('ui.toast', (_, e) => (s.toasts.push(String(e.text)), { value: { isShown: true } }) as never)
  on('process.run', (_, e) => {
    const a = [...e.argv] as string[]
    const done = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'bash') {
      const code = s.touch[a[5] as string]
      if (code === undefined) return done(127)
      return done(code, code === 2 ? 'needs-cross-review: 需要…\n  apps/web/src/lib/x/actions.ts  ← apps/web/src/*/actions.ts\n' : 'ok')
    }
    const dir = a[2] as string
    const rest = a.slice(3)
    if (rest[0] === 'rev-parse') {
      const q = rest[rest.length - 1]
      if (q === '--show-toplevel') return dir === WT ? done(0, WT) : dirs.has(dir) ? done(0, dir) : done(128)
      if (dir === MAIN || dir === OTHER) return done(0, `${dir}/.git`)
      if (dir === WT) return done(0, q === '--git-dir' ? `${MAIN}/.git/worktrees/wt` : `${MAIN}/.git`)
      return done(128)
    }
    if (rest[0] === 'cat-file') return done(0) // WITH_NOTE 的被审 SHA 代表一个真有的提交(S8 查对象存在)
    if (rest[0] === 'merge-base') return done(s.notAncestor.has(rest[3] as string) ? 1 : 0)
    if (rest[0] === 'diff') return done(0, (s.after[(rest[2] as string).split('..')[1] as string] ?? []).join('\n'))
    const ref = rest[0] === 'show' ? (rest[1] as string).split(':')[0] as string : rest[rest[0] === 'grep' ? 5 : rest[0] === 'log' ? 3 : 3] as string
    const fs = s.files[ref]
    if (rest[0] === 'ls-tree') return fs ? done(0, Object.keys(fs).join('\n')) : done(128)
    if (rest[0] === 'grep') {
      const re = new RegExp(rest[4] as string)
      const hit = Object.entries(fs ?? {}).filter(([p, f]) => p.startsWith('docs/plan/') && f.md.split('\n').some(l => re.test(l)))
      return hit.length ? done(0, hit.map(([p]) => `${ref}:${p}`).join('\n')) : done(1)
    }
    if (rest[0] === 'log') {
      const f = fs?.[rest[5] as string]
      return f ? done(0, String(f.at)) : done(0, '')
    }
    if (rest[0] === 'show') {
      const f = fs?.[(rest[1] as string).slice(ref.length + 1)]
      return f ? done(0, f.md) : done(128)
    }
    return done(128)
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  return s
}

const run = ($: { tool: { call: (x: never) => Promise<{ deny?: string }> } }, command: string, extra: object = {}) =>
  $.tool.call({ tool: 'Bash', command, ...extra } as never)

const SHIP = '# 审\n\n## 结论:**SHIP**\n被审 SHA:`abc1234`\n'
const FIX = '# 审\n\n## 结论:**FIX-FIRST**\n'

// S8(agent-guard/hooks/merge-note.ts): a merge into a configured repo's main worktree must carry 被审 SHA /
// 判词 / 闸日志 in its message. This file is about G-R alone, so every merge below that runs in the main
// checkout carries the note and each assertion reads G-R's answer. The WT / OTHER merges stay bare on
// purpose: those assert that the gates stay silent, and only a note-less merge can show that.
const WITH_NOTE = ['被审 SHA: ' + 'a'.repeat(40), '判词: docs/reviews/agent-x.md', '闸日志: /tmp/agent-x.log']
  .map(l => `-m "${l}"`).join(' ')

describe('G-R rules', () => {
  test('git merge 认出分支与所在目录;--abort / 引号里 / 别的子命令不算', async () => {
    const isDir = async (p: string) => dirs.has(p)
    expect(await gitMerges('git merge --no-ff -m "merge: x" agent/x', MAIN, '/h', isDir)).toEqual([{ dir: MAIN, branches: ['agent/x'] }])
    expect(await gitMerges(`cd ${WT} && git merge main`, MAIN, '/h', isDir)).toEqual([{ dir: WT, branches: ['main'] }])
    expect(await gitMerges(`git -C ${MAIN} merge -s ort -X theirs a b`, WT, '/h', isDir)).toEqual([{ dir: MAIN, branches: ['a', 'b'] }])
    expect(await gitMerges('git merge --abort', MAIN, '/h', isDir)).toEqual([])
    expect(await gitMerges('git merge', MAIN, '/h', isDir)).toEqual([])
    expect(await gitMerges('echo "git merge agent/x"; git merge-base main x', MAIN, '/h', isDir)).toEqual([])
  })

  test('判词行:各种既有写法;两个结论词或没有结论行 → null', () => {
    expect(verdictOf('## 结论:**SHIP**')).toBe('SHIP')
    expect(verdictOf('审法:所有结论都带读数\n\n## 结论:SHIP(合并前补一件事,见 P1-1)')).toBe('SHIP')
    expect(verdictOf('**结论**：**FIX-FIRST**（两个 P1')).toBe('FIX-FIRST')
    expect(verdictOf('## 结论\n\n**SHIP。** 四条核对全部通过')).toBe('SHIP')
    expect(verdictOf('结论:MERGE')).toBe('MERGE')
    expect(verdictOf('上一轮结论:`b1-review.md`(FIX-FIRST:P1-1)\n\n## 结论:**SHIP**')).toBe('SHIP')
    expect(verdictOf('结论:SHIP | FIX-FIRST')).toBe(null)
    expect(verdictOf('# 审\n\n没有结论行')).toBe(null)
  })

  test('判词文件名:docs/reviews/<slug>.md 与旧路径 <片名>-review / -rereview(片名可带 goalNNNN-)', () => {
    const files = [
      'docs/reviews/agent-goal1013-avatar.md',
      'docs/reviews/agent-goal1013-avatar-brief.md',
      'docs/plan/10.13/avatar-review.md',
      'docs/plan/10.13/avatar-rereview.md',
      'docs/plan/10.13/avatar-review-brief.md',
      'docs/plan/10.13/avatarx-review.md',
    ]
    expect(verdictPaths('agent/goal1013-avatar', files)).toEqual([
      'docs/reviews/agent-goal1013-avatar.md',
      'docs/plan/10.13/avatar-review.md',
      'docs/plan/10.13/avatar-rereview.md',
    ])
    const re = new RegExp(branchMention('agent/goal1013-avatar'))
    expect(re.test('审查对象:`agent/goal1013-avatar` @ abc')).toBe(true)
    expect(re.test('审查对象:`agent/goal1013-avatar-f1`')).toBe(false)
  })
})

describe('G-R hook: git merge in MyApp main checkout', () => {
  test('碰敏感路径、没有判词 → 拒,文案说缺什么、怎么起审', async ($, on) => {
    world(on, MAIN, { touch: { 'agent/hot': 2 }, files: { 'agent/hot': {}, main: {} } })
    const d = (await run($, `git merge --no-ff ${WITH_NOTE} agent/hot`)).deny
    expect(d).toContain('G-R')
    expect(d).toContain('apps/web/src/lib/x/actions.ts')
    expect(d).toContain('docs/reviews/agent-hot.md')
    expect(d).toContain('review-launch.sh agent/hot')
  })

  test('子 agent 同样被拒(主会话与子 agent 都管)', async ($, on) => {
    world(on, WT, { touch: { 'agent/hot': 2 }, files: { 'agent/hot': {}, main: {} } })
    expect((await run($, `git -C ${MAIN} merge agent/hot`)).deny).toContain('G-R')
  })

  test('判词 SHIP(在分支上或 main 上)→ 放行;没碰敏感路径 → 放行', async ($, on) => {
    world(on, MAIN, {
      touch: { 'agent/a': 2, 'agent/b': 2, 'agent/cold': 0 },
      files: {
        'agent/a': { 'docs/reviews/agent-a.md': { at: 10, md: SHIP } },
        'agent/b': {},
        'agent/cold': {},
        main: { 'docs/plan/10.13/b-review.md': { at: 5, md: SHIP } },
      },
    })
    expect((await run($, `git merge ${WITH_NOTE} agent/a`)).deny).toBeUndefined()
    expect((await run($, `git merge ${WITH_NOTE} agent/b`)).deny).toBeUndefined()
    expect((await run($, `git merge ${WITH_NOTE} agent/cold`)).deny).toBeUndefined()
  })

  test('最新一份是 FIX-FIRST → 拒;复审 SHIP 更新 → 放行', async ($, on) => {
    const w = world(on, MAIN, {
      touch: { 'agent/goal1013-p': 2 },
      files: {
        'agent/goal1013-p': {},
        main: {
          'docs/plan/10.13/p-review.md': { at: 10, md: SHIP },
          'docs/plan/10.13/p-rereview.md': { at: 20, md: FIX },
        },
      },
    })
    expect((await run($, `git merge ${WITH_NOTE} agent/goal1013-p`)).deny).toContain('FIX-FIRST')
    w.files.main!['docs/plan/10.13/p-rereview.md'] = { at: 30, md: SHIP }
    expect((await run($, `git merge ${WITH_NOTE} agent/goal1013-p`)).deny).toBeUndefined()
  })

  test('旧判词按正文提到分支名找到(文件名对不上)', async ($, on) => {
    world(on, MAIN, {
      touch: { 'omdl/g-gr-koti': 2 },
      files: { 'omdl/g-gr-koti': {}, main: { 'docs/plan/10.13/gr-review.md': { at: 9, md: '- 审查对象:`omdl/g-gr-koti` @ x\n\n## 结论\n\n**SHIP。**\n\n- 被审 SHA:abc1234\n' } } },
    })
    expect((await run($, `git merge ${WITH_NOTE} omdl/g-gr-koti`)).deny).toBeUndefined()
  })

  test('判词绑 SHA:没写被审 SHA → 拒;SHA 不在分支历史 → 拒;审后又改代码 → 拒;审后只改 docs / 测试 / 探针 → 放行', async ($, on) => {
    const ship = { 'docs/reviews/agent-s.md': { at: 1, md: SHIP } }
    const w = world(on, MAIN, {
      touch: { 'agent/s': 2, 'agent/n': 2 },
      files: { 'agent/s': ship, 'agent/n': { 'docs/reviews/agent-n.md': { at: 1, md: '## 结论:SHIP\n' } }, main: {} },
    })
    expect((await run($, `git merge ${WITH_NOTE} agent/n`)).deny).toContain('被审 SHA')
    w.after['agent/s'] = ['docs/reviews/agent-s.md', 'apps/web/src/lib/x/actions.test.ts', 'supabase/ci/204_write_version_probes.sql']
    expect((await run($, `git merge ${WITH_NOTE} agent/s`)).deny).toBeUndefined()
    w.after['agent/s'] = ['docs/reviews/agent-s.md', 'apps/web/src/lib/x/actions.ts']
    const d = (await run($, `git merge ${WITH_NOTE} agent/s`)).deny
    expect(d).toContain('apps/web/src/lib/x/actions.ts')
    expect(d).toContain('重起一轮审')
    w.after['agent/s'] = []
    w.notAncestor.add('agent/s')
    expect((await run($, `git merge ${WITH_NOTE} agent/s`)).deny).toContain('不在 agent/s 的历史里')
  })

  test('被审 SHA 行与审后路径判定(纯函数)', () => {
    expect(reviewedShaOf('## 结论:SHIP\n被审 SHA:`9ab32aecb1`')).toBe('9ab32aecb1')
    expect(reviewedShaOf('- **被审 SHA**: 9ab32aecb')).toBe('9ab32aecb')
    expect(reviewedShaOf('审查对象:分支 x @ 9ab32aecb')).toBe(null)
    expect(postReviewBlockers(['docs/a.md', 'README.md', 'a/b.test.tsx', 'x/__tests__/y.ts', 'supabase/ci/1_p_probes.sql', ''])).toEqual([])
    expect(postReviewBlockers(['supabase/ci/replay.sh', 'supabase/migrations/0394_x.sql', 'scripts/dev/x.mjs'])).toEqual(['supabase/ci/replay.sh', 'supabase/migrations/0394_x.sql', 'scripts/dev/x.mjs'])
  })

  test('判词读不出结论行 → 拒', async ($, on) => {
    world(on, MAIN, { touch: { 'agent/q': 2 }, files: { 'agent/q': { 'docs/reviews/agent-q.md': { at: 1, md: '# 审\n没写结论\n' } }, main: {} } })
    expect((await run($, `git merge ${WITH_NOTE} agent/q`)).deny).toContain('读不出')
  })

  test('闸自身故障(脚本缺 / 读不到分支文件表)→ 放行并 toast 一行', async ($, on) => {
    const w = world(on, MAIN, { touch: {}, files: {} })
    expect((await run($, `git merge ${WITH_NOTE} agent/x`)).deny).toBeUndefined()
    expect(w.toasts.join('\n')).toContain('判不了 agent/x')
  })

  test('只管配置的仓库的主 worktree:别的仓 / linked worktree 里合并不判', async ($, on) => {
    world(on, OTHER, { touch: { 'agent/hot': 2 }, files: { 'agent/hot': {}, main: {} } })
    expect((await run($, 'git merge agent/hot')).deny).toBeUndefined()
    expect((await run($, `cd ${WT} && git merge agent/hot`)).deny).toBeUndefined()
  })
})
