// claude plugin test /home/user/repos/claude-mods/agent-guard
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { gitWrites, shellCommands } from './rules'

// S9: the task book a verdict names, and the digest its sha256sum stands for. The hook sandbox only allows
// relative imports and "claude-code", so this is a well-formed stand-in: spec-check.test.mjs pins spec-check.mjs's
// own specSha against the same `sha256sum` line, which is what has to match here.
const SPEC = '/r/docs/x.md'
const SPEC_SHA = 'c'.repeat(64)

const MAIN = '/r/myapp'
const WT = '/r/myapp-wt'
// S9: a repo in specGateRepos but not in reviewGateRepos (its main worktree, so S8 never looks at it).
const CM = '/r/claude-mods'
// 共享开发栈闸:不在 devstackGuardRepos 里的另一个仓的主 worktree。
const BB = '/r/otherapp'
const RUNS = '/r/runs' // S9: OMDL_RUNS
const SHA = 'ab'.repeat(20)
// 重命令送 build box:WT 的一个子目录(会话 cwd 不在仓顶)。
const WT_WEB = `${WT}/apps/web`
const dirs = new Set([MAIN, WT, CM, BB, '/r', WT_WEB])
// 重命令送 build box:最后一个 Bash 钩子收到的命令(改写之后的样子)与写进 heavy-route.jsonl 的行。
const LEDGER = '/home/t/.omd-lite/readings/heavy-route.jsonl'
const seen: { commands: string[]; timeouts: unknown[]; ledger: Record<string, unknown>[] } = { commands: [], timeouts: [], ledger: [] }

// A fake git: MAIN is a main worktree (git-dir == common-dir), WT is a linked one.
// specs: what reading <OMDL_RUNS> yields (keyed by absolute path); globBoom: the candidate listing cannot run.
function world(on: On, cwd: string, opts: { specs?: Record<string, string>; globBoom?: boolean; env?: Record<string, string> } = {}): string[] {
  const { specs = {}, globBoom = false, env = {} } = opts
  // S9: the task book always exists in this world; the runs glob only picks the <OMDL_RUNS>/ paths.
  const files: Record<string, string> = { [SPEC]: '# 片 x\n', ...specs }
  const toasts: string[] = []
  seen.commands = []
  seen.timeouts = []
  seen.ledger = []
  mock.env(on, { HOME: '/home/t', OMDL_RUNS: RUNS, ...env })
  on('session.cwd', () => ({ value: cwd }))
  on('fs.stat', (_, e) => {
    if (!dirs.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } as never
  })
  on('fs.read', (_, e) => {
    const t = files[e.path]
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: t } as never
  })
  on('ui.toast', (_, e) => (toasts.push(String(e.text)), { value: { isShown: true } }) as never)
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    const dir = argv[2] as string
    const q = argv[argv.length - 1]
    const done = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    // S9: the verdict gate hashes the task book named by each verdict's spec field (`sha256sum <path>`:
    // "<64 hex>  <path>"). A path the world doesn't have reads as no digest at all (sha256sum exits non-zero).
    if (argv[0] === 'sha256sum') {
      const p = String(argv[1])
      return files[p] === undefined ? done(1, '') : done(0, `${p === SPEC ? SPEC_SHA : 'd'.repeat(64)}  ${p}\n`)
    }
    // S9: the verdict candidates come from one bash glob over <OMDL_RUNS>/<run>[-r<digits>].
    if (argv[0] === 'bash' && argv.includes(RUNS)) {
      if (globBoom) throw new Error('spawn bash ENOENT')
      return done(0, Object.keys(files).filter(p => p.startsWith(`${RUNS}/`)).join('\n'))
    }
    // 重命令送 build box:记账一行 = bash 追加到 LEDGER;仓判 = 一条 rev-parse 同时问仓顶与公共 git 目录。
    if (argv[0] === 'bash' && argv.includes(LEDGER)) {
      seen.ledger.push(JSON.parse(String(argv[argv.length - 1])))
      return done(0, '')
    }
    if (argv[0] === 'git' && argv.includes('--show-toplevel') && argv.includes('--git-common-dir')) {
      if (dir === WT || dir === WT_WEB) return done(0, `${WT}\n${MAIN}/.git\n`)
      if (dir === MAIN) return done(0, `${MAIN}\n${MAIN}/.git\n`)
      if (dir === BB) return done(0, `${BB}\n${BB}/.git\n`)
      if (dir === CM) return done(0, `${CM}\n${CM}/.git\n`)
      return done(128, '')
    }
    if (dir === MAIN) return done(0, `${MAIN}/.git`)
    if (dir === CM) return done(0, q === '--show-toplevel' ? CM : `${CM}/.git`)
    if (dir === BB) return done(0, q === '--show-toplevel' ? BB : `${BB}/.git`)
    if (dir === WT) return done(0, q === '--git-dir' ? `${MAIN}/.git/worktrees/wt` : `${MAIN}/.git`)
    return done(128, '')
  })
  on('tool.call', { tool: 'Bash' }, (_, e) => (seen.commands.push(String(e.command)), seen.timeouts.push(e.timeout), { result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  return toasts
}

const sub = { agentId: 'a1' }
const run = ($: { tool: { call: (x: never) => Promise<{ deny?: string }> } }, command: string, extra: object = {}) =>
  $.tool.call({ tool: 'Bash', command, ...extra } as never)

describe('agent-guard: subagent git writes in a main worktree', () => {
  test('subagent commit in the main checkout is denied, with the way out', async ($, on) => {
    world(on, MAIN)
    const out = await run($, 'git commit -m x', sub)
    expect(out.deny).toContain('git commit')
    expect(out.deny).toContain('WORKTREE')
  })

  test('subagent commit in a linked worktree passes', async ($, on) => {
    world(on, MAIN)
    expect((await run($, `cd ${WT} && git add -A && git commit -m x`, sub)).deny).toBeUndefined()
    expect((await run($, `git -C ${WT} commit -m x`, sub)).deny).toBeUndefined()
  })

  test('subagent git -C <main> merge is denied even from a linked worktree cwd', async ($, on) => {
    world(on, WT)
    expect((await run($, `git -C ${MAIN} merge feature`, sub)).deny).toContain('git merge')
  })

  test('subagent read-only git in the main checkout passes', async ($, on) => {
    world(on, MAIN)
    for (const c of ['git status', 'git log --oneline -3', 'git diff HEAD', 'git show HEAD', 'git rev-parse HEAD', 'git worktree list', 'git -C /r/myapp status']) {
      expect((await run($, c, sub)).deny).toBeUndefined()
    }
  })

  test('the lead may commit in the main checkout', async ($, on) => {
    world(on, MAIN)
    expect((await run($, 'git commit -m x')).deny).toBeUndefined()
    expect((await run($, 'git push')).deny).toBeUndefined()
  })

  test('the lead may not move HEAD or a branch in the main checkout; the override prefix and a worktree pass', async ($, on) => {
    world(on, MAIN)
    for (const c of ['git checkout -q 93ec4f6f8', 'git switch other', 'git branch -f main HEAD', 'git reset --hard HEAD~1', 'git update-ref refs/heads/main HEAD', 'FOO=1 git checkout main']) {
      expect((await run($, c)).deny).toContain('lead 也一样')
    }
    expect((await run($, 'MYAPP_MAIN_CHECKOUT=1 git checkout main')).deny).toBeUndefined()
    expect((await run($, `git -C ${WT} checkout -q 93ec4f6f8`)).deny).toBeUndefined()
    expect((await run($, 'git merge --ff-only agent/x')).deny).toBeUndefined()
    expect((await run($, 'FOO=1 git commit -m x', sub)).deny).toContain('git commit')
    expect((await run($, 'MYAPP_MAIN_CHECKOUT=1 git checkout main', sub)).deny).toContain('git checkout')
  })

  test('cd into a missing directory leaves the shell in the main checkout: denied', async ($, on) => {
    world(on, MAIN)
    expect((await run($, 'cd /r/myapp-gone && git commit -m x', sub)).deny).toContain('git commit')
    expect((await run($, 'cd /r/myapp-gone; git reset HEAD~1', sub)).deny).toContain('git reset')
  })

  test('other writes are caught; a quoted string and a non-repo are not', async ($, on) => {
    world(on, MAIN)
    for (const c of ['git update-ref refs/heads/main abc', 'git rebase main', 'git cherry-pick abc', 'git push origin main', 'git checkout -- src/a.ts', 'git switch main', 'git -c user.name=x commit -m y']) {
      expect((await run($, c, sub)).deny).toBeDefined()
    }
    expect((await run($, 'echo "git commit && git push"', sub)).deny).toBeUndefined()
    // 18.10: moving HEAD in the main checkout was let through here; that is how wf_4e3ec57e-9a5 detached it.
    expect((await run($, 'git checkout feature', sub)).deny).toContain('git checkout')
  })

  test('a directory that is no repo is left alone', async ($, on) => {
    world(on, '/tmp/elsewhere')
    expect((await run($, 'git commit -m x', sub)).deny).toBeUndefined()
  })
})

describe('agent-guard: the wider write list', () => {
  const cases: [string, string, string][] = [
    ['revert', 'git revert HEAD', 'git revert'],
    ['pull', 'git pull --ff-only', 'git pull'],
    ['am', 'git am fix.patch', 'git am'],
    ['stash', 'git stash', 'git stash'],
    ['branch -D', 'git branch -D old', 'git branch'],
    ['tag create', 'git tag v1', 'git tag'],
    ['tag -d', 'git tag -d v1', 'git tag'],
    ['clean', 'git clean -fd', 'git clean'],
    ['restore', 'git restore src/a.ts', 'git restore'],
    // 18.10 wf_4e3ec57e-9a5: `cd /home/user/repos/myapp; git checkout -q 93ec4f6f8` detached the main checkout.
    ['checkout <sha>', 'git checkout -q 93ec4f6f8', 'git checkout'],
    ['checkout -B', 'git checkout -q -B l3/x FETCH_HEAD', 'git checkout'],
    ['switch', 'git switch other', 'git switch'],
  ]
  for (const [name, cmd, verb] of cases) {
    test(`${name}: denied in the main checkout, passes in a linked worktree`, async ($, on) => {
      world(on, MAIN)
      expect((await run($, cmd, sub)).deny).toContain(verb)
      expect((await run($, `git -C ${WT} ${cmd.slice(4)}`, sub)).deny).toBeUndefined()
    })
  }

  test('read forms of stash, branch and tag pass in the main checkout', async ($, on) => {
    world(on, MAIN)
    for (const c of ['git stash list', 'git stash show -p', 'git branch', 'git branch -a', 'git tag', 'git tag -l "v*"', 'git tag --list']) {
      expect((await run($, c, sub)).deny).toBeUndefined()
    }
  })
})

// S9: merging an omdl/* branch into a specGate repo's main checkout needs a spec-verdict.json bound to the
// same reviewed SHA, judged over 3 passes (specSha of the task book unchanged). claude-mods is in
// specGateRepos, not in reviewGateRepos: S8 never looks there.
describe('agent-guard(S9): omdl/* merge needs a spec verdict bound to the same sha', () => {
  const note = (...lines: string[]) => lines.map(l => `-m "${l}"`).join(' ')
  const FULL = note('merge(omdl-x): 合', `被审 SHA: ${SHA}`, '判词: /g/ok.txt', '闸日志: /g/ok.txt')
  // The task book the verdict names, and the sha256 of its content (what spec-check.mjs recorded when judging).
  const clean = (over: Record<string, unknown> = {}, head = SHA): string =>
    JSON.stringify({ missing: [], extra: [], wrong: [], head, base: 'cd'.repeat(20), spec: SPEC, specSha: SPEC_SHA, runs: 3, at: '2026-10-19T00:00:00Z', ...over })

  test('runs 里有一份绑同一被审 SHA 的空判词 → 放行', async ($, on) => {
    const toasts = world(on, CM, { specs: { [`${RUNS}/x-r2/spec-verdict.json`]: clean() } })
    expect((await run($, `git merge --no-ff ${FULL} omdl/x`)).deny).toBeUndefined()
    expect(toasts).toEqual([])
  })

  test('判词里的 specSha 与任务书现在的内容对不上 → 拒,文字点名任务书改过', async ($, on) => {
    world(on, CM, { specs: { [`${RUNS}/x/spec-verdict.json`]: clean({ specSha: 'd'.repeat(64) }) } })
    expect((await run($, `git merge --no-ff ${FULL} omdl/x`)).deny).toContain('任务书改过')
  })

  // 每份候选按自己那条 spec 路径算摘要(续跑目录可能来自另一个仓的检出):一份判词的任务书改过,
  // 不该把另一份没动过的一起拒掉。
  test('每份候选按自己那条 spec 路径算摘要:另一份判词的任务书改过,这一份照样放行', async ($, on) => {
    world(on, CM, {
      specs: {
        '/r/docs/y.md': '# 片 y\n改过了\n',
        [`${RUNS}/x/spec-verdict.json`]: clean({ spec: '/r/docs/y.md', specSha: SPEC_SHA, extra: ['nope'] }),
        [`${RUNS}/x-r2/spec-verdict.json`]: clean(),
      },
    })
    expect((await run($, `git merge --no-ff ${FULL} omdl/x`)).deny).toBeUndefined()
  })

  test('判词只判了 2 遍(重跑到绿的那一遍不算)→ 拒,文字点名 runs 不足 3', async ($, on) => {
    world(on, CM, { specs: { [`${RUNS}/x/spec-verdict.json`]: clean({ runs: 2 }) } })
    expect((await run($, `git merge --no-ff ${FULL} omdl/x`)).deny).toContain('runs 不足 3')
  })

  test('没有判词 → 拒,文字说清没有 spec-verdict.json 与下跑哪条命令', async ($, on) => {
    world(on, CM)
    const d = (await run($, `git merge --no-ff ${FULL} omdl/x`)).deny
    expect(d).toContain('agent-guard(S9):')
    expect(d).toContain('没有 spec-verdict.json')
    expect(d).toContain('spec-check.mjs x')
  })

  test('判词绑的是别的提交 → 拒,文字点两个 sha 的头 9 位', async ($, on) => {
    const toasts = world(on, CM, { specs: { [`${RUNS}/x/spec-verdict.json`]: clean({}, 'cd'.repeat(20)) } })
    const a = (await run($, `git merge --no-ff ${FULL} omdl/x`)).deny as string
    expect(a).toContain('agent-guard(S9):')
    expect(a).toContain(SHA.slice(0, 9))
    expect(a).toContain('cd'.repeat(20).slice(0, 9))
    expect(a).toContain('spec-check.mjs x')
    expect(toasts).toEqual([])
  })

  test('判词有一条 extra → 拒,文字说各有几条', async ($, on) => {
    world(on, CM, { specs: { [`${RUNS}/x/spec-verdict.json`]: clean({ extra: ['多改了 b.txt'] }) } })
    expect((await run($, `git merge --no-ff ${FULL} omdl/x`)).deny).toContain('extra 1')
  })

  test('接不回说明 / 说明里没有被审 SHA 那一行 → 拒,文字要人先写三行说明', async ($, on) => {
    world(on, CM, { specs: { [`${RUNS}/x/spec-verdict.json`]: clean() } })
    const bare = (await run($, 'git merge --no-ff omdl/x')).deny as string
    expect(bare).toContain('agent-guard(S9):')
    expect(bare).toContain('三行说明')
    const noSha = (await run($, `git merge --no-ff ${note('merge(omdl-x): 合', '判词: /g/ok.txt')} omdl/x`)).deny as string
    expect(noSha).toContain('agent-guard(S9):')
    expect(noSha).toContain('被审 SHA')
  })

  test('快进 --ff-only 与非 omdl 分支不由 S9 判', async ($, on) => {
    world(on, CM, { specs: { [`${RUNS}/x/spec-verdict.json`]: clean() } })
    expect((await run($, 'git merge --ff-only -m "闸日志: /g/ok.txt" land/f4')).deny).toBeUndefined()
    expect((await run($, `git merge --no-ff ${FULL} land/f4`)).deny).toBeUndefined()
  })

  test('列不出 runs 目录 → 放行并 toast 一行(点不出就不静默放过)', async ($, on) => {
    const toasts = world(on, CM, { globBoom: true })
    expect((await run($, `git merge --no-ff ${FULL} omdl/x`)).deny).toBeUndefined()
    expect(toasts.join('\n')).toContain('agent-guard(S9):')
    expect(toasts.join('\n')).toContain('已放行')
  })

  // S9 的作用面是 specGateRepos,自己一个键:不跟 reviewGateRepos 联动。
  test('specGateRepos 里没有这个仓 → 这一条不判(默认名单里 claude-mods 是有的)', { options: { specGateRepos: 'otherapp' } }, async ($, on) => {
    world(on, CM)
    expect((await run($, `git merge --no-ff ${FULL} omdl/x`)).deny).toBeUndefined()
  })
})

// 31.10:子 agent 照写错的任务书 reset 了两次 MyApp 的共享开发栈(127.0.0.1:54322),清掉了别的会话的数据。
describe('agent-guard: 共享开发栈不许 supabase db reset', () => {
  const ISO = 'postgresql://postgres:postgres@127.0.0.1:55432/postgres'
  const SHARED = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

  test('子 agent 裸 reset(各种起法)→ 拒,文字给出替代做法', async ($, on) => {
    world(on, WT)
    for (const c of [
      'npx supabase db reset',
      'supabase db reset',
      'npx --yes supabase db reset --local',
      'npx supabase@2.119.0 db reset',
      './node_modules/.bin/supabase db reset',
      'npm exec --yes --package=supabase@2.119.0 -- supabase db reset',
      `cd ${WT} && npx supabase db reset`,
      'npx supabase migration up; npx supabase db reset',
      "bash -c 'cd /r && npx supabase db reset'",
    ]) {
      const d = (await run($, c, sub)).deny
      expect(d).toContain('共享开发栈')
      expect(d).toContain('replay-local.sh')
      expect(d).toContain('run_isolated_stack.py')
      expect(d).toContain('DEVSTACK_RESET_ACK')
    }
  })

  test('主会话裸 reset → 拒', async ($, on) => {
    world(on, MAIN)
    expect((await run($, 'npx supabase db reset')).deny).toContain('共享开发栈')
  })

  test('--db-url 指向隔离栈(端口不是 54322)→ 放行;指向 54322 → 拒', async ($, on) => {
    world(on, WT)
    expect((await run($, `npx supabase db reset --db-url ${ISO}`, sub)).deny).toBeUndefined()
    expect((await run($, `npx supabase db reset --db-url=${ISO}`, sub)).deny).toBeUndefined()
    expect((await run($, `npx supabase db reset --db-url ${SHARED}`, sub)).deny).toContain('共享开发栈')
    expect((await run($, 'npx supabase db reset --db-url "$DB_URL"', sub)).deny).toContain('共享开发栈')
  })

  test('主会话带非空 DEVSTACK_RESET_ACK 前缀 → 放行;空理由与子 agent 带了 → 拒', async ($, on) => {
    world(on, MAIN)
    expect((await run($, "DEVSTACK_RESET_ACK='lead 31.10 重置共享栈' npx supabase db reset")).deny).toBeUndefined()
    expect((await run($, "DEVSTACK_RESET_ACK='x' bash -c 'npx supabase db reset'")).deny).toBeUndefined()
    expect((await run($, "DEVSTACK_RESET_ACK='' npx supabase db reset")).deny).toContain('共享开发栈')
    expect((await run($, "DEVSTACK_RESET_ACK='lead 说的' npx supabase db reset", sub)).deny).toContain('共享开发栈')
  })

  test('别的仓不拦;devstackGuardRepos 换了仓就按新名单', async ($, on) => {
    world(on, BB)
    expect((await run($, 'npx supabase db reset', sub)).deny).toBeUndefined()
  })

  test('devstackGuardRepos 不含 myapp → myapp 里不拦', { options: { devstackGuardRepos: 'otherapp' } }, async ($, on) => {
    world(on, MAIN)
    expect((await run($, 'npx supabase db reset', sub)).deny).toBeUndefined()
  })

  test('devstackGuardRepos 换成 otherapp → otherapp 里拦', { options: { devstackGuardRepos: 'otherapp' } }, async ($, on) => {
    world(on, BB)
    expect((await run($, 'npx supabase db reset', sub)).deny).toContain('共享开发栈')
  })

  test('读不到仓名 → 不拦', async ($, on) => {
    world(on, '/tmp/elsewhere')
    expect((await run($, 'npx supabase db reset', sub)).deny).toBeUndefined()
  })

  test('只在字符串里出现、migration up 与别的 db 子命令 → 不拦', async ($, on) => {
    world(on, WT)
    for (const c of ['echo "supabase db reset"', "rg 'db reset' docs", 'npx supabase migration up', 'npx supabase db diff', 'git log --grep "supabase db reset"']) {
      expect((await run($, c, sub)).deny).toBeUndefined()
    }
  })
})

// 31.10 owner:dev box 一直轻,不靠各会话记得去 build box。重命令由钩子改写成经 remote-run 在 build box 上跑。
describe('agent-guard: 重命令送 build box', () => {
  const TOP = '__HEAVY_ROUTE_TOP__'
  const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const buildbox = (top: string, inner: string, env = 'export CI=1 PLAYWRIGHT_HTML_OPEN=never; ') =>
    `cd ${sq(top)} && REMOTE_GATE_HOST=gate@build-box REMOTE_RUN_EXEC=$HOME/.local/share/remote-run/remote-run-exec.sh ` +
    `bash $HOME/.local/share/remote-run/remote-run.sh --kind dev -- bash -c 'eval "\${1//${TOP}/"$PWD"}"' heavy-route ${sq(env + inner)}`

  test('MyApp worktree 里裸 vitest(子 agent)→ 改写成 remote-run,记 buildbox', async ($, on) => {
    world(on, WT)
    const c = 'npx vitest run apps/web/src/x.test.ts'
    expect((await run($, c, sub)).deny).toBeUndefined()
    expect(seen.commands).toEqual([buildbox(WT, c)])
    expect(seen.ledger).toHaveLength(1)
    expect(seen.ledger[0]).toMatchObject({ route: 'buildbox', kind: 'vitest', repo: 'myapp', agent: 'a1' })
    expect(typeof seen.ledger[0]?.ts).toBe('string')
  })

  test('主会话同样改写;管道、2>&1、bash -c 里的重命令整条送过去', async ($, on) => {
    world(on, WT)
    for (const c of ['npm run typecheck', 'npx vitest run 2>&1 | tail -20', "bash -c 'npx vitest run'", 'cd apps/web && npx vitest run src/x.test.ts; echo rc=$?']) {
      seen.commands = []
      expect((await run($, c)).deny).toBeUndefined()
      expect(seen.commands).toEqual([buildbox(WT, c)])
    }
  })

  test('白名单每一项都认,kind 记对', async ($, on) => {
    world(on, WT)
    const cases: [string, string][] = [
      ['vitest run', 'vitest'], ['./node_modules/.bin/vitest run x', 'vitest'], ['npx --yes vitest run', 'vitest'],
      ['npx tsc -p .', 'tsc'], ['tsc --noEmit', 'tsc'], ['npm run typecheck:mobile', 'tsc'],
      ['npx eslint .', 'eslint'], ['npm run lint:mobile', 'eslint'], ['npm -w apps/web run lint', 'eslint'],
      ['node --test scripts/x.test.mjs', 'node-test'], ['npx next build', 'build'], ['npm run build', 'build'],
      ['npx playwright test e2e/x.spec.ts', 'playwright'], ['bash scripts/dev/gate-slice.sh main', 'gate-slice'],
      ['scripts/dev/gate-slice.sh', 'gate-slice'],
    ]
    for (const [c, kind] of cases) {
      seen.commands = []
      seen.ledger = []
      expect((await run($, c, sub)).deny).toBeUndefined()
      expect(seen.commands).toEqual([buildbox(WT, c)])
      expect(seen.ledger[0]).toMatchObject({ route: 'buildbox', kind })
    }
  })

  test('不在白名单的照原样跑、不记账', async ($, on) => {
    world(on, WT)
    for (const c of ['ls && git status', 'node scripts/x.mjs --test', 'npm run dev', 'echo vitest run', "rg 'npx tsc' docs", 'npx prettier --check .']) {
      seen.commands = []
      expect((await run($, c, sub)).deny).toBeUndefined()
      expect(seen.commands).toEqual([c])
    }
    expect(seen.ledger).toEqual([])
  })

  test('开头 cd 到另一个 worktree 的绝对路径:按那个 worktree 打快照,仓顶换成占位', async ($, on) => {
    world(on, MAIN)
    expect((await run($, `cd ${WT} && npm run lint`, sub)).deny).toBeUndefined()
    expect(seen.commands).toEqual([buildbox(WT, `cd ${TOP} && npm run lint`)])
  })

  test('会话在仓里的子目录:本机回仓顶打快照,远端先 cd 回同一个子目录', async ($, on) => {
    world(on, WT_WEB)
    expect((await run($, 'npx vitest run src/x.test.ts', sub)).deny).toBeUndefined()
    expect(seen.commands).toEqual([buildbox(WT, `cd ${TOP}/apps/web && npx vitest run src/x.test.ts`)])
  })

  test('发版检查 → 不改写,记 local', async ($, on) => {
    world(on, WT)
    for (const c of ['cd ~/repos/myapp-release && npm run build', 'node --test scripts/deploy/money-gate.test.mjs']) {
      seen.commands = []
      seen.ledger = []
      expect((await run($, c, sub)).deny).toBeUndefined()
      expect(seen.commands).toEqual([c])
      expect(seen.ledger[0]).toMatchObject({ route: 'local' })
      expect(String(seen.ledger[0]?.reason)).toMatch(/^keep-local:/)
    }
  })

  // owner 2.11:放本机的结论在 MyApp 仓里改成拒(build box 连不到本机栈,快照不带 clients/)。
  test('碰本机栈 / 客户数据的 → 拒,记 deny-local:keep-local', async ($, on) => {
    world(on, WT)
    for (const c of [
      'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run',
      'npx supabase status && npx vitest run', 'npx supabase@2.119.0 functions serve & npx vitest run', 'supabase migration up && npm run build',
      "psql -c 'select 1' && npx vitest run", 'PGURL=postgres://db:54322/x npx vitest run', 'API=http://host:54321 npx vitest run',
      'npm run build -- --db-url x', 'npx vitest run clients/x.test.ts', 'SUPABASE_URL=http://localhost:54321 npx playwright test',
    ]) {
      seen.commands = []
      seen.ledger = []
      expect((await run($, c, sub)).deny).not.toContain('remote-run.sh')
      expect(seen.commands).toEqual([])
      expect(seen.ledger[0]).toMatchObject({ route: 'deny' })
      expect(String(seen.ledger[0]?.reason)).toMatch(/^deny-local:keep-local:/)
    }
  })

  test('路径里带 supabase 的测试照改写(只有操作本机栈的命令才留本机)', async ($, on) => {
    world(on, WT)
    for (const c of ['npx vitest run apps/web/src/lib/supabase/x.test.ts', 'npx vitest run supabase/functions/x.test.ts', 'node --test supabase/ci/x.test.mjs']) {
      seen.commands = []
      expect((await run($, c, sub)).deny).toBeUndefined()
      expect(seen.commands).toEqual([buildbox(WT, c)])
    }
  })

  test('改写时 Bash 超时抬到 600000;原本给得更大的不动;不改写的不碰', async ($, on) => {
    world(on, WT)
    await run($, 'npx vitest run')
    await run($, 'npx vitest run', { timeout: 300_000 })
    await run($, 'npx vitest run', { timeout: 900_000 })
    await run($, 'ls', { timeout: 5_000 })
    await run($, 'node --test scripts/deploy/money-gate.test.mjs')
    expect(seen.timeouts).toEqual([600_000, 600_000, 900_000, 5_000, undefined])
  })

  test("LOCAL_RUN_ACK='<理由>' → 本机跑记 ack;理由为空 → 照改写", async ($, on) => {
    world(on, WT)
    const ack = "LOCAL_RUN_ACK='发版' npm run build"
    expect((await run($, ack)).deny).toBeUndefined()
    expect(seen.commands).toEqual([ack])
    expect(seen.ledger[0]).toMatchObject({ route: 'ack', reason: '发版', kind: 'build' })
    seen.commands = []
    const empty = "LOCAL_RUN_ACK='' npm run build"
    expect((await run($, empty)).deny).toBeUndefined()
    expect(seen.commands).toEqual([buildbox(WT, empty)])
  })

  // lead myapp-34 31.10:执行体沙箱(sandbox-exec 设 SANDBOX_ARM)里不改写 —— 沙箱黑洞了 tailnet、git 替身拒 push,改写了只会白等 3 分钟再本机跑;执行体本来排 gate-slot
  for (const [who, ctx] of [['主会话', undefined], ['子 agent', sub]] as const) test(`执行体沙箱里的重命令(${who})→ 不改写,记 local + executor-sandbox`, async ($, on) => {
    world(on, WT, { env: { SANDBOX_ARM: 'claude' } })
    expect((await run($, 'npx vitest run', ctx)).deny).toBeUndefined()
    expect(seen.commands).toEqual(['npx vitest run'])
    expect(seen.ledger[0]).toMatchObject({ route: 'local', reason: 'executor-sandbox', kind: 'vitest' })
  })

  test('OtherApp 里的 vitest → 不改写,记 local + otherapp-not-on-buildbox', async ($, on) => {
    world(on, BB)
    expect((await run($, 'npx vitest run', sub)).deny).toBeUndefined()
    expect(seen.commands).toEqual(['npx vitest run'])
    expect(seen.ledger[0]).toMatchObject({ route: 'local', reason: 'otherapp-not-on-buildbox', repo: 'otherapp', kind: 'vitest' })
  })

  test('heavyRouteRepos 加上 otherapp → otherapp 里也改写', { options: { heavyRouteRepos: 'myapp,otherapp' } }, async ($, on) => {
    world(on, BB)
    expect((await run($, 'npx vitest run', sub)).deny).toBeUndefined()
    expect(seen.commands).toEqual([buildbox(BB, 'npx vitest run')])
  })

  test('已经是 remote-run 的不再包一层', async ($, on) => {
    world(on, WT)
    const once = buildbox(WT, 'npx vitest run')
    expect((await run($, once, sub)).deny).toBeUndefined()
    expect(seen.commands).toEqual([once])
    expect(seen.ledger[0]).toMatchObject({ route: 'buildbox', reason: 'explicit' })
  })

  test('重命令混着得在本机跑的命令 → 拒,让重命令单独一条;记 deny', async ($, on) => {
    world(on, WT)
    const d = (await run($, 'npm run typecheck && git commit -am x', sub)).deny
    expect(d).toContain('单独')
    expect(d).not.toContain('LOCAL_RUN_ACK')
    expect(seen.commands).toEqual([])
    expect(seen.ledger[0]).toMatchObject({ route: 'deny', kind: 'tsc' })
  })

  test('复核 FIX-FIRST:原来留本机的理由记对(2.11 起拒);写 /dev/null 与 sed -n 照改写;写文件的混进来拒', async ($, on) => {
    world(on, WT)
    const local: [string, string][] = [
      ['npx eslint --fix .', 'writes-files'], ['npm run lint:fix -- apps/web', 'writes-files'], ['npx playwright test -u', 'writes-files'],
      ['npx tsc --build', 'writes-files'], ['npx playwright test --debug', 'local-browser'],
      ['source .env.local && npx vitest run', 'reads-env'], ['set -a; . ./.env.local; npx vitest run', 'reads-env'],
    ]
    for (const [c, reason] of local) {
      seen.commands = []
      seen.ledger = []
      const hasAlt = reason !== 'reads-env' && !c.includes('lint:fix')
      const deny = (await run($, c, sub)).deny ?? ''
      expect({ c, alt: deny.includes('remote-run.sh --kind dev') }).toEqual({ c, alt: hasAlt })
      expect(seen.commands).toEqual([])
      expect(seen.ledger[0]).toMatchObject({ route: 'deny', reason: `deny-local:${reason}` })
    }
    for (const c of ['npx vitest run 2>/dev/null', 'npx vitest run 2>&1 | sed -n 1,40p', 'npx vitest run >&2']) {
      seen.commands = []
      expect((await run($, c, sub)).deny).toBeUndefined()
      expect(seen.commands).toEqual([buildbox(WT, c)])
    }
    for (const c of ['npx vitest run && npx prettier --write .', "bash -c 'npx vitest run > out.txt'", 'npx vitest run `git rev-parse HEAD`', 'npx vitest run &> /tmp/x']) {
      seen.commands = []
      seen.ledger = []
      expect((await run($, c, sub)).deny).toContain('单独')
      expect(seen.commands).toEqual([])
      expect(seen.ledger[0]).toMatchObject({ route: 'deny' })
    }
  })

  test("子 agent 的 LOCAL_RUN_ACK 不认:照改写,账本写明", async ($, on) => {
    world(on, WT)
    const c = "LOCAL_RUN_ACK='想本机跑' npx vitest run"
    expect((await run($, c, sub)).deny).toBeUndefined()
    expect(seen.commands).toEqual([buildbox(WT, c)])
    expect(seen.ledger[0]).toMatchObject({ route: 'buildbox', reason: 'rewrite-subagent-ack-ignored' })
  })

  // lead 31.10:送走的命令在 CI 口径下跑 —— vitest 缺快照直接失败(不在 build box 写新快照),playwright 不起 HTML 报告服务挂住。
  test('CI 口径:普通 vitest 改写后带 CI=1', async ($, on) => {
    world(on, WT)
    expect((await run($, 'npx vitest run', sub)).deny).toBeUndefined()
    expect(seen.commands[0]).toContain('export CI=1 PLAYWRIGHT_HTML_OPEN=never; npx vitest run')
  })

  test('CI 口径:playwright test 改写后带 CI=1 与 PLAYWRIGHT_HTML_OPEN=never', async ($, on) => {
    world(on, WT)
    expect((await run($, 'npx playwright test e2e/x.spec.ts', sub)).deny).toBeUndefined()
    expect(seen.commands[0]).toContain('export CI=1 PLAYWRIGHT_HTML_OPEN=never; npx playwright test e2e/x.spec.ts')
  })

  test('CI 口径:命令里自己写了 CI= / PLAYWRIGHT_HTML_OPEN= 的照用户写的,不覆盖', async ($, on) => {
    world(on, WT)
    const cases: [string, string][] = [
      ['CI=0 npx vitest run', 'export PLAYWRIGHT_HTML_OPEN=never; CI=0 npx vitest run'],
      ['export CI=0; npx vitest run', 'export PLAYWRIGHT_HTML_OPEN=never; export CI=0; npx vitest run'],
      ['env CI= npx vitest run', 'export PLAYWRIGHT_HTML_OPEN=never; env CI= npx vitest run'],
      ['PLAYWRIGHT_HTML_OPEN=never npx playwright test', 'export CI=1; PLAYWRIGHT_HTML_OPEN=never npx playwright test'],
      ['CI=0 PLAYWRIGHT_HTML_OPEN=never npx playwright test', 'CI=0 PLAYWRIGHT_HTML_OPEN=never npx playwright test'],
    ]
    for (const [c, inner] of cases) {
      seen.commands = []
      expect((await run($, c, sub)).deny).toBeUndefined()
      expect(seen.commands).toEqual([buildbox(WT, inner, '')])
    }
  })

  test('supabase db reset 仍被共享栈闸拒(不回归)', async ($, on) => {
    world(on, WT)
    expect((await run($, 'npx supabase db reset', sub)).deny).toContain('共享开发栈')
    expect(seen.commands).toEqual([])
  })
})

describe('agent-guard: command walk', () => {
  test('quotes keep operators inert; cd only moves into existing directories', async () => {
    expect(shellCommands('git commit -m "a && b; c" && ls')).toEqual([['git', 'commit', '-m', 'a && b; c'], ['ls']])
    const isDir = async (p: string) => dirs.has(p)
    expect(await gitWrites('cd /r/myapp-wt && git commit', MAIN, '/h', isDir)).toEqual([{ dir: WT, verb: 'commit' }])
    expect(await gitWrites('cd ../myapp-gone && git commit', MAIN, '/h', isDir)).toEqual([{ dir: MAIN, verb: 'commit' }])
    expect(await gitWrites('cd ../myapp-wt && git commit', MAIN, '/h', isDir)).toEqual([{ dir: WT, verb: 'commit' }])
  })
})
