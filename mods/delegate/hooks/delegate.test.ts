// claude plugin test /home/user/repos/claude-mods/delegate
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { BriefDeny, ExternalAction, Orphan, ScanRun } from './logic'
import { briefGaps, allowedPaths, leadTouches, detachedArgv, findLaunches, findMerges, fullGatesVerdict, layerGatesFor, looksLikeLaunch, mentionsRuns, methodExemption, methodSection, nextLabel, overlap, redispatchArgs, redispatchVerdict, resolveNames, resumeArgs, rewriteLaunches, RUN_NAMES, runsDirOf, runsSliceGate, sensitiveHits, tokenize, wakeText } from './logic'
import { REPLAY, SENSITIVE_PATHS } from './brief-replay.fixtures'
import { SELFCHECK } from './brief-selfcheck.fixtures'

const T0 = 1_800_000_000_000
const CWD = '/r/myapp'
const GOOD_BRIEF = [
  '# s1 · 一句目标(MiniMax 任务书)',
  '**原始目标原文(owner 10.10)**:「性能优先」',
  '**允许改动:** src/a.ts src/b.ts src/new.ts(新建) src/a.test.ts',
  '期望值:无',
  '对外签名:无',
  '## 成功判据',
  '`scripts/dev/gate-slice.sh main` 绿',
].join('\n')

const run = (over: Partial<ScanRun> = {}): ScanRun => ({
  label: 'r1',
  runDir: '/home/t/.omd-lite/runs/r1',
  executor: 'minimax',
  state: 'running',
  round: 1,
  maxRounds: 4,
  startedAt: T0 - 60_000,
  repo: CWD,
  worktree: '/r/omdl-r1',
  branch: 'omdl/r1',
  spec: 'docs/b.md',
  allowed: ['src/z.ts'],
  diffstat: '',
  gateTail: [],
  failedGate: '',
  error: '',
  ...over,
})

type World = {
  runs: ScanRun[]
  files: Record<string, string>
  usedKB: number
  freeKB: number
  bash: string[]
  submits: string[]
  argv: string[][]
  /** The `env` each `argv` entry was run with. */
  envs: (Record<string, string> | undefined)[]
  git?: (argv: string[]) => string
  toasts: string[]
  /** `setsid -f` starts fail with this stderr (exit 1). */
  detachFails?: string
  /** What `scan.mjs --orphans` answers. */
  orphans: Orphan[]
  /** What `scan.mjs --all` answers (every session's runs, G-5). */
  all: ScanRun[]
  /** Executors `command -v` does not find. */
  missing: string[]
  /** 真运行时的 $.fs.exists 对会话目录外的路径一律 false(20.10 实况);给了就只认这个前缀下的。 */
  fsScope?: string
  /** What `$.session.id()` answers; a test moves it to play a /clear. */
  sid: string
  /** `mkdir …/.redispatch.lock` fails (the lock is already there). */
  lockHeld?: boolean
  baseFiles?: string[]
  /** S17: replaces the default prompt.submit answer (a hang, a rejection). */
  onSubmit?: (text: string) => Promise<unknown>
  /** S17: `$.store.get` throws for every key this answers true (a store fault). */
  storeGetFails?: (key: string) => boolean
}

async function world(on: On, over: Partial<World> = {}, store: Record<string, unknown> | Map<string, unknown> = {}) {
  const w: World = {
    runs: [],
    files: { [`${CWD}/docs/b.md`]: GOOD_BRIEF, [`${CWD}/src/a.ts`]: '', [`${CWD}/src/b.ts`]: '' },
    usedKB: 10 * 1048576,
    freeKB: 300 * 1048576,
    bash: [],
    submits: [],
    argv: [],
    envs: [],
    sid: 'S1',
    missing: [],
    orphans: [],
    all: [],
    toasts: [],
    ...over,
  }
  const clock = mock.clock(on, { now: T0 })
  if (store instanceof Map) {
    // a test that wants to look into the store brings its own Map
    on('store.get', (_, e) => {
      if (w.storeGetFails?.(e.key)) throw new Error(`store is down: ${e.key}`)
      return { value: store.get(e.key) }
    })
    on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }) as never)
    on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }) as never)
    on('store.keys', () => ({ value: [...store.keys()] }))
  } else mock.store(on, store)
  mock.env(on, { HOME: '/home/t' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: w.sid }))
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_, e) => (w.toasts.push(String(e.text)), { value: { isShown: true } }) as never)
  on('fs.exists', (_, e) => ({ value: e.path in w.files && (!w.fsScope || e.path.startsWith(w.fsScope)) }))
  on('fs.read', (_, e) => {
    const text = w.files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  // docs/methods/*.yaml 的 stem 由 judge 读:目录里没有文件 = 空列表(不抛),跟 relay 的假 fs 同口径。
  on('fs.list', (_, e) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of Object.keys(w.files)) {
      if (!p.startsWith(`${e.path}/`)) continue
      const [head = '', ...rest] = p.slice(e.path.length + 1).split('/')
      if (head) names.set(head, rest.length ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: T0, isLink: false })) } as never
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    w.argv.push(argv)
    w.envs.push(e.init?.env)
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (String(argv[1]).endsWith('/bin/scan.mjs')) return ok(JSON.stringify(argv[2] === '--orphans' ? w.orphans : argv[2] === '--all' ? w.all : w.runs))
    if (w.detachFails !== undefined && argv[0] === 'sh' && String(argv[2]).includes('setsid -f')) return { value: { exitCode: 1, stdout: '', stderr: w.detachFails, isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'mkdir' && String(argv[1]).endsWith('.redispatch.lock') && w.lockHeld) return { value: { exitCode: 1, stdout: '', stderr: 'File exists', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'sh' && String(argv[2]).includes('command -v')) return { value: { exitCode: w.missing.includes(String(argv[4])) ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'sh') return ok(`${w.usedKB}\n${w.freeKB}\n`)
    if (argv[0] === 'git' && argv[3] === 'cat-file') return { value: { exitCode: (w.baseFiles ?? []).includes(String(argv[5])) ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'git' && w.git) return ok(w.git(argv))
    if (argv[0] === 'test' && argv[1] === '-e') return { value: { exitCode: String(argv[2]) in w.files ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return ok()
  })
  on('turn.start', (_, e) => ({ turnId: (e as { turnId?: string }).turnId ?? 't' }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('prompt.submit', (_, e) => {
    if (w.onSubmit) return w.onSubmit(e.text) as never
    w.submits.push(e.text)
    return { text: e.text }
  })
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    w.bash.push(String(e.command))
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  })
  return { w, clock }
}

/** The session ids the last scan was asked for (bin/scan.mjs's argv). */
const scanIds = (w: World) => String(w.argv.filter(a => String(a[1]).endsWith('/bin/scan.mjs') && a[2] !== '--orphans' && a[2] !== '--all').at(-1)?.[2])
const sessionStart = (source: string, id: string) =>
  ({ hook_event_name: 'SessionStart', source, session_id: id, transcript_path: '/t', cwd: CWD }) as never

const start = { cwd: CWD, surface: 'terminal', isInteractive: true } as const
const launch = (name = 'r9', extra = '') =>
  `cd ${CWD} && nohup /home/user/repos/omd-lite/bin/omd-lite run --repo ${CWD} --base main --spec docs/b.md --model m --prompt omd-leaf --gate "scripts/dev/gate-slice.sh main" --name ${name}${extra} > /tmp/${name}.log 2>&1 &`

async function bash($: Engine, command: string) {
  return $.tool.call({ tool: 'Bash', command })
}

// A consumer, as savvy-progress or relay would be: it reads `$.delegate.runs()` and answers /peek with it.
const consumer = {
  name: 'consumer',
  register(on: On) {
    on('command.run', { command: 'peek' }, async $ => ({ text: JSON.stringify(await $.delegate.runs()) }))
    on('command.run', { command: 'peekall' }, async $ => ({ text: JSON.stringify(await $.delegate.allRuns()) }))
  },
}

describe('delegate: $.delegate.runs (C-0, GWT-7)', () => {
  test('another plugin reads the scan in C-0 shape; result.json before wall_seconds stays running', { plugins: [consumer] }, async ($, on) => {
    await world(on, { runs: [run({ label: 'early', state: 'running' })] })
    await $.session.start(start)
    const out = await $.command.run({ command: 'peek', args: '' } as never)
    const runs = JSON.parse(String((out as { text?: string }).text)) as Record<string, unknown>[]
    expect(runs.length).toBe(1)
    expect(runs[0]?.state).toBe('running')
    expect(runs[0]?.label).toBe('early')
    expect(Object.keys(runs[0] ?? {})).not.toContain('allowed')
    expect(Object.keys(runs[0] ?? {})).not.toContain('gateTail')
  })

  test('tokens and costUsd from the scan reach runs()', { plugins: [consumer] }, async ($, on) => {
    await world(on, { runs: [run({ label: 'paid', state: 'not-run', tokens: 1348323, costUsd: 0.016 })] })
    await $.session.start(start)
    const out = await $.command.run({ command: 'peek', args: '' } as never)
    const runs = JSON.parse(String((out as { text?: string }).text)) as Record<string, unknown>[]
    expect(runs[0]?.tokens).toBe(1348323)
    expect(runs[0]?.costUsd).toBe(0.016)
  })
})

describe('delegate: $.delegate.allRuns (G-5)', () => {
  const allScans = (w: World) => w.argv.filter(a => String(a[1]).endsWith('/bin/scan.mjs') && a[2] === '--all')
  const peekAll = async ($: Engine) => JSON.parse(String(((await $.command.run({ command: 'peekall', args: '' } as never)) as { text?: string }).text)) as Record<string, unknown>[]

  test('allRuns asks scan.mjs --all (no session filter), same C-0 shape; runs() stays this session\'s', { plugins: [consumer] }, async ($, on) => {
    const { w } = await world(on, {
      runs: [run({ label: 'mine' })],
      all: [run({ label: 'mine' }), run({ label: 'theirs', claudeSession: 'S2', repo: '/r/otherapp', allowed: ['x'], gateTail: ['x'] })],
    })
    await $.session.start(start)
    const all = await peekAll($)
    expect(all.map(r => r.label)).toEqual(['mine', 'theirs'])
    expect(Object.keys(all[1] ?? {})).not.toContain('allowed')
    expect(Object.keys(all[1] ?? {})).not.toContain('claudeSession')
    expect(Object.keys(all[1] ?? {})).not.toContain('gateTail')
    const mine = JSON.parse(String(((await $.command.run({ command: 'peek', args: '' } as never)) as { text?: string }).text)) as Record<string, unknown>[]
    expect(mine.map(r => r.label)).toEqual(['mine'])
    // the session scan still goes by session id and never carries --all
    expect(scanIds(w)).toBe('S1')
    expect(allScans(w).length).toBe(1)
    expect(allScans(w)[0]).toEqual(['node', expect.stringContaining('/bin/scan.mjs'), '--all'])
  })

  test('allRuns does not feed the wake, the guard or a redispatch: another session\'s failed run is not touched', { plugins: [consumer] }, async ($, on) => {
    const failed = run({ label: 'theirs', state: 'fail', claudeSession: 'S2', piwFailure: 'quota', failedCoords: ['m/a'], launch: { repo: CWD, base: 'abc', worktree: '/r/omdl-theirs', branch: 'omdl/theirs', spec: 'docs/b.md', prompt: 'omd-leaf', gates: [], context: true }, endedAt: T0 - 1000 })
    const { w } = await world(on, { all: [failed] })
    await $.session.start(start)
    await peekAll($)
    expect(w.submits).toEqual([])
    expect(w.argv.some(a => a.some(x => String(x).includes('.redispatch.lock')))).toBe(false)
    expect(w.argv.some(a => a.some(x => String(x).includes('setsid -f')))).toBe(false)
  })

  test('two asks inside 2 s scan once; a later ask scans again and sees the new run', { plugins: [consumer] }, async ($, on) => {
    const { w, clock } = await world(on, { all: [run({ label: 'a' })] })
    await $.session.start(start)
    await peekAll($)
    await peekAll($)
    expect(allScans(w).length).toBe(1)
    w.all = [run({ label: 'a' }), run({ label: 'b' })]
    await clock.advance(2500)
    expect((await peekAll($)).map(r => r.label)).toEqual(['a', 'b'])
    expect(allScans(w).length).toBe(2)
  })

  test('a failing scan answers with the last good list', { plugins: [consumer] }, async ($, on) => {
    const { w, clock } = await world(on, { all: [run({ label: 'a' })] })
    await $.session.start(start)
    expect((await peekAll($)).length).toBe(1)
    w.all = 'not a list' as never // the fake scan answers a JSON string, not an array
    await clock.advance(2500)
    expect((await peekAll($)).map(r => r.label)).toEqual(['a'])
  })
})

describe('delegate: the launch guard', () => {
  test('a good launch passes, its gates passed through unchanged (D-11)', async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toBeUndefined()
    expect(w.bash.length).toBe(1)
    expect(w.bash[0]).toContain(`--gate "scripts/dev/gate-slice.sh main"`)
    expect(w.bash[0]).not.toContain('gate-slot')
    expect(w.bash[0]).toContain('--name r9 > /tmp/r9.log 2>&1 &')
  })

  test('C-1b: a brief without its three lines is refused, naming each', async ($, on) => {
    const { w } = await world(on)
    w.files[`${CWD}/docs/b.md`] = '# x\n允许改动: src/a.ts\n'
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toContain('原始目标原文')
    expect(out.deny).toContain('成功判据')
    expect(out.deny).not.toContain('缺「允许改动:」行')
    expect(w.bash.length).toBe(0)
  })

  test('C-1b: an allowed path that does not exist and is not marked 新建 is refused', async ($, on) => {
    const { w } = await world(on)
    w.files[`${CWD}/docs/b.md`] = GOOD_BRIEF.replace('src/b.ts', 'src/ghost.ts')
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toContain('src/ghost.ts')
  })

  test('20.10: 绝对路径起别的仓的片,允许改动里已在的文件不因 $.fs.exists 只认会话目录而被判不存在', async ($, on) => {
    const cfg = JSON.stringify({ launch: 'scripts/dev/omdl-launch.sh' })
    const { w } = await world(on, { files: { [`${CWD}/.claude/delegate.json`]: cfg, '/r/otherapp/docs/b.md': GOOD_BRIEF, '/r/otherapp/src/a.ts': '', '/r/otherapp/src/b.ts': '' } })
    w.fsScope = `${CWD}/`
    await $.session.start(start)
    const out = await bash($, `cd /r/otherapp && /r/otherapp/scripts/dev/omdl-launch.sh s1 main /r/otherapp/docs/b.md`)
    expect(String(out.deny ?? '')).not.toContain('不存在')
  })

  test('24.10: 允许改动里的文件只在基线分支上(主仓工作树没有)→ 不判不存在;基线上也没有照判', async ($, on) => {
    const cfg = JSON.stringify({ launch: 'scripts/dev/omdl-launch.sh' })
    const { w } = await world(on, { files: { [`${CWD}/.claude/delegate.json`]: cfg, '/r/otherapp/docs/b.md': GOOD_BRIEF, '/r/otherapp/src/a.ts': '' } })
    w.baseFiles = ['lead/integ:src/b.ts']
    await $.session.start(start)
    const ok = await bash($, `/r/otherapp/scripts/dev/omdl-launch.sh s1 lead/integ docs/b.md`)
    expect(String(ok.deny ?? '')).not.toContain('不存在')
    const red = await bash($, `/r/otherapp/scripts/dev/omdl-launch.sh s2 main docs/b.md`)
    expect(String(red.deny ?? '')).toContain('src/b.ts')
  })

  test('24.10: cd 进别的仓再用相对路径起片 → 任务书按那个仓解析', async ($, on) => {
    const cfg = JSON.stringify({ launch: 'scripts/dev/omdl-launch.sh' })
    await world(on, { files: { [`${CWD}/.claude/delegate.json`]: cfg, '/r/otherapp/docs/b.md': GOOD_BRIEF, '/r/otherapp/src/a.ts': '', '/r/otherapp/src/b.ts': '' } })
    await $.session.start(start)
    const out = await bash($, `cd /r/otherapp && scripts/dev/omdl-launch.sh s1 main docs/b.md`)
    expect(String(out.deny ?? '')).not.toContain('读不到任务书')
  })

  test('GWT-8: overlapping 允许改动 with a running run is refused, naming the path', async ($, on) => {
    const { w } = await world(on, { runs: [run({ label: 'busy', allowed: ['src/a.ts', 'lib/'] })] })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toContain('src/a.ts')
    expect(out.deny).toContain('busy')
    expect(w.bash.length).toBe(0)
  })

  // D1(18.10):间隔不足不再拒起 —— 命令前面补一段等待,照常放行。18.10 的四条误判是「只认命令位」的另一半,见
  // 「delegate: command parsing」里那组夹具;这里钉的是间隔这一半:差额补 `sleep N; `,lastLaunchAt 记成 now + N。
  test('GWT-9: a launch 30 s after the last is not refused at the configured 60 s spacing: the command waits out the rest', { options: { launchSpacingSeconds: 60 } }, async ($, on) => {
    const { w } = await world(on, {}, { lastLaunchAt: T0 - 30_000 })
    await $.session.start(start)
    expect((await bash($, launch())).deny).toBeUndefined()
    expect(w.bash[0]).toMatch(/^sleep 30; /)
  })

  test('spacing: the default 10 s lets a launch 30 s later through untouched; a later one waits 5 s instead of being refused', async ($, on) => {
    const store = new Map<string, unknown>([['lastLaunchAt', T0 - 30_000]])
    const { w, clock } = await world(on, {}, store)
    await $.session.start(start)
    expect((await bash($, launch())).deny).toBeUndefined()
    expect(w.bash[0]).not.toContain('sleep ')
    expect(store.get('lastLaunchAt')).toBe(T0)
    await clock.advance(5_000)
    const again = await bash($, launch('r10'))
    expect(again.deny).toBeUndefined()
    expect(w.bash[1]).toMatch(/^sleep 5; /)
    expect(store.get('lastLaunchAt')).toBe(T0 + 10_000)
  })

  test('one command starting several runs is still refused (GWT-9 那条不变)', async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    const two = `cd ${CWD} && omd-lite run --repo ${CWD} --base main --spec docs/b.md --name a & omd-lite run --repo ${CWD} --base main --spec docs/b.md --name b`
    expect((await bash($, two)).deny).toContain('一条命令起了 2 个 run')
    expect(w.bash.length).toBe(0)
  })

  test('GWT-13: omdl-* over the 40 GB budget is refused, pointing at gc', async ($, on) => {
    const { w } = await world(on, { usedKB: 41 * 1048576 })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toContain('gc')
    expect(out.deny).toContain('41.0 GB')
    expect(w.bash.length).toBe(0)
  })

  test('disk: free space under minFreeGB is refused', async ($, on) => {
    await world(on, { freeKB: 20 * 1048576 })
    await $.session.start(start)
    expect((await bash($, launch())).deny).toContain('盘余 20.0 GB')
  })

  test('no concurrency cap (D-16): twelve running runs do not block a launch', async ($, on) => {
    const runs = Array.from({ length: 12 }, (_, k) => run({ label: `busy${k}`, allowed: [`other/${k}.ts`] }))
    const { w } = await world(on, { runs })
    await $.session.start(start)
    expect((await bash($, launch())).deny).toBeUndefined()
    expect(w.bash.length).toBe(1)
  })

  test('a command that launches nothing passes untouched', async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    await bash($, 'ls -la && cat ~/.omd-lite/runs/r1/result.json')
    expect(w.bash).toEqual(['ls -la && cat ~/.omd-lite/runs/r1/result.json'])
  })

  // 18.10 的实况:delegate 自己写任务书(`cat > docs/x.md <<'EOF'` 里带着起片 / 合并示例)时把自己拦了。
  test('18.10: a brief that quotes a launch and a merge goes through untouched', async ($, on) => {
    const cfg = JSON.stringify({ launch: 'scripts/dev/omdl-launch.sh', merge: 'scripts/dev/omdl-merge.sh' })
    const { w } = await world(on, { files: { [`${CWD}/.claude/delegate.json`]: cfg } })
    await $.session.start(start)
    const cmd = `cat > docs/x.md <<'EOF'\n起片示例:B=abc; piw run --spec s.md --gate "x" --name x\nEOF\ngit add docs/x.md`
    expect((await bash($, cmd)).deny).toBeUndefined()
    expect(w.bash).toEqual([cmd])
  })
})

describe('delegate: the session id follows /clear (G-1)', () => {
  test('classic.SessionStart(source clear): scans under the new id and the old one, the wake book moves, a run ending after the clear still wakes', async ($, on) => {
    const store = new Map<string, unknown>()
    const { w, clock } = await world(on, { runs: [run({ label: 'before' })] }, store)
    on('classic.SessionStart', () => ({}) as never)
    await $.session.start(start)
    expect(scanIds(w)).toBe('S1')
    expect((store.get('wake:S1') as { known: Record<string, string> }).known).toEqual({ before: 'running' })

    w.sid = 'S2'
    w.runs = [run({ label: 'before' }), run({ label: 'after', allowed: ['z/'] })]
    await $.classic.SessionStart(sessionStart('clear', 'S2'))
    await clock.advance(2_000)
    expect(scanIds(w)).toBe('S2,S1')
    expect(store.get('wake:S1')).toBeUndefined()
    const moved = store.get('wake:S2') as { known: Record<string, string>; prior: string[] }
    expect(moved.known.before).toBe('running')
    expect(moved.prior).toEqual(['S1'])

    w.runs = [run({ label: 'before', state: 'pass' }), run({ label: 'after', state: 'pass' })]
    await clock.advance(2_000)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]).toContain('- before · pass')
    expect(w.submits[0]).toContain('- after · pass')
  })

  test('session.end(reason clear) moves the book too, before any scan sees the new id', async ($, on) => {
    const store = new Map<string, unknown>()
    const { w, clock } = await world(on, { runs: [run({ label: 'before' })] }, store)
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    await $.session.start(start)
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } } as never)
    w.sid = 'S2'
    await clock.advance(2_000)
    expect(scanIds(w)).toBe('S2,S1')
    expect(store.get('wake:S1')).toBeUndefined()
    expect((store.get('wake:S2') as { known: Record<string, string> }).known).toEqual({ before: 'running' })
  })

  test('no hook fired at all: a scan still reads the current id, so a run launched after the clear is found', async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    w.sid = 'S2'
    const out = await bash($, launch())
    expect(out.deny).toBeUndefined()
    expect(scanIds(w)).toBe('S2')
    expect(w.bash.length).toBe(1)
  })

  test('an id that changed without a clear (another conversation) starts a new lineage and keeps the old one out', async ($, on) => {
    const { w, clock } = await world(on, { runs: [run()] })
    await $.session.start(start)
    w.sid = 'S9'
    await clock.advance(2_000)
    expect(scanIds(w)).toBe('S9')
  })

  test('the lineage survives a reload: it is read back from the wake book', async ($, on) => {
    const book = { known: {}, pending: [], at: T0, prior: ['S0'] }
    const { w } = await world(on, { sid: 'S1' }, { 'wake:S1': book })
    await $.session.start(start)
    expect(scanIds(w)).toBe('S1,S0')
  })
})

describe('delegate: the executor must exist (G-2)', () => {
  test('mcode missing: denied, naming the executor and the way out; nothing runs', async ($, on) => {
    const { w } = await world(on, { missing: ['mcode'] })
    await $.session.start(start)
    const out = await bash($, launch('e1', ' --executor mcode'))
    expect(out.deny).toContain('执行器 mcode 不在')
    expect(out.deny).toContain('--executor')
    expect(w.bash.length).toBe(0)
  })

  test('the default executor is pi: pi missing is denied, mcode missing does not matter', async ($, on) => {
    const { w } = await world(on, { missing: ['pi'] })
    await $.session.start(start)
    expect((await bash($, launch('e2'))).deny).toContain('执行器 pi 不在')
    w.missing = ['mcode']
    expect((await bash($, launch('e3'))).deny).toBeUndefined()
  })

  test('the repo config names the executor when the command does not', async ($, on) => {
    const { w } = await world(on, { missing: ['mcode'], files: { [`${CWD}/.claude/delegate.json`]: JSON.stringify({ executor: 'mcode' }), [`${CWD}/docs/b.md`]: GOOD_BRIEF, [`${CWD}/src/a.ts`]: '', [`${CWD}/src/b.ts`]: '' } })
    await $.session.start(start)
    expect((await bash($, launch('e4'))).deny).toContain('执行器 mcode 不在')
    expect(w.bash.length).toBe(0)
  })

  test('the check asks command -v of that binary (and, for pi, where piw finds it)', async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    await bash($, launch('e5', ' --executor claude'))
    const probe = w.argv.find(a => a[0] === 'sh' && String(a[2]).includes('command -v'))
    expect(probe?.[4]).toBe('claude')
    expect(String(probe?.[2])).toContain('aliases/default/bin/pi')
  })

  test('an executor omd-lite does not spawn by name is not ours to check', async ($, on) => {
    const { w } = await world(on, { missing: ['exotic'] })
    await $.session.start(start)
    expect((await bash($, launch('e6', ' --executor exotic'))).deny).toBeUndefined()
    expect(w.argv.some(a => a[0] === 'sh' && String(a[2]).includes('command -v'))).toBe(false)
  })

  test('a dry run does not look for the executor', async ($, on) => {
    const { w } = await world(on, { missing: ['pi'] })
    await $.session.start(start)
    expect((await bash($, 'omd-lite run --dry-run --role worker --name d1')).deny).toBeUndefined()
    expect(w.bash.length).toBe(1)
  })
})

describe('delegate: a launch is detached from the session (G-8, D-SPAWN)', () => {
  const BARE = `cd ${CWD} && omd-lite run --repo ${CWD} --base main --spec docs/b.md --model m --prompt omd-leaf --gate "true" --name g8`

  test('no setsid / nohup: rewritten to setsid -f with stdin, stdout and stderr off the hook, the log dir made first', async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    const out = await bash($, `${BARE} &`)
    expect(out.deny).toBeUndefined()
    expect(w.argv).toContainEqual(['mkdir', '-p', '/home/t/.omd-lite/launch'])
    const ran = w.bash[0] ?? ''
    expect(ran).toContain(`&& setsid -f omd-lite run `)
    expect(ran).toMatch(/--name g8 <\/dev\/null >>\/home\/t\/\.omd-lite\/launch\/g8\.log 2>&1 &$/)
    // the gate is not wrapped
    expect(ran).not.toContain('gate-slot')
  })

  test('already nohup / setsid: not touched', async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    await bash($, `nohup ${BARE.replace(`cd ${CWD} && `, '')} > /tmp/g8.log 2>&1 &`)
    await bash($, `setsid ${BARE.replace(`cd ${CWD} && `, '')} &`)
    for (const ran of w.bash) {
      expect(ran).not.toContain('setsid -f')
      expect(ran).not.toContain('.omd-lite/launch')
    }
    expect(w.argv.some(a => a[0] === 'mkdir')).toBe(false)
  })

  test('the command already redirects: only the missing descriptors are added, after its own redirections', async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    await bash($, `${BARE} > /tmp/mine.log 2>&1 &`)
    const ran = w.bash[0] ?? ''
    expect(ran).toContain('setsid -f omd-lite run')
    expect(ran).toMatch(/--name g8 > \/tmp\/mine\.log 2>&1 <\/dev\/null &$/)
    expect(ran).not.toContain('.omd-lite/launch/g8.log')
  })

  test('a wrapper before the head (vt): setsid -f goes before the wrapper, so the run is not left on a pty that hangs up', async ($, on) => {
    // 15.10:`vt piw run … > log` 被改成 `vt setsid -f piw run …`,vt 一退 PTY 挂断,piw 收 SIGHUP、写 stdout 得 EIO,
    // otherapp 三片起来几秒就死(docs/investigations/2026-10-15-vt-setsid-hup.md)。
    const { w } = await world(on)
    await $.session.start(start)
    await bash($, `cd ${CWD} && vt omd-lite run --repo ${CWD} --base main --spec docs/b.md --model m --prompt omd-leaf --gate "true" --name g8 > /tmp/g8.log 2>&1`)
    const ran = w.bash[0] ?? ''
    expect(ran).toContain(`&& setsid -f vt omd-lite run `)
    expect(ran).not.toContain('vt setsid')
    // an assignment prefix stays in front of setsid (setsid would try to exec `X=1`)
    const assign = `cd ${CWD} && X=1 omd-lite run --repo ${CWD} --base main --spec docs/b.md --model m --prompt omd-leaf --gate "true" --name g9 &`
    expect(rewriteLaunches(assign, findLaunches(assign), {}, { logDir: '/l' })).toContain('&& X=1 setsid -f omd-lite run ')
  })

  test('the env file prefix still comes after setsid -f; rewriting twice changes nothing more', async ($, on) => {
    const cfg = JSON.stringify({ envFile: '/e/.env' })
    const { w } = await world(on, { files: { [`${CWD}/.claude/delegate.json`]: cfg, [`${CWD}/docs/b.md`]: GOOD_BRIEF, [`${CWD}/src/a.ts`]: '', [`${CWD}/src/b.ts`]: '' } })
    await $.session.start(start)
    await bash($, BARE)
    const ran = w.bash[0] ?? ''
    expect(ran).toContain('setsid -f env OMD_LITE_ENV_FILE=/e/.env omd-lite run')
    const again = rewriteLaunches(ran, findLaunches(ran), {}, { logDir: '/home/t/.omd-lite/launch' })
    expect(again).toBe(ran)
  })

  test('a piped launch cannot be detached: left alone', () => {
    const cmd = 'omd-lite run --spec s.md --name p1 2>&1 | tee /tmp/p1.log'
    const ls = findLaunches(cmd)
    expect(ls[0]?.isPiped).toBe(true)
    expect(rewriteLaunches(cmd, ls, {}, { logDir: '/l' })).toBe(cmd)
  })

  test('pure: rewrite shapes', () => {
    const rw = (cmd: string) => rewriteLaunches(cmd, findLaunches(cmd), {}, { logDir: '/l' })
    expect(rw('omd-lite run --spec s.md --name n1')).toBe('setsid -f omd-lite run --spec s.md --name n1 </dev/null >>/l/n1.log 2>&1')
    expect(rw('A=1 omd-lite run --spec s.md --name n1 &')).toBe('A=1 setsid -f omd-lite run --spec s.md --name n1 </dev/null >>/l/n1.log 2>&1 &')
    expect(rw('omd-lite run --spec s.md --name n1 </dev/null >/x 2>/y')).toBe('setsid -f omd-lite run --spec s.md --name n1 </dev/null >/x 2>/y')
    expect(rw('omd-lite run --spec s.md --name n1 &> /x')).toBe('setsid -f omd-lite run --spec s.md --name n1 &> /x </dev/null')
    expect(rw('piw run --spec s.md --name n1; echo $?')).toBe('setsid -f piw run --spec s.md --name n1 </dev/null >>/l/n1.log 2>&1; echo $?')
    expect(rw('omd-lite run --spec s.md --name ../evil')).toBe('omd-lite run --spec s.md --name ../evil')
  })
})

// G-3: runs that died with no result, offered above the prompt; a press takes one up again in its own worktree.
describe('delegate: dead runs can be taken up again (G-3, Q12)', () => {
  const dead = (over: Partial<Orphan> = {}): Orphan => ({
    label: 'dead1', repo: CWD, base: 'abc123', worktree: '/r/omdl-dead1', branch: 'omdl/dead1', spec: 'docs/b.md', prompt: 'omd-leaf',
    gates: [`true`], maxRounds: 3, role: 'worker', context: true, startedAt: T0 - 3_600_000, ...over,
  })
  const BAND = { component: 'AbovePrompt' as const, props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never }
  const engine = (on: On) => {
    on('ui.render', async ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, { key: 'engine' }) as never })
  }

  test('session.start asks the scanner for every session\'s dead runs; the band names them with a resume button each', async ($, on) => {
    const { w } = await world(on, { orphans: [dead(), dead({ label: 'dead2', spec: 'docs/c.md' })] })
    engine(on)
    await $.session.start(start)
    expect(w.argv.some(a => String(a[1]).endsWith('/bin/scan.mjs') && a[2] === '--orphans')).toBe(true)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'delegate', surface, ...BAND })
      expect(await ui.find({ key: 'resume-dead1' })).toBeDefined()
      expect(await ui.find({ key: 'resume-dead2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /2 个 run 断了/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('no dead runs, a failed scan, or a survey on screen: no band', async ($, on) => {
    const { w } = await world(on, { orphans: [] })
    engine(on)
    await $.session.start(start)
    const ui = await $.ui.mount({ plugin: 'delegate', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 'delegate-orphans' })).toBeUndefined()
    await ui.unmount()

    w.orphans = [dead()]
    await $.session.start(start)
    const quiet = await $.ui.mount({ plugin: 'delegate', surface: 'terminal', component: 'AbovePrompt', props: { ...(BAND.props as object), hasSurvey: true } as never })
    expect(await quiet.find({ key: 'delegate-orphans' })).toBeUndefined()
    await quiet.unmount()
  })

  test('press: process.run is the D-SPAWN shape with --reuse-worktree <old worktree> --name <label>-r2; the band drops that run', async ($, on) => {
    const { w } = await world(on, { orphans: [dead()] })
    engine(on)
    await $.session.start(start)
    const ui = await $.ui.mount({ plugin: 'delegate', surface: 'terminal', ...BAND })
    const before = w.argv.length
    await ui.press({ key: 'resume-dead1' })

    const at = w.argv.slice(before).findIndex(a => a[0] === 'sh' && String(a[2]).includes('setsid -f'))
    expect(at).toBeGreaterThanOrEqual(0)
    const argv = w.argv[before + at] as string[]
    // sh -c '<mkdir && setsid -f "$@" </dev/null >>"$LOG" 2>&1' _ <cli> run …
    const script = String(argv[2])
    expect(script).toContain('setsid -f "$@"')
    expect(script).toContain('</dev/null')
    expect(script).toContain('>>"$LOG"')
    expect(script).toContain('2>&1')
    expect(argv[3]).toBe('_')
    expect(argv[4]).toBe('/home/user/repos/omd-lite/bin/omd-lite')
    expect(argv[5]).toBe('run')
    const rest = argv.slice(5)
    const flag = (name: string) => rest[rest.indexOf(name) + 1]
    expect(flag('--reuse-worktree')).toBe('/r/omdl-dead1')
    expect(flag('--name')).toBe('dead1-r2')
    expect(flag('--spec')).toBe('docs/b.md')
    expect(flag('--base')).toBe('abc123')
    expect(flag('--role')).toBe('worker')
    expect(flag('--gate')).toBe(`true`)
    expect(rest).not.toContain('--model')
    // the log goes beside runs/ and the new run files itself under this conversation
    expect(w.envs[before + at]?.LOG).toBe('/home/t/.omd-lite/launch/dead1-r2.log')
    expect(w.envs[before + at]?.CLAUDE_CODE_SESSION_ID).toBe('S1')
    expect(w.toasts.join('\n')).toContain('dead1-r2')
    // The list is a PluginState atom, so the mounted band redraws without the run at once.
    expect(await ui.find({ key: 'resume-dead1' })).toBeUndefined()
    await ui.unmount()
  })

  test('a resume counts as a launch for the spacing: the next launch waits out the rest of it (D1)', async ($, on) => {
    const { w } = await world(on, { orphans: [dead()] })
    engine(on)
    await $.session.start(start)
    const ui = await $.ui.mount({ plugin: 'delegate', surface: 'terminal', ...BAND })
    await ui.press({ key: 'resume-dead1' })
    await ui.unmount()
    expect((await bash($, launch('after'))).deny).toBeUndefined()
    expect(w.bash[0]).toMatch(/^sleep 10; /)
  })

  test('a run that left too little to start from is not started; the person is told', async ($, on) => {
    const { w } = await world(on, { orphans: [dead({ gates: [] })] })
    engine(on)
    await $.session.start(start)
    const ui = await $.ui.mount({ plugin: 'delegate', surface: 'terminal', ...BAND })
    const before = w.argv.length
    await ui.press({ key: 'resume-dead1' })
    expect(w.argv.length).toBe(before)
    expect(w.toasts.join('\n')).toContain('信息不够续跑')
    await ui.unmount()
  })

  test('a start that fails is reported with its stderr', async ($, on) => {
    const { w } = await world(on, { orphans: [dead()], detachFails: 'boom' })
    engine(on)
    await $.session.start(start)
    const ui = await $.ui.mount({ plugin: 'delegate', surface: 'terminal', ...BAND })
    await ui.press({ key: 'resume-dead1' })
    expect(w.toasts.join('\n')).toContain('续跑没起来(exit 1):boom')
    expect((await bash($, launch('after'))).deny).toBeUndefined()
    await ui.unmount()
  })

  test('dismiss clears the band for this session', async ($, on) => {
    await world(on, { orphans: [dead()] })
    engine(on)
    await $.session.start(start)
    const ui = await $.ui.mount({ plugin: 'delegate', surface: 'terminal', ...BAND })
    await ui.press({ key: 'orphans-dismiss' })
    expect(await ui.find({ key: 'delegate-orphans' })).toBeUndefined()
    await ui.unmount()
  })

  test('pure: the resume argv keeps model / executor / no-context, and -r2 becomes -r3', () => {
    const o = dead({ role: undefined, model: 'deepseek/deepseek-v4-flash', executor: 'mcode', context: false })
    const a = resumeArgs(o) as string[]
    expect(a.slice(0, 1)).toEqual(['run'])
    expect(a).toContain('--no-context')
    expect(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2)).toEqual(['--model', 'deepseek/deepseek-v4-flash'])
    expect(a.slice(a.indexOf('--executor'), a.indexOf('--executor') + 2)).toEqual(['--executor', 'mcode'])
    expect(resumeArgs(dead({ role: undefined }))).toBeNull()
    expect(nextLabel('x')).toBe('x-r2')
    expect(nextLabel('x-r2')).toBe('x-r3')
    expect(nextLabel('x-r9')).toBe('x-r10')
    expect(detachedArgv(['a', 'b'])).toEqual(['sh', '-c', 'mkdir -p "${LOG%/*}" && setsid -f "$@" </dev/null >>"$LOG" 2>&1', '_', 'a', 'b'])
  })
})

describe('delegate: --dry-run is not a launch (owner 10.14)', () => {
  const DRY = [
    ['omd-lite', 'omd-lite run --dry-run --role worker --repo /r/myapp --base main --spec docs/ghost.md --gate "true" --name d1'],
    ['piw', 'piw run --role worker --repo /r/myapp --base main --spec docs/ghost.md --gate "true" --name d1 --dry-run'],
    ['absolute path, flag in the middle', '/home/user/repos/omd-lite/bin/omd-lite run --repo /r/myapp --dry-run --base main --name d1'],
  ] as const

  for (const [what, cmd] of DRY) {
    test(`${what}: passes untouched, with a bad brief, no spacing, a full disk and a running overlap`, async ($, on) => {
      const { w } = await world(on, { usedKB: 99 * 1048576, freeKB: 1 * 1048576, runs: [run({ allowed: ['docs/'] })] }, { lastLaunchAt: T0 })
      await $.session.start(start)
      const out = await bash($, cmd)
      expect(out.deny).toBeUndefined()
      expect(w.bash).toEqual([cmd])
      // nothing was measured for it: no disk probe, and it did not use up the launch spacing
      expect(w.argv.some(a => a[0] === 'sh')).toBe(false)
    })
  }

  test('a dry run does not start the launch spacing; the real launch right after is judged on its own', async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    await bash($, 'omd-lite run --dry-run --role worker --name d1')
    expect((await bash($, launch('r9'))).deny).toBeUndefined()
    expect(w.bash.length).toBe(2)
    expect(w.bash[1]).toContain('--gate ')
  })

  test('not a blanket pass: a real omd-lite run or piw run without --spec is still refused', async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    expect((await bash($, 'omd-lite run --role worker --name n1')).deny).toContain('没找到 --spec')
    expect((await bash($, 'piw run --role worker --name n2')).deny).toContain('没找到 --spec')
    expect(w.bash.length).toBe(0)
  })

  test('one command with a dry run and a real run: only the real one is judged', async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    const out = await bash($, 'omd-lite run --dry-run --name d1 && omd-lite run --role worker --name n1')
    expect(out.deny).toContain('n1:没找到 --spec')
    expect(out.deny).not.toContain('d1')
    expect(w.bash.length).toBe(0)
  })

  test('parsing: --dry-run is a switch, it does not take the next word as its value', () => {
    const [l] = findLaunches('omd-lite run --dry-run --spec docs/b.md --name n1')
    expect(l?.dryRun).toBe(true)
    expect(l?.spec).toBe('docs/b.md')
    expect(l?.name).toBe('n1')
    expect(findLaunches('piw run --spec docs/b.md --name n1')[0]?.dryRun).toBe(false)
  })

  test('when the guard itself fails, a dry run is not refused either', () => {
    expect(looksLikeLaunch('omd-lite run --dry-run --role worker --name d1')).toBe(false)
    expect(looksLikeLaunch('piw run --dry-run --name d1')).toBe(false)
    expect(looksLikeLaunch('omd-lite run --spec s.md --name n')).toBe(true)
    expect(looksLikeLaunch('piw run --spec s.md --name n')).toBe(true)
    // 15.10:只读命令里出现 omdl-launch 字样不算启动
    expect(looksLikeLaunch('cat /home/user/repos/myapp/scripts/dev/omdl-launch.sh')).toBe(false)
    expect(looksLikeLaunch('rg -n spec scripts/dev/*launch* scripts/dev/omdl-launch.sh | head')).toBe(false)
    expect(looksLikeLaunch('sed -n 1,20p scripts/dev/omdl-launch.sh')).toBe(false)
    expect(looksLikeLaunch('scripts/dev/omdl-launch.sh --name x docs/b.md')).toBe(true)
    expect(looksLikeLaunch('cd /r && bash scripts/dev/omdl-launch.sh x b.md')).toBe(true)
    expect(looksLikeLaunch('ls')).toBe(false)
  })
})

describe('delegate: a provider failure is redispatched once (G-4)', () => {
  const COORDS = ['minimax-cp/MiniMax-M3.1-Flash-Preview', 'deepseek/deepseek-v4']
  const launchInfo = { repo: CWD, base: 'abc123', worktree: '/r/omdl-f1', branch: 'omdl/f1', spec: 'docs/b.md', prompt: 'omd-leaf', gates: [`true`], maxRounds: 3, role: 'worker', context: true, claudeSession: 'S1' }
  const live = (label = 'f1', over: Partial<ScanRun> = {}) => run({ label, runDir: `/home/t/.omd-lite/runs/${label}`, claudeSession: 'S1', allowed: null, ...over })
  const failed = (label = 'f1', piwFailure: string | null = 'quota', over: Partial<ScanRun> = {}) =>
    live(label, {
      state: 'not-run', endedAt: T0 - 5_000, wallSeconds: 55, failureClass: 'provider', error: '429', gateTail: ['GATE-LOG-LINE'],
      ...(piwFailure ? { piwFailure, failedCoords: COORDS, launch: launchInfo } : {}),
      ...over,
    })
  const detaches = (w: World) => w.argv.map((a, i) => ({ a, i })).filter(({ a }) => a[0] === 'sh' && String(a[2]).includes('setsid -f') && !String(a[2]).includes('command -v'))
  const locks = (w: World) => w.argv.filter(a => a[0] === 'mkdir' && String(a[1]).endsWith('.redispatch.lock'))
  /** Starts a session with `label` running, then lets `ended` replace it and polls. */
  async function ends(on: On, $: Engine, ended: ScanRun[], over: Partial<World> = {}) {
    const { w, clock } = await world(on, { runs: [live(ended[0]?.label ?? 'f1')], ...over })
    await $.session.start(start)
    w.runs = ended
    await clock.advance(2_000)
    return { w, clock }
  }

  for (const cls of ['quota', 'stream']) {
    test(`${cls}: exactly one redispatch, D-SPAWN shape with --role worker --skip-coord for every failed coordinate; the lead is not woken`, async ($, on) => {
      const { w, clock } = await ends(on, $, [failed('f1', cls)])
      expect(locks(w)).toEqual([['mkdir', '/home/t/.omd-lite/runs/f1/.redispatch.lock']])
      const hits = detaches(w)
      expect(hits.length).toBe(1)
      const { a: argv, i } = hits[0] as { a: string[]; i: number }
      const script = String(argv[2])
      expect(script).toContain('setsid -f "$@"')
      expect(script).toContain('</dev/null')
      expect(script).toContain('>>"$LOG"')
      expect(script).toContain('2>&1')
      expect(argv[3]).toBe('_')
      expect(argv[4]).toBe('/home/user/repos/omd-lite/bin/omd-lite')
      expect(argv[5]).toBe('run')
      const rest = argv.slice(5)
      const flag = (name: string) => rest[rest.indexOf(name) + 1]
      expect(flag('--role')).toBe('worker')
      expect(rest.flatMap((x, k) => (x === '--skip-coord' ? [rest[k + 1]] : []))).toEqual(COORDS)
      expect(flag('--name')).toBe('f1-p2')
      expect(flag('--spec')).toBe('docs/b.md')
      expect(flag('--base')).toBe('abc123')
      expect(flag('--gate')).toBe(`true`)
      expect(rest).not.toContain('--reuse-worktree') // a new worktree, not the failed one
      expect(rest).not.toContain('--model')
      expect(w.envs[i]?.LOG).toBe('/home/t/.omd-lite/launch/f1-p2.log')
      expect(w.envs[i]?.CLAUDE_CODE_SESSION_ID).toBe('S1')
      expect(w.toasts.join('\n')).toContain('f1-p2')
      // the chain is not used up: no wake for f1, however long we wait
      await clock.advance(120_000)
      expect(w.submits.length).toBe(0)
      // polling on does not dispatch again
      expect(detaches(w).length).toBe(1)
      expect(locks(w).length).toBe(1)
    })
  }

  test('the redispatch ends well: the lead hears about f1-p2 only', async ($, on) => {
    const { w, clock } = await ends(on, $, [failed('f1')])
    w.runs = [failed('f1'), live('f1-p2')]
    await clock.advance(10_000)
    w.runs = [failed('f1'), live('f1-p2', { state: 'pass', endedAt: T0 + 20_000 })]
    await clock.advance(10_000)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]).toContain('- f1-p2 · pass')
    expect(w.submits[0]).not.toContain('- f1 ·')
    expect(detaches(w).length).toBe(1)
  })

  for (const cls of ['gate', 'request', 'auth']) {
    test(`${cls}: not redispatched, the lead is woken`, async ($, on) => {
      // a gate failure carries the class and no launch recipe; make the fixture as dangerous as it can be
      const { w } = await ends(on, $, [failed('f1', cls, { launch: launchInfo, failedCoords: COORDS, failureClass: cls === 'gate' ? 'gate' : 'provider' })])
      expect(locks(w).length).toBe(0)
      expect(detaches(w).length).toBe(0)
      expect(w.submits.length).toBe(1)
      expect(w.submits[0]).toContain('f1')
    })
  }

  test('a scope violation or a stuck gate is a gate failure even when the class slipped through: not redispatched', async ($, on) => {
    const { w } = await ends(on, $, [failed('f1', 'quota', { outside: ['src/x.ts'] }), failed('f2', 'stream', { stuck: 'same failure twice' })])
    expect(detaches(w).length).toBe(0)
    expect(locks(w).length).toBe(0)
  })

  test('no failure class at all (an old piw): not redispatched', async ($, on) => {
    const { w } = await ends(on, $, [failed('f1', null)])
    expect(detaches(w).length).toBe(0)
    expect(w.submits.length).toBe(1)
  })

  test('the second failure of a label: no more redispatch, the lead is woken and told it was already tried', async ($, on) => {
    const { w, clock } = await ends(on, $, [failed('f1')])
    w.runs = [failed('f1'), live('f1-p2')]
    await clock.advance(10_000)
    w.runs = [failed('f1'), failed('f1-p2', 'quota', { launch: { ...launchInfo, worktree: '/r/omdl-f1-p2' } })]
    await clock.advance(10_000)
    expect(detaches(w).length).toBe(1) // only the first
    expect(locks(w).length).toBe(1)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]).toContain('- f1-p2 · not-run')
    expect(w.submits[0]).toContain('不再自动重派')
    expect(w.submits[0]).not.toContain('GATE-LOG-LINE')
  })

  test('a resumed redispatch (f1-p2-r2) that fails is not redispatched either', () => {
    expect(redispatchVerdict(failed('f1-p2-r2')).ok).toBe(false)
    expect(redispatchVerdict(failed('f1-r2')).ok).toBe(true)
  })

  // 30.10:agent-internal-signup-review-sol 被停后冒出 -p2,--role worker 落到 deepseek,判词照叫 .sol.md(6 份都这样,一份被合并当成 MiniMax 用了)
  test('a review run (label has -review-) is never redispatched: another family under the same name is not the same review', () => {
    for (const label of ['agent-internal-signup-review-sol', 'agent-rc-v1-fix-r-review-minimax', 'agent-law-s9-fix-review-sol-2', 'agent-x-review-gemini-3'])
      expect(redispatchVerdict(failed(label))).toEqual({ ok: false, why: '审查不跨家族重派' })
    expect(redispatchVerdict(failed('agent-review-leak-own-tasks')).ok).toBe(true)
  })

  test('the lock is held (mkdir exits non-zero): nothing is dispatched, and the lead is not told twice', async ($, on) => {
    const { w, clock } = await ends(on, $, [failed('f1')], { lockHeld: true })
    expect(locks(w).length).toBe(1)
    expect(detaches(w).length).toBe(0)
    await clock.advance(120_000)
    expect(locks(w).length).toBe(1) // not tried again every poll
    expect(detaches(w).length).toBe(0)
    expect(w.submits.length).toBe(0)
  })

  test('the -p2 run is already in the scan (an earlier load dispatched it): the lock is not even tried', async ($, on) => {
    const { w } = await ends(on, $, [failed('f1'), live('f1-p2')])
    expect(locks(w).length).toBe(0)
    expect(detaches(w).length).toBe(0)
  })

  test('the run was launched from another session: not dispatched, no lock', async ($, on) => {
    const { w } = await ends(on, $, [failed('f1', 'quota', { claudeSession: 'OTHER' })])
    expect(locks(w).length).toBe(0)
    expect(detaches(w).length).toBe(0)
    expect(w.submits.length).toBe(1) // the scan said it is ours to hear about; dispatching is for the launching session
  })

  test('a run launched before a /clear is still this conversation\'s: dispatched, filed under the new session', async ($, on) => {
    const { w, clock } = await world(on, { runs: [live('f1', { claudeSession: 'S1' })] })
    on('classic.SessionStart', () => ({}) as never)
    await $.session.start(start)
    w.sid = 'S2'
    await $.classic.SessionStart(sessionStart('clear', 'S2'))
    w.runs = [failed('f1', 'quota', { claudeSession: 'S1' })]
    await clock.advance(2_000)
    expect(detaches(w).length).toBe(1)
    expect(w.envs[detaches(w)[0]?.i ?? 0]?.CLAUDE_CODE_SESSION_ID).toBe('S2')
  })

  test('redispatch:false: nothing is dispatched, the lead is woken as before', { options: { redispatch: false } }, async ($, on) => {
    const { w } = await ends(on, $, [failed('f1')])
    expect(locks(w).length).toBe(0)
    expect(detaches(w).length).toBe(0)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]).toContain('换 provider')
  })

  test('a failure that ended long ago (a reload finding old news) is not redispatched', async ($, on) => {
    const { w } = await ends(on, $, [failed('f1', 'quota', { endedAt: T0 - 3 * 3600 * 1000 })])
    expect(locks(w).length).toBe(0)
    expect(detaches(w).length).toBe(0)
  })

  test('already failed when the session starts: baseline only, nothing dispatched', async ($, on) => {
    const { w } = await world(on, { runs: [failed('f1')] })
    await $.session.start(start)
    expect(locks(w).length).toBe(0)
    expect(detaches(w).length).toBe(0)
  })

  test('the start itself fails: the lead is woken and told why; the lock stays, so it is not tried again', async ($, on) => {
    const { w, clock } = await ends(on, $, [failed('f1')], { detachFails: 'setsid: not found' })
    expect(w.toasts.join('\n')).toContain('没起来')
    expect(w.submits.length).toBe(1)
    await clock.advance(60_000)
    expect(locks(w).length).toBe(1)
  })

  test('a redispatch counts as a launch for the spacing: the next launch waits out the rest of it (D1)', async ($, on) => {
    const { w } = await ends(on, $, [failed('f1')])
    expect((await bash($, launch('after'))).deny).toBeUndefined()
    expect(w.bash[0]).toMatch(/^sleep 10; /)
  })

  test('pure: the argv carries max rounds and no-context, and refuses a run with nothing to skip or too little to start from', () => {
    const r = failed('f1', 'quota', { launch: { ...launchInfo, context: false } })
    const args = redispatchArgs(r) as string[]
    expect(args.slice(0, 1)).toEqual(['run'])
    expect(args).toContain('--no-context')
    expect(args[args.indexOf('--max-rounds') + 1]).toBe('3')
    expect(args.at(-2)).toBe('--name')
    expect(args.at(-1)).toBe('f1-p2')
    expect(redispatchArgs({ ...r, failedCoords: [] })).toBeNull()
    expect(redispatchArgs({ ...r, launch: { ...launchInfo, gates: [] } })).toBeNull()
    expect(redispatchVerdict({ ...r, failedCoords: [] }).ok).toBe(false)
    expect(redispatchVerdict({ ...r, state: 'pass' }).ok).toBe(false)
    expect(redispatchVerdict({ ...r, state: 'running' }).ok).toBe(false)
  })
})

describe('delegate: the wake (GWT-15, GWT-10)', () => {
  test('GWT-15: five runs ending within 30 s make one prompt listing all five', async ($, on) => {
    const labels = ['a1', 'a2', 'a3', 'a4', 'a5']
    const runs = [...labels, 'long'].map(label => run({ label, allowed: null }))
    const { w, clock } = await world(on, { runs })
    await $.session.start(start)
    for (const [k, label] of labels.entries()) {
      w.runs = w.runs.map(r => (r.label === label ? { ...r, state: 'pass', diffstat: `${k + 1} files changed` } : r))
      await clock.advance(6_000)
    }
    expect(w.submits.length).toBe(0) // `long` still runs: the window stays open
    await clock.advance(60_000)
    expect(w.submits.length).toBe(1)
    for (const label of labels) expect(w.submits[0]).toContain(`- ${label} · pass`)
    expect(w.submits[0]).not.toContain('- long')
    await clock.advance(120_000)
    expect(w.submits.length).toBe(1)
  })

  test('the last run ending wakes at once, with round, diffstat, outside and the gate log tail', async ($, on) => {
    const { w, clock } = await world(on, { runs: [run({ label: 'g1' })] })
    await $.session.start(start)
    w.runs = [run({
      label: 'g1', state: 'fail', round: 3, failureClass: 'gate', diffstat: '2 files changed, 3 insertions(+)',
      outside: ['src/x.ts'], failedGate: 'npx tsc', gateTail: ['### $ npx tsc', 'error TS2322: nope', '### exit=1'],
    })]
    await clock.advance(2_000)
    expect(w.submits.length).toBe(1)
    const text = w.submits[0] ?? ''
    expect(text).toContain('g1 · fail · 第 3/4 轮 · gate')
    expect(text).toContain('2 files changed, 3 insertions(+)')
    expect(text).toContain('越界:src/x.ts')
    expect(text).toContain('error TS2322: nope')
  })

  test('GWT-10: a provider failure says 换 provider and carries no gate log (INV-8)', async ($, on) => {
    const { w, clock } = await world(on, { runs: [run({ label: 'p1' })] })
    await $.session.start(start)
    w.runs = [run({
      label: 'p1', state: 'not-run', failureClass: 'provider', error: '529: overloaded',
      gateTail: ['### $ scripts/dev/gate-slice.sh main', 'GATE-LOG-LINE'],
    })]
    await clock.advance(2_000)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]).toContain('换 provider')
    expect(w.submits[0]).toContain('不要回灌给执行方')
    expect(w.submits[0]).not.toContain('GATE-LOG-LINE')
  })

  test('runs already ended when the session starts do not wake it', async ($, on) => {
    const { w, clock } = await world(on, { runs: [run({ label: 'old', state: 'pass' })] })
    await $.session.start(start)
    await clock.advance(70_000)
    expect(w.submits.length).toBe(0)
  })
})

describe('delegate: after a merge (D-17 ②)', () => {
  test('git merge of omdl/<label> runs omd-lite clean for that run and tells the model', async ($, on) => {
    const { w } = await world(on)
    w.files['/home/t/.omd-lite/runs/m1/meta.json'] = JSON.stringify({ repo: CWD, worktree: '/r/omdl-m1', branch: 'omdl/m1' })
    w.files['/r/omdl-m1'] = ''
    await $.session.start(start)
    const out = await bash($, 'git merge --no-ff -q omdl/m1 -m "merge m1"')
    expect(w.argv.some(a => a[1] === 'clean' && a[2] === 'm1')).toBe(true)
    expect((out.context ?? []).join('\n')).toContain('omd-lite clean 删了 worktree /r/omdl-m1')
  })
})

describe('delegate: command parsing', () => {
  test('tokenize keeps quotes and spans; redirection targets are not words', () => {
    const t = tokenize(`a --gate "x y" 2>&1 > /tmp/l 'q'`)
    expect(t.filter(x => x.kind === 'word' && !x.isRedirTarget).map(x => x.value)).toEqual(['a', '--gate', 'x y', 'q'])
  })

  test('the repo launch script: positional name / base / spec / gates', () => {
    const cfg = { launch: 'scripts/dev/omdl-launch.sh' }
    const [l] = findLaunches(`nohup scripts/dev/omdl-launch.sh s1 main docs/b.md "npm run check:design" </dev/null &`, cfg)
    expect(l?.name).toBe('s1')
    expect(l?.spec).toBe('docs/b.md')
    expect(l?.gates.map(g => g.value)).toEqual(['npm run check:design'])
  })

  test('the repo launch script by absolute path: the repo is that script\'s repo root, not the session cwd', () => {
    const cfg = { launch: 'scripts/dev/omdl-launch.sh' }
    const [abs] = findLaunches(`/r/otherapp/scripts/dev/omdl-launch.sh s1 abc /r/otherapp/docs/b.md`, cfg)
    expect(abs?.repo).toBe('/r/otherapp')
    const [rel] = findLaunches(`scripts/dev/omdl-launch.sh s1 abc docs/b.md`, cfg)
    expect(rel?.repo).toBeUndefined()
    const [cd] = findLaunches(`cd /r/otherapp && scripts/dev/omdl-launch.sh s1 abc docs/b.md`, cfg)
    expect(cd?.repo).toBe('/r/otherapp')
  })

  test('rewrite: quoting survives, idempotent, config defaults filled', () => {
    const cmd = `omd-lite run --spec s.md --gate 'a "b" $X' --name n`
    const ls = findLaunches(cmd)
    const out = rewriteLaunches(cmd, ls, { executor: 'mcode', envFile: '/e/.env' })
    expect(out).toContain('env OMD_LITE_ENV_FILE=/e/.env omd-lite run --executor mcode')
    const again = findLaunches(out)
    expect(again[0]?.gates[0]?.value).toBe(`a "b" $X`)
    expect(out).toContain(`--gate 'a "b" $X'`)
    expect(rewriteLaunches(out, again)).toBe(out)
  })

  // D-11:闸不再包 gate-slot.sh,`--gate` 后面那个词原样留下,由起片 shell 照常展开。
  const rewritten = (cmd: string) => rewriteLaunches(cmd, findLaunches(cmd))

  test('D-11: every --gate is passed through byte for byte', () => {
    for (const g of [`"scripts/dev/gate-slice.sh $B"`, `'echo $HOME'`, `"true"`, `"scripts/dev/gate-slice.sh \${BASE:-main}"`, `"echo \\$HOME $B"`, `"a $(cat ver.txt) b"`, `"node -e 'x' $B"`]) {
      const cmd = `B=abc; omd-lite run --spec s.md --gate ${g} --name n`
      expect(rewritten(cmd)).toBe(cmd)
    }
  })

  test('D-11: the repo default gate is added bare, not wrapped', () => {
    expect(rewriteLaunches(`omd-lite run --spec s.md --name n`, findLaunches(`omd-lite run --spec s.md --name n`), { gate: 'scripts/dev/gate-slice.sh main' }))
      .toBe(`omd-lite run --gate 'scripts/dev/gate-slice.sh main' --spec s.md --name n`)
  })

  test('merges and overlap', () => {
    expect(findMerges('WAVE=W4 scripts/dev/omdl-merge.sh m2 "msg"', { merge: 'scripts/dev/omdl-merge.sh' })).toEqual(['m2'])
    expect(findMerges('git merge omdl/a omdl/b')).toEqual(['a', 'b'])
    expect(overlap(['src/'], ['src/a.ts', 'lib/x'])).toEqual(['src/a.ts'])
    expect(overlap(['./src/a.ts'], ['src/b.ts'])).toEqual([])
  })

  test('wake text without runs ended is still one block per run', () => {
    expect(wakeText([run({ state: 'pass' })]).split('\n- ').length).toBe(2)
  })

  // D1(18.10):delegate 把 `git diff` 里出现的合并脚本名、`cat > … <<EOF` 正文里的起片示例都当成了真的起片 / 合并。
  // 一条命令里只有落在命令位的词才算:`sed` / `cat` / `git diff` / `rg` 的参数不是命令;heredoc 正文不是命令。
  const SCRIPTS = { launch: 'scripts/dev/omdl-launch.sh', merge: 'scripts/dev/omdl-merge.sh' }

  test('18.10: a launch script that is only another command\'s argument is not a launch', () => {
    expect(findLaunches('sed -n 1,30p scripts/dev/omdl-launch.sh', SCRIPTS)).toEqual([])
    expect(looksLikeLaunch('sed -n 1,30p scripts/dev/omdl-launch.sh')).toBe(false)
    expect(findMerges('cat scripts/dev/omdl-merge.sh', SCRIPTS)).toEqual([])
  })

  // S11 的 lead 回合只从这里来:lead 在一个 run 上动一次手 = 一行 actor:lead 事件。合并脚本自己写 merge 事件，这里不重复。
  test('18.10: leadTouches names the runs a lead command acts on', () => {
    expect(leadTouches('scripts/dev/omdl-launch.sh l1-a 132fa07 docs/x.md', SCRIPTS)).toEqual([{ run: 'l1-a', phase: 'launch' }])
    expect(leadTouches('cd ~/repos/myapp && node scripts/dev/collect.mjs f3s 2>&1 | tail -4', SCRIPTS)).toEqual([{ run: 'f3s', phase: 'collect' }])
    expect(leadTouches('git merge --no-ff -q omdl/f3b-c -m "x"', SCRIPTS)).toEqual([{ run: 'f3b-c', phase: 'merge' }])
    expect(leadTouches('cd /home/user/repos/omdl-f2a-r3 && git commit -qm x', SCRIPTS)).toEqual([{ run: 'f2a-r3', phase: 'round' }])
    expect(leadTouches('node scripts/dev/collect.mjs f3s --dry-run', SCRIPTS)).toEqual([])
    expect(leadTouches('scripts/dev/omdl-merge.sh f3s "msg"', SCRIPTS)).toEqual([])
    expect(leadTouches('rg -n "omdl-launch.sh" CLAUDE.md', SCRIPTS)).toEqual([])
  })

  // 20.10:lead 回合只算改变片状态的动作。只读命令里带了 worktree 路径不算(myapp-bf 07:44Z / 08:04Z 的 ls / stat / du 被记成 round)。
  test('20.10: reading a run\'s worktree is not a round; writing in it is', () => {
    const W = '/home/user/repos/omdl-hm-carry'
    expect(leadTouches(`ls ${W}; stat -c %y ${W}/x; du -sh ${W}; rg -n foo ${W}/a.ts | head; jq . ${W}/m.json`, SCRIPTS)).toEqual([])
    expect(leadTouches(`git -C ${W} status --short; git -C ${W} diff --binary main; git -C ${W} log --oneline -3`, SCRIPTS)).toEqual([])
    expect(leadTouches(`cd ${W} && git status && ls && sed -n 1,5p a.ts`, SCRIPTS)).toEqual([])
    expect(leadTouches(`for d in */; do t=$(stat -c %W "$d"); done; timeout 100 du -s --block-size=1M ${W} 2>/dev/null`, SCRIPTS)).toEqual([])
    expect(leadTouches(`git -C ${W} commit -qm x`, SCRIPTS)).toEqual([{ run: 'hm-carry', phase: 'round' }])
    expect(leadTouches(`echo hi > ${W}/f.txt`, SCRIPTS)).toEqual([{ run: 'hm-carry', phase: 'round' }])
    expect(leadTouches(`cd ${W} && ls && bun test`, SCRIPTS)).toEqual([{ run: 'hm-carry', phase: 'round' }])
    expect(leadTouches(`sed -i s/a/b/ ${W}/a.ts`, SCRIPTS)).toEqual([{ run: 'hm-carry', phase: 'round' }])
    expect(leadTouches(`sed -n 1,3p ${W}/a.ts`, SCRIPTS)).toEqual([])
    expect(leadTouches(`rm -r ${W}/tmp`, SCRIPTS)).toEqual([{ run: 'hm-carry', phase: 'round' }])
    expect(leadTouches(`git -C ${W} branch -D x`, SCRIPTS)).toEqual([{ run: 'hm-carry', phase: 'round' }])
    expect(leadTouches(`cd ${W}; cd /tmp && rm -f x`, SCRIPTS)).toEqual([])
    expect(leadTouches(`cat ${W}/a 2>/dev/null > /tmp/out`, SCRIPTS)).toEqual([])
  })

  test('18.10: a merge script named in `git diff` is not a merge', () => {
    expect(findMerges('cd /r; git diff scripts/dev/omdl-merge.sh scripts/dev/jev-triage.mjs', SCRIPTS)).toEqual([])
  })

  test('18.10: a heredoc body is not a command', () => {
    expect(findLaunches(`cat > docs/x.md <<'EOF'\n起片示例:B=abc; piw run --spec s.md --gate "x" --name x\nEOF\ngit add docs/x.md`)).toEqual([])
    expect(findMerges(`cat > a.md <<'EOF'\nscripts/dev/omdl-merge.sh foo "msg"\nEOF`, SCRIPTS)).toEqual([])
    // 只跳正文:结束行之后的命令照读(`<<-` 与引号定界同样算)。正文里那个是真 CLI 名,不然这条会假绿。
    const after = `cat <<-"EOF"\nomd-lite run --spec s.md --name in-body\nEOF\nomd-lite run --spec s.md --name after`
    expect(findLaunches(after).map(l => l.name)).toEqual(['after'])
  })

  test('a launch or a merge at its command position is still read (assignment prefix, wrapper, script, CLI)', () => {
    expect(findLaunches('scripts/dev/omdl-launch.sh n main s.md', SCRIPTS).length).toBe(1)
    expect(findLaunches('nohup bash scripts/dev/omdl-launch.sh n main s.md &', SCRIPTS).length).toBe(1)
    expect(findLaunches('setsid -f scripts/dev/omdl-launch.sh n main s.md', SCRIPTS).length).toBe(1)
    expect(findLaunches('cd ~/r; vt /x/piw run --spec s.md --name n').length).toBe(1)
    expect(findLaunches('env OMDL_LITE_ENV_FILE=/e piw run --spec s.md --name n').length).toBe(1)
    expect(findMerges('WAVE=W4 scripts/dev/omdl-merge.sh m2 "msg"', { merge: 'scripts/dev/omdl-merge.sh' })).toEqual(['m2'])
    expect(findMerges('bash scripts/dev/omdl-merge.sh m3 "msg"', { merge: 'scripts/dev/omdl-merge.sh' })).toEqual(['m3'])
  })
})

// D-18 三级闸门:批合并后提醒组合片闸 + 层闸;组合片闸跑完清账;独占量测前查全量。
const D18 = JSON.stringify({
  merge: 'scripts/dev/omdl-merge.sh',
  sliceGate: 'scripts/dev/gate-slice.sh',
  layerGates: [
    { pattern: '^supabase/migrations/', cmd: 'bash supabase/ci/replay-local.sh' },
    { pattern: '(^|/)package(-lock)?\\.json$|next\\.config', cmd: 'npm run build --workspace apps/web' },
  ],
  fullGatesSummary: '/tmp/full-gates-{sha}/summary.txt',
  measure: ['perf-gate\\.sh'],
})
const BASE = 'aaaaaaa1111111111111111111111111111111111'
const git = (argv: string[]) => {
  const a = argv.slice(3).join(' ')
  if (a === 'rev-parse HEAD') return BASE
  if (a === 'rev-parse --short HEAD') return 'bbbbbbb22'
  if (a.startsWith('diff --name-only')) return 'supabase/migrations/0360_x.sql\napps/web/src/a.ts'
  if (a.startsWith('merge-base')) return ''
  return ''
}

describe('delegate: D-18 三级闸门', () => {
  test('批合并后:提示组合片闸(批前 sha)与命中的层闸,记账', async ($, on) => {
    const { w } = await world(on, { git, files: { [`${CWD}/.claude/delegate.json`]: D18 } })
    await $.session.start(start)
    const out = await bash($, 'scripts/dev/omdl-merge.sh m1 "merge m1"')
    expect(out.deny).toBeUndefined()
    const ctx = (out.context ?? []).join('\n')
    expect(ctx).toContain('scripts/dev/gate-slice.sh aaaaaaa11')
    expect(ctx).toContain('bash supabase/ci/replay-local.sh')
    expect(ctx).not.toContain('npm run build')
    expect(w.bash.length).toBe(1)
    // 同一批第二片:批前 sha 不变,片数累计。
    const out2 = await bash($, 'scripts/dev/omdl-merge.sh m2 "merge m2"')
    expect((out2.context ?? []).join('\n')).toContain('已合并 2 片(m1 m2)')
  })

  test('组合片闸跑完清账,下一批重新记批前 sha', async ($, on) => {
    await world(on, { git, files: { [`${CWD}/.claude/delegate.json`]: D18 } }, { [`batch:${CWD}`]: { base: BASE, labels: ['m1'], at: T0 } })
    await $.session.start(start)
    const out = await bash($, 'scripts/dev/gate-slice.sh aaaaaaa11')
    expect((out.context ?? []).join('\n')).toContain('清账')
    const again = await bash($, 'scripts/dev/gate-slice.sh aaaaaaa11')
    expect(again.context ?? []).toEqual([])
  })

  test('独占量测前:没有全量结果 → 拦', async ($, on) => {
    const { w } = await world(on, { git, files: { [`${CWD}/.claude/delegate.json`]: D18 } })
    await $.session.start(start)
    const out = await bash($, 'scripts/dev/perf-gate.sh')
    expect(out.deny).toContain('还没有全量结果')
    expect(out.deny).toContain('/tmp/full-gates-bbbbbbb22/summary.txt')
    expect(w.bash.length).toBe(0)
  })

  test('独占量测前:全量有红 → 拦并点名;全绿 → 放行', async ($, on) => {
    const files: Record<string, string> = {
      [`${CWD}/.claude/delegate.json`]: D18,
      '/tmp/full-gates-bbbbbbb22/summary.txt': '01-tsc rc=0 30s\n02-vitest rc=1 300s\n13-next-build rc=0 90s\n',
    }
    const { w } = await world(on, { git, files })
    await $.session.start(start)
    const red = await bash($, 'scripts/dev/perf-gate.sh')
    expect(red.deny).toContain('02-vitest')
    files['/tmp/full-gates-bbbbbbb22/summary.txt'] = '01-tsc rc=0 30s\n02-vitest rc=0 300s\n'
    const green = await bash($, 'scripts/dev/perf-gate.sh')
    expect(green.deny).toBeUndefined()
    expect(w.bash).toEqual(['scripts/dev/perf-gate.sh'])
  })

  test('没配置 → 合并只做清理,量测不拦', async ($, on) => {
    const { w } = await world(on, { git })
    await $.session.start(start)
    const out = await bash($, 'scripts/dev/perf-gate.sh')
    expect(out.deny).toBeUndefined()
    expect(w.bash.length).toBe(1)
  })

  test('纯函数', () => {
    expect(fullGatesVerdict(null).isGreen).toBe(false)
    expect(fullGatesVerdict('').isGreen).toBe(false)
    expect(fullGatesVerdict('01-tsc rc=0 3s\n02-x rc=2 1s').red).toEqual(['02-x'])
    expect(layerGatesFor(['package.json'], [{ pattern: '(^|/)package\\.json$', cmd: 'b' }, { pattern: '[', cmd: 'bad' }])).toEqual(['b'])
    expect(runsSliceGate('cd /r && scripts/dev/gate-slice.sh aaaaaaa1', 'scripts/dev/gate-slice.sh', BASE)).toBe(true)
    expect(runsSliceGate('scripts/dev/gate-slice.sh main', 'scripts/dev/gate-slice.sh', BASE)).toBe(false)
  })
})

// owner 10.11:relay 只在没有子 agent 在跑时才 /clear;交接开始后再派新的,清空就永远等不到。
describe('delegate: the handoff gate', () => {
  const HANDOFF_PATH = '/home/t/.claude/handoffs/myapp-S1.md'
  const relayHandoff = (on: On, phase: string | null) =>
    on('state.get', async (_$, e) => {
      if (phase === null) throw new Error('relay not installed')
      return { value: { value: e.plugin === 'relay' && e.key === 'handoff' ? { phase, path: HANDOFF_PATH } : undefined, version: 1 } as never }
    })
  const dispatched = (on: On, tools: string[]) => {
    for (const tool of ['Agent', 'Workflow', 'SendMessage']) on('tool.call', { tool } as never, () => { tools.push(tool); return { result: {}, text: 'ran' } as never })
  }

  test('handoff armed: a new Agent is refused, the reason names HANDOFF-READY and the handoff path', async ($, on) => {
    await world(on)
    relayHandoff(on, 'armed')
    const ran: string[] = []
    dispatched(on, ran)
    await $.session.start(start)
    const out = await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'd' } as never)
    expect(ran).toEqual([])
    expect(out.deny).toContain('HANDOFF-READY')
    expect(out.deny).toContain(HANDOFF_PATH)
  })

  test('handoff ready: Workflow and SendMessage are refused too (both start subagent runs)', async ($, on) => {
    await world(on)
    relayHandoff(on, 'ready')
    const ran: string[] = []
    dispatched(on, ran)
    await $.session.start(start)
    expect((await $.tool.call({ tool: 'Workflow', script: 'x' } as never)).deny).toBeDefined()
    expect((await $.tool.call({ tool: 'SendMessage', to: 'a', message: 'm' } as never)).deny).toBeDefined()
    expect(ran).toEqual([])
  })

  test('no handoff, or relay unreadable: dispatch passes untouched', async ($, on) => {
    await world(on)
    relayHandoff(on, 'idle')
    const ran: string[] = []
    dispatched(on, ran)
    await $.session.start(start)
    const out = await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'd' } as never)
    expect(out.deny).toBeUndefined()
    expect(ran).toEqual(['Agent'])
  })

  test('relay not installed (state read throws): dispatch passes', async ($, on) => {
    await world(on)
    relayHandoff(on, null)
    const ran: string[] = []
    dispatched(on, ran)
    await $.session.start(start)
    expect((await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'd' } as never)).deny).toBeUndefined()
    expect(ran).toEqual(['Agent'])
  })
})

// ── S11: omd-lite is now piw (G-7) ───────────────────────────────────────────────────────

describe('delegate: S11 rename — the names table (G-7)', () => {
  test('defaults: both CLI names, the old runs dir, omdl/ branches and omdl- worktrees', () => {
    expect(RUN_NAMES).toEqual({ cliNames: ['piw', 'omd-lite'], runsDir: '.omd-lite/runs', branchPrefix: 'omdl/', wtPrefix: 'omdl-' })
    expect(resolveNames({})).toEqual(RUN_NAMES)
    expect(runsDirOf('/home/t')).toBe('/home/t/.omd-lite/runs')
  })

  test('options override each field; blanks fall back to the defaults', () => {
    const n = resolveNames({ cliNames: 'worker, piw', runsDir: '/x/runs', branchPrefix: 'w/', wtPrefix: 'w-' })
    expect(n).toEqual({ cliNames: ['worker', 'piw'], runsDir: '/x/runs', branchPrefix: 'w/', wtPrefix: 'w-' })
    expect(runsDirOf('/home/t', n)).toBe('/x/runs')
    expect(resolveNames({ cliNames: ' ', runsDir: '' })).toEqual(RUN_NAMES)
    expect(resolveNames({ cliNames: ['a', 'b'] }).cliNames).toEqual(['a', 'b'])
  })

  test('findLaunches reads piw and omd-lite alike (bare, absolute, behind the old symlink)', () => {
    for (const head of ['piw', 'omd-lite', '/home/user/repos/piw/bin/piw', '/home/user/repos/omd-lite/bin/omd-lite', '/home/user/repos/omd-lite/bin/piw', 'vt /home/user/repos/piw/bin/piw']) {
      const [l] = findLaunches(`${head} run --spec docs/b.md --name n1`)
      expect(l?.name).toBe('n1')
      expect(l?.kind).toBe('omd-lite')
    }
    expect(findLaunches('piw ask --role continuity')).toEqual([])
  })

  test('a custom CLI-name table replaces the defaults', () => {
    const names = resolveNames({ cliNames: 'worker' })
    expect(findLaunches('worker run --spec s.md --name n1', {}, names).length).toBe(1)
    expect(findLaunches('piw run --spec s.md --name n1', {}, names)).toEqual([])
    expect(looksLikeLaunch('worker run --spec s.md', names)).toBe(true)
    expect(looksLikeLaunch('piw run --spec s.md', names)).toBe(false)
    expect(mentionsRuns('worker status', names)).toBe(true)
    expect(mentionsRuns('piw status', names)).toBe(false)
  })

  test('mentionsRuns: either name or the worktree prefix; plain words that merely contain piw do not count', () => {
    expect(mentionsRuns('piw gc')).toBe(true)
    expect(mentionsRuns('omd-lite gc')).toBe(true)
    expect(mentionsRuns('ls ../omdl-foo')).toBe(true)
    expect(mentionsRuns('echo hippiwow')).toBe(false)
  })

  test('findMerges takes the branch prefix from the table', () => {
    expect(findMerges('git merge omdl/a omdl/b')).toEqual(['a', 'b'])
    expect(findMerges('git merge w/a omdl/b', {}, resolveNames({ branchPrefix: 'w/' }))).toEqual(['a'])
  })

  test('both OMD_LITE_ENV_FILE= and PIW_ENV_FILE= on the command count as an env file already given', () => {
    expect(findLaunches('PIW_ENV_FILE=/e piw run --spec s.md --name n')[0]?.hasEnvFile).toBe(true)
    expect(findLaunches('OMD_LITE_ENV_FILE=/e omd-lite run --spec s.md --name n')[0]?.hasEnvFile).toBe(true)
    expect(findLaunches('piw run --spec s.md --name n')[0]?.hasEnvFile).toBe(false)
  })
})

describe('delegate: S11 rename — the runner path (piwPath / omdLitePath)', () => {
  const merged = async ($: Engine, on: On, w: World) => {
    w.files['/home/t/.omd-lite/runs/m1/meta.json'] = JSON.stringify({ repo: CWD, worktree: '/r/omdl-m1', branch: 'omdl/m1' })
    w.files['/r/omdl-m1'] = ''
    await $.session.start(start)
    await bash($, 'git merge --no-ff -q omdl/m1 -m "merge m1"')
    return w.argv.find(a => a[1] === 'clean' && a[2] === 'm1')?.[0]
  }

  test('nothing configured, directory not renamed yet: the old path', async ($, on) => {
    const { w } = await world(on)
    expect(await merged($, on, w)).toBe('/home/user/repos/omd-lite/bin/omd-lite')
  })

  test('nothing configured, ~/repos/piw/bin/piw exists: piw', async ($, on) => {
    const { w } = await world(on)
    w.files['/home/user/repos/piw/bin/piw'] = ''
    expect(await merged($, on, w)).toBe('/home/user/repos/piw/bin/piw')
  })

  test('the old key omdLitePath is still read', { options: { omdLitePath: '/old/omd-lite' } }, async ($, on) => {
    const { w } = await world(on)
    w.files['/home/user/repos/piw/bin/piw'] = ''
    expect(await merged($, on, w)).toBe('/old/omd-lite')
  })

  test('piwPath wins over omdLitePath', { options: { piwPath: '/new/piw', omdLitePath: '/old/omd-lite' } }, async ($, on) => {
    const { w } = await world(on)
    expect(await merged($, on, w)).toBe('/new/piw')
  })

  test('an empty piwPath (the manifest default) means auto', { options: { piwPath: '' } }, async ($, on) => {
    const { w } = await world(on)
    w.files['/home/user/repos/piw/bin/piw'] = ''
    expect(await merged($, on, w)).toBe('/home/user/repos/piw/bin/piw')
  })
})

describe('delegate: S11 rename — overrides reach the scanner and the clean-up', () => {
  test('default table: scan.mjs gets no runs-dir argument and no env', async ($, on) => {
    const { w } = await world(on, { runs: [run()] })
    await $.session.start(start)
    const call = w.argv.findIndex(a => String(a[1]).endsWith('/bin/scan.mjs'))
    expect(w.argv[call]).toEqual(['node', expect.stringContaining('/bin/scan.mjs'), 'S1'])
    expect(w.envs[call]).toBeUndefined()
  })

  test('runsDir and cliNames options: appended to scan.mjs, and the meta of a merged run is read from there', { options: { runsDir: '/data/runs', cliNames: 'worker' } }, async ($, on) => {
    const { w } = await world(on, { runs: [run()] })
    w.files['/data/runs/m1/meta.json'] = JSON.stringify({ repo: CWD, worktree: '/r/omdl-m1', branch: 'omdl/m1' })
    w.files['/r/omdl-m1'] = ''
    await $.session.start(start)
    const call = w.argv.findIndex(a => String(a[1]).endsWith('/bin/scan.mjs'))
    expect(w.argv[call]?.at(-1)).toBe('/data/runs')
    expect(w.envs[call]).toEqual({ DELEGATE_CLI_NAMES: 'worker' })
    await bash($, 'git merge --no-ff -q omdl/m1 -m "merge m1"')
    expect(w.argv.some(a => a[1] === 'clean' && a[2] === 'm1')).toBe(true)
  })

  test('wtPrefix option: the disk budget counts worktrees by that prefix', { options: { wtPrefix: 'w-' } }, async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    await bash($, launch('d1'))
    const du = w.argv.find(a => a[0] === 'sh' && String(a[2]).includes('du -skc'))
    expect(du?.at(-1)).toBe('w-')
    expect(String(du?.[2])).toContain('"$1"/"$2"*')
  })
})

// F1a(factory/lib/brief.mjs):允许改动的解析搬去了 factory,这里只剩一道接线断言 —— 副本接上以后
// guard 拿到的还是同一份列表(含 (新建) 标记)。
describe('F1a: 允许改动 走 factory 的解析器', () => {
  test('「允许改动:a.ts(新建)」→ 一条标了新建的路径', () => {
    expect(allowedPaths('允许改动:a.ts(新建)')).toEqual([{ path: 'a.ts', isNew: true }])
    expect(allowedPaths('没有这一行')).toBe(null)
  })
})

// M2 · G-B(2026-10-15-m2-brief-lint.md):起片前多查四件事 —— 已重算 · 对外签名 · 碰敏感路径要写
// 「## 安全面」· 引用 clients/ 与 ~/.config/myapp 与生产 URL 一律拒派。夹具是 myapp 盘上三份真任务书
// 与一份合成任务书,逐字落在 brief-replay.fixtures.ts。
describe('delegate: 任务书 lint(G-B · S16c1「借的方法」)', () => {
  /** myapp 的拒派清单(lead 已定):个人数据 / 生产凭证 / 生产库,都不许经任务书发给执行体。 */
  const MYAPP_DENY: BriefDeny[] = [
    { re: '(^|[^\\w./-])clients/|/repos/[\\w.-]+/clients/', why: '引用仓根 clients/(客户名册 / 工资等个人数据):个人数据不许经任务书发给 DPA 外的模型,客户交付脚本只交 Claude' },
    { re: '\\.config/myapp(?!/local(/|\\b))', why: '引用 ~/.config/myapp(生产凭证目录;本地栈凭证 ~/.config/myapp/local/ 除外)' },
    { re: 'prodref0000000000000', why: '引用生产 Supabase 项目(ref prodref0000000000000):执行体不许碰生产' },
  ]

  const lint = (text: string) => briefGaps(text, { sensitive: SENSITIVE_PATHS, deny: MYAPP_DENY })
  /** 只看拒派那一条(gap 4),不误伤的三条也用它断言。 */
  const denied = (text: string) => briefGaps(text, { deny: MYAPP_DENY }).filter(g => g.startsWith('引用了不许交给执行体的内容'))
  /** 只看安全面那一条(gap 3);S16c1 起的「借的方法」缺口也以「允许改动碰敏感路径」开头,按消息分。 */
  const security = (text: string) => briefGaps(text, { sensitive: SENSITIVE_PATHS }).filter(g => g.includes('缺「## 安全面」节'))

  test('回放:三份漏安全面的历史任务书各自被点名(清单逐字来自 sensitive-paths.txt)', () => {
    expect(REPLAY.slice(0, 3).map(r => r.name)).toEqual([
      'docs/plan/10.11/px-aud-0360-consent.md',
      'docs/plan/10.10/c4/S2-mapping.md',
      'docs/plan/10.12/oauth-gate-slice.md',
    ])
    for (const r of REPLAY.slice(0, 3)) {
      const gaps = lint(r.text)
      expect(gaps.length).toBeGreaterThan(0)
      // S16c1(10.17 §3.3):这三份都碰敏感路径,现在还多一条「借的方法」节缺口 —— 安全面与借的方法各一条。
      expect(gaps.filter(g => g.startsWith('允许改动碰敏感路径')).length).toBe(2)
      expect(gaps.some(g => g.includes('缺「## 安全面」节'))).toBe(true)
      expect(gaps.some(g => g.includes('缺「## 借的方法'))).toBe(true)
    }
  })

  test('回放:引用 clients/client-a 的任务书被拒派,点名是哪一条不许交', () => {
    const r = REPLAY.at(-1)
    expect(r?.name).toBe('synthetic/client-a-oct-import.md')
    const gaps = lint(r?.text ?? '')
    const hit = gaps.filter(g => g.startsWith('引用了不许交给执行体的内容'))
    expect(hit.length).toBe(1)
    expect(hit[0]).toContain('clients/')
    expect(hit[0]).toContain(MYAPP_DENY[0]?.why)
    // 它写了「期望值:无」「对外签名:无」,这两项不该再报 —— 拒派只报真的那一条。
    expect(gaps.some(g => g.includes('已重算'))).toBe(false)
    expect(gaps.some(g => g.includes('对外签名'))).toBe(false)
  })

  test('不误伤:scripts/clients/、~/.config/myapp/local/、生产域名都不拒派', () => {
    const brief = (extra: string) => ['**原始目标原文(owner 15.10)**:「q」', '**允许改动:** src/a.ts', extra, '## 成功判据', '绿'].join('\n')
    expect(denied(brief('- 读 `scripts/clients/x.ts`。'))).toEqual([])
    expect(denied(brief('- 读 `~/.config/myapp/local/supabase.env`。'))).toEqual([])
    expect(denied(brief('- 站点 https://example-app.fi。'))).toEqual([])
  })

  test('安全面:标题行写了就不报;正文里提一句「安全面」不算', () => {
    const r = REPLAY[0]
    const [gap] = security(r?.text ?? '')
    expect(gap).toContain('supabase/migrations/0360_consent_events_select_setbased.sql')
    expect(gap).toContain('缺「## 安全面」节')
    expect(security(`${r?.text ?? ''}\n## 安全面\n- 迁移只加不改\n`).length).toBe(0)
    expect(security(`${r?.text ?? ''}\n碰迁移的片要写「安全面」。\n`).length).toBe(1)
  })

  test('已重算 / 对外签名:缺各报一条,写了不报', () => {
    const bare = ['# x · 一片', '**原始目标原文(owner 15.10)**:「q」', '**允许改动:** src/a.ts', '## 成功判据', '绿'].join('\n')
    expect(briefGaps(bare).length).toBe(2)
    expect(briefGaps(bare)[0]).toContain('已重算')
    expect(briefGaps(bare)[1]).toContain('对外签名')
    expect(briefGaps(`${bare}\n期望值:无\n对外签名:无\n`)).toEqual([])
    expect(briefGaps(bare.replace('## 成功判据', '## 对外接口\n`f(x: number): string`\n(lead 已重算)\n## 成功判据'))).toEqual([])
  })

  /** 10.19 任务书自检:回流节 · 签名行「下面写明」。只看这两条缺口,别的缺口(老任务书缺「原始目标原文」之类)不算。 */
  const selfCheck = (text: string) => briefGaps(text).filter(g => g.includes('回流') || g.includes('对外签名行'))
  const named = (name: string) => selfCheck(SELFCHECK.find(b => b.name === name)?.text ?? '')

  test('回放:b1 · gate-preflight · s9c 三份出过事的任务书都被拦,各点名是哪一类', () => {
    expect(SELFCHECK.filter(b => b.kind === 'bad').map(b => b.name)).toEqual(['b1', 'gate-preflight', 's9c'])
    expect(named('b1').some(g => g.startsWith('有「回流」节'))).toBe(true)
    expect(named('b1').some(g => g.startsWith('对外签名行'))).toBe(true)
    expect(named('gate-preflight').some(g => g.startsWith('有「回流」节'))).toBe(true)
    expect(named('s9c').some(g => g.startsWith('有「回流」节'))).toBe(true)
  })

  test('对照:三份干净的任务书一条不报(s9a · f4-7-collect · t2)', () => {
    const clean = SELFCHECK.filter(b => b.kind === 'clean')
    expect(clean.length).toBe(3)
    for (const b of clean) expect([b.name, selfCheck(b.text)]).toEqual([b.name, []])
  })

  test('签名行:「照下面的做法」不是承诺列表,不报;「与下面写明的纯函数」报', () => {
    const base = ['**原始目标原文(owner 19.10)**:「q」', '**允许改动:** a.mjs', '期望值:无', '## 成功判据', '绿']
    expect(selfCheck([...base, '对外签名:只导出 `f(x)`;要用的东西照下面的做法写。'].join('\n'))).toEqual([])
    expect(selfCheck([...base, '对外签名:导出 `f(x)` 与下面写明的纯函数。'].join('\n')).length).toBe(1)
    expect(selfCheck([...base, '对外签名:无', '## r2 回流', '裁定 3 改成 x。'].join('\n')).length).toBe(1)
    expect(selfCheck([...base, '对外签名:无', '## 冻结的接口(照抄,偏离就回流改契约)', '`f(x)`'].join('\n'))).toEqual([])
  })

  test('sensitiveHits:bash 模式 → 路径(目录算命中,同前缀不同目录不算),去重保序', () => {
    expect(sensitiveHits(['packages/payroll/src/a.ts'], ['packages/payroll/*'])).toEqual(['packages/payroll/src/a.ts'])
    expect(sensitiveHits(['apps/web/src/app/[locale]/(app)/x/page.tsx'], ['apps/web/src/app/\\[locale\\]/(app)/*/page.tsx'])).toEqual(['apps/web/src/app/[locale]/(app)/x/page.tsx'])
    expect(sensitiveHits(['packages/'], ['packages/payroll/*'])).toEqual(['packages/'])
    expect(sensitiveHits(['packages/engine2/a.ts'], ['packages/engine/*'])).toEqual([])
    expect(sensitiveHits(['packages/payroll/a.ts', 'apps/web/next.config.ts', 'packages/payroll/a.ts'], ['packages/payroll/*', 'apps/web/next.config.ts'])).toEqual(['packages/payroll/a.ts', 'apps/web/next.config.ts'])
  })

  test('拒派:在全文上匹配 —— 跨两行的引用照样命中,^ 锚在任务书开头', () => {
    const deny: BriefDeny[] = [
      { re: '名册导\\n进本地栈', why: '跨两行的引用也算' },
      { re: '^允许改动', why: '允许改动写在任务书第一行' },
    ]
    const gaps = (text: string) => briefGaps(text, { deny }).filter(g => g.startsWith('引用了不许交给执行体的内容'))
    const brief = ['允许改动: src/a.ts', '**原始目标原文(owner 15.10)**:「把名册导', '进本地栈」', '## 成功判据', '绿'].join('\n')
    expect(gaps(brief)).toEqual(['引用了不许交给执行体的内容:跨两行的引用也算', '引用了不许交给执行体的内容:允许改动写在任务书第一行'])
    expect(gaps(brief.replace('允许改动: src/a.ts\n', ''))).toEqual(['引用了不许交给执行体的内容:跨两行的引用也算'])
    // 同一处命中两次也只报一条。
    expect(gaps(`${brief}\n- 附录:名册导\n进本地栈 的旧记录`)).toEqual(['引用了不许交给执行体的内容:跨两行的引用也算', '引用了不许交给执行体的内容:允许改动写在任务书第一行'])
    // 仓配置里的正则编不出来:点名,不抛(抛出去会让每次起片都无标签地拒)。
    expect(briefGaps('x', { deny: [{ re: '[', why: '编不出来' }] }).filter(g => g.includes('briefDeny'))).toEqual(['「briefDeny」里有编不出来的正则(这条等于没拦):['])
  })

  // judge 接线:仓配置的 sensitivePaths(相对 --repo 的清单文件)+ briefDeny。
  const PAYROLL_BRIEF = [
    '# x · 计薪 SQL 一片',
    '**原始目标原文(owner 15.10)**:「给结余表加一条索引」',
    '**允许改动:** packages/payroll/src/index.sql(新建)',
    '期望值:无',
    '对外签名:无',
    '## 成功判据',
    '`npm run verify:payroll` 绿',
  ].join('\n')
  const CFG_FILES: Record<string, string> = {
    [`${CWD}/.claude/delegate.json`]: JSON.stringify({ sensitivePaths: 'scripts/dev/sensitive-paths.txt', briefDeny: MYAPP_DENY }),
    [`${CWD}/scripts/dev/sensitive-paths.txt`]: '# 清单\npackages/payroll/*\n',
    [`${CWD}/docs/b.md`]: PAYROLL_BRIEF,
  }

  test('接线:允许改动碰清单里的路径又没写安全面 → 拒派', async ($, on) => {
    const { w } = await world(on, { files: CFG_FILES })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toContain('packages/payroll/src/index.sql')
    expect(out.deny).toContain('缺「## 安全面」节')
    expect(w.bash.length).toBe(0)
  })

  test('接线:清单文件读不到 → 不查安全面,也不报错(同一任务书放行)', async ($, on) => {
    const files: Record<string, string> = { ...CFG_FILES }
    delete files[`${CWD}/scripts/dev/sensitive-paths.txt`]
    const { w } = await world(on, { files })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toBeUndefined()
    expect(w.bash.length).toBe(1)
  })

  test('接线:briefDeny 命中(任务书里写了 clients/) → 拒派,并念出 why', async ($, on) => {
    const brief = `${PAYROLL_BRIEF}\n## 安全面\n- 只加索引\n\n输入照 \`clients/client-a/README.md\`。\n`
    const { w } = await world(on, { files: { ...CFG_FILES, [`${CWD}/docs/b.md`]: brief } })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toContain('引用了不许交给执行体的内容')
    expect(out.deny).toContain('个人数据')
    expect(out.deny).not.toContain('缺「## 安全面」节')
    expect(w.bash.length).toBe(0)
  })

  // ── S16c1(myapp 10.17 ambition-framework §3.3):「借的方法」节 ──────────────────────
  // 借专家的方法与视角,不做角色扮演:把任务书里的名词换成动词的那一节。有节就要对(卡存在 · 四行齐 · 判官是
  // 命令且在成功判据里);碰钱与权限的片强制,普通片不报(对照臂要能起)。
  const M_SENSITIVE = ['supabase/migrations/*', 'packages/payroll/*', 'apps/web/src/lib/palkat/*']
  const M_METHODS = ['reconcile-money', 'migrate-schema']
  const mOpts = (over: Partial<Parameters<typeof briefGaps>[1]> = {}) => ({ sensitive: M_SENSITIVE, methods: M_METHODS, ...over })
  /** 一份照做的钱/权限片:允许改动碰 M_SENSITIVE,`mid` 是方法节 / 豁免行 / 都不写的空位。 */
  const moneyBrief = (mid: string) =>
    [
      '# x · 计薪迁移一片',
      '**原始目标原文(owner 17.10)**:「给结余表加一条索引」',
      '**允许改动:** packages/payroll/src/0999_x.sql(新建)',
      '期望值:无',
      '对外签名:无',
      mid,
      '## 安全面',
      '- 只加索引,不改既有策略',
      '## 成功判据',
      '`bash scripts/dev/gate-slice.sh main` 绿',
    ].join('\n')
  const METHOD_CARD = [
    '## 借的方法(migrate-schema)',
    '原始材料:迁移文件与线上索引的现状',
    '照做:先量后改 · 改完重跑计划断言',
    '禁止:顺手删别的迁移',
    '判官:bash scripts/dev/gate-slice.sh',
  ].join('\n')
  /** 普通片:允许改动不碰敏感清单 —— 对照臂,方法节与豁免行都不该拦它。 */
  const plainBrief = (mid: string) =>
    [
      '# y · 文案一片',
      '**原始目标原文(owner 17.10)**:「把这段话改短」',
      '**允许改动:** apps/web/src/lib/copy/short.ts',
      '期望值:无',
      '对外签名:无',
      mid,
      '## 成功判据',
      '`bash scripts/dev/gate-slice.sh main` 绿',
    ].join('\n')

  test('回放:myapp 10.17 那三份普通任务书(没有借的方法节)结果与改前逐字一致 —— 对照臂能起', () => {
    // 任务书原样在 ~/repos/myapp/docs/plan/10.17/briefs/{s13-collect,s14-floor-guard,s15-brief-frontier}.md;
    // 本机没有 myapp 盘(见收尾报告),这三份按它们的形状手写:没有「借的方法」节,允许改动不碰敏感清单。
    const PLAIN = [
      ['s13-collect.md', 'scripts/dev/collect-clients.ts', 'npm run collect:dry'],
      ['s14-floor-guard.md', 'scripts/dev/floor-guard.sh', 'bash scripts/dev/gate-slice.sh main'],
      ['s15-brief-frontier.md', 'docs/plan/10.17/briefs/README.md', 'npx tsc --noEmit'],
    ] as const
    for (const [name, path, cmd] of PLAIN) {
      const text = [
        `# ${name} · 一片(MiniMax 任务书)`,
        '**原始目标原文(owner 17.10)**:「这一片按方法卡做」',
        `**允许改动:** ${path}`,
        '期望值:无',
        '对外签名:无',
        '## 成功判据',
        `\`${cmd}\` 绿`,
      ].join('\n')
      expect(briefGaps(text, mOpts())).toEqual([])
    }
    // 盘上那份逐字夹具(不碰敏感清单的老任务书)也不多一条。
    expect(briefGaps(REPLAY.at(-1)?.text ?? '', mOpts())).toEqual([])
  })

  test('普通片:没有节、没有豁免行 → 不报(对照臂);写了豁免行也只当没写', () => {
    expect(briefGaps(plainBrief(''), mOpts())).toEqual([])
    expect(briefGaps(plainBrief('借的方法:豁免 -- 纯文案片'), mOpts())).toEqual([])
    expect(briefGaps(plainBrief('借的方法:豁免 -- 纯文案片'))).toEqual([])
    expect(methodExemption(plainBrief('借的方法:豁免 -- 纯文案片'))).toBe('纯文案片')
    expect(methodExemption(plainBrief(''))).toBeNull()
  })

  test('钱与权限的片:碰敏感路径又没写节 → 点名缺节;写豁免行 → 同样缺,且不许豁免', () => {
    const bare = briefGaps(moneyBrief(''), mOpts())
    expect(bare.filter(g => g.includes('缺「## 借的方法')).length).toBe(1)
    expect(bare.filter(g => g.startsWith('允许改动碰敏感路径')).length).toBe(1)
    expect(bare[0]).toContain('packages/payroll/src/0999_x.sql')
    const ex = briefGaps(moneyBrief('借的方法:豁免 -- 纯文案片'), mOpts())
    expect(ex.some(g => g.includes('缺「## 借的方法'))).toBe(true)
    expect(ex.some(g => g.includes('不许豁免'))).toBe(true)
    // 补法那一句常驻拒派文案,别让它把「不许豁免」这条判据糊过去。
    expect(briefGaps(plainBrief('借的方法:豁免 -- 纯文案片'), mOpts()).some(g => g.includes('不许豁免'))).toBe(false)
  })

  test('钱与权限的片:节写对了 → 与「借的方法」有关的 gap 零条', () => {
    expect(briefGaps(moneyBrief(METHOD_CARD), mOpts())).toEqual([])
  })

  test('有节就要对:卡不在 docs/methods/ → 点名;调用处没给 methods → 不查这一条', () => {
    const bad = METHOD_CARD.replace('(migrate-schema)', '(no-such-card)')
    expect(briefGaps(moneyBrief(bad), mOpts()).some(g => g.includes('在 docs/methods/ 里不存在') && g.includes('no-such-card'))).toBe(true)
    // methods 没给 = 调用处没读到 docs/methods/:只跳过存在性,其它检查照做(下面这四行全对 → 仍零条)。
    expect(briefGaps(moneyBrief(bad), mOpts({ methods: undefined }))).toEqual([])
  })

  test('判官:不是命令 → 报「不是命令」;是命令但没列进成功判据 → 报没列', () => {
    const eyes = moneyBrief(METHOD_CARD.replace('判官:bash scripts/dev/gate-slice.sh', '判官:spec-reviewer 看一眼'))
    expect(briefGaps(eyes, mOpts())).toContain('「借的方法」的判官不是命令(模型不算判官)')
    // 不是命令就不查「列没列」—— 判官那一行压根不是命令可比。
    expect(briefGaps(eyes, mOpts()).some(g => g.includes('没列在「成功判据」里'))).toBe(false)
    const listed = moneyBrief(METHOD_CARD.replace('bash scripts/dev/gate-slice.sh', 'npm run verify:payroll'))
    const gaps = briefGaps(listed, mOpts())
    expect(gaps).toContain('「借的方法」的判官命令没列在「成功判据」里')
    expect(gaps.some(g => g.includes('不是命令'))).toBe(false)
  })

  test('钱与权限的片:「照做」写「无」→ 报不许写「无」;普通片写「无」不报', () => {
    const none = moneyBrief(METHOD_CARD.replace('照做:先量后改 · 改完重跑计划断言', '照做:无'))
    expect(briefGaps(none, mOpts())).toContain('钱与权限的片「借的方法」不许写「无」')
    expect(briefGaps(plainBrief(METHOD_CARD.replace('照做:先量后改 · 改完重跑计划断言', '照做:无')), mOpts())).toEqual([])
  })

  test('四行缺一 → 点名缺哪行;两行都缺 → 一条里都说', () => {
    const noJudge = moneyBrief(METHOD_CARD.replace(/^判官:.*$/m, ''))
    expect(briefGaps(noJudge, mOpts())).toContain('「借的方法」节缺「判官」')
    const neither = moneyBrief(METHOD_CARD.replace(/^照做:.*$/m, '').replace(/^判官:.*$/m, ''))
    expect(briefGaps(neither, mOpts())).toContain('「借的方法」节缺「照做」与「判官」')
  })

  test('方法卡的检查排在拒派清单之前', () => {
    const t = moneyBrief('输入照 `clients/client-a/README.md`。')
    const gaps = briefGaps(t, { sensitive: M_SENSITIVE, methods: M_METHODS, deny: MYAPP_DENY })
    const at = (re: RegExp) => gaps.findIndex(g => re.test(g))
    expect(at(/缺「## 借的方法/)).toBeGreaterThanOrEqual(0)
    expect(at(/^引用了不许交给执行体的内容/)).toBeGreaterThanOrEqual(0)
    expect(at(/缺「## 借的方法/)).toBeLessThan(at(/^引用了不许交给执行体的内容/))
  })

  test('methodSection:标题取 slug、正文取四行(半角全角括号冒号都认);没有这一节 → null', () => {
    const sample = [
      '## 借的方法(reconcile-money)',
      '原始材料:原始凭证与流水,不是已汇总的报表',
      '照做:双向对账(两套独立实现算同一数) · 抽样复算 · 差异台账',
      '禁止:只核合计 · 让算的人自己核',
      '判官:node --test packages/payroll/src/__tests__/parity.test.ts',
    ].join('\n')
    const sec = methodSection(sample)
    expect(sec?.slug).toBe('reconcile-money')
    expect(sec?.lines['判官']).toBe('node --test packages/payroll/src/__tests__/parity.test.ts')
    expect(sec?.lines['原始材料']).toBe('原始凭证与流水,不是已汇总的报表')
    expect(sec?.lines['照做']).toBe('双向对账(两套独立实现算同一数) · 抽样复算 · 差异台账')
    expect(sec?.lines['禁止']).toBe('只核合计 · 让算的人自己核')
    // 全角括号全角冒号 + 加粗行 + 标题后面跟说明文字(照 contract skill 的模板)。
    const wide = ['## 借的方法(reconcile-money)  从 docs/methods/reconcile-money.yaml 抄', '**原始材料:**流水', '照做：抽样复算', '禁止:只核合计', '判官:`npx vitest run payroll`', '## 下一节', '照做:不是这个'].join('\n')
    expect(methodSection(wide)?.slug).toBe('reconcile-money')
    expect(methodSection(wide)?.lines['原始材料']).toBe('流水')
    expect(methodSection(wide)?.lines['照做']).toBe('抽样复算')
    // 判官写在反引号里(任务书里命令常这么写)不算「不是命令」:取值时剥掉包着的反引号。
    expect(methodSection(wide)?.lines['判官']).toBe('npx vitest run payroll')
    // 下一个标题之后的不算这节。
    expect(methodSection(wide)?.lines['禁止']).toBe('只核合计')
    expect(methodSection(plainBrief(''))).toBeNull()
    expect(methodSection('## 借的方法\n照做:抽样')).toBeNull()
    // 豁免行照仓里既有的写法(`**借的方法:**豁免 -- 理由` = 加粗前缀那半截)也认。
    expect(methodExemption('**借的方法:**豁免 -- 纯文案片')).toBe('纯文案片')
    expect(methodExemption('借的方法:豁免 -- 纯文案片')).toBe('纯文案片')
    expect(methodExemption('借的方法：豁免 -- 纯文案片')).toBe('纯文案片')
  })

  // judge 接线:被判的那仓 docs/methods/*.yaml 的 stem 列表(不在 .claude/delegate.json 里)。
  const METHOD_FILES: Record<string, string> = {
    [`${CWD}/docs/methods/migrate-schema.yaml`]: 'instruments: []\n',
    [`${CWD}/docs/methods/reconcile-money.yaml`]: 'instruments: []\n',
  }
  const wiredBrief = (slug: string) =>
    [
      '# x · 计薪 SQL 一片',
      '**原始目标原文(owner 15.10)**:「给结余表加一条索引」',
      '**允许改动:** packages/payroll/src/index.sql(新建)',
      '期望值:无',
      '对外签名:无',
      `## 借的方法(${slug})`,
      '原始材料:结余表的原始流水',
      '照做:双向对账 · 差异台账',
      '禁止:只核合计',
      '判官:npm run verify:payroll',
      '## 安全面',
      '- 只加索引',
      '## 成功判据',
      '`npm run verify:payroll` 绿',
    ].join('\n')

  test('接线:docs/methods/ 里有卡 → slug 不在其中就拒派', async ($, on) => {
    const { w } = await world(on, { files: { ...CFG_FILES, ...METHOD_FILES, [`${CWD}/docs/b.md`]: wiredBrief('no-such-card') } })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toContain('在 docs/methods/ 里不存在')
    expect(out.deny).toContain('no-such-card')
    expect(out.deny).toContain('抄四行进任务书')
    expect(w.bash.length).toBe(0)
  })

  test('接线:docs/methods/ 目录不在 → 不查卡存在性,也不报错', async ($, on) => {
    const { w } = await world(on, { files: { ...CFG_FILES, [`${CWD}/docs/b.md`]: wiredBrief('no-such-card') } })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toBeUndefined()
    expect(w.bash.length).toBe(1)
  })

  test('接线:docs/methods/ 在但没有 yaml → 同样不查卡存在性', async ($, on) => {
    const { w } = await world(on, { files: { ...CFG_FILES, [`${CWD}/docs/methods/notes.md`]: 'x', [`${CWD}/docs/b.md`]: wiredBrief('no-such-card') } })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toBeUndefined()
    expect(w.bash.length).toBe(1)
  })
})

// F4-9(F6,docs/process/external-actions.md):仓配置一张对外动作策略表(push · 发信 · 部署 · 生产写 · 外部发帖),
// 默认 hold —— 任务书正文里写了某一类的命令就拒起,理由念出 class 与 why。只扫正文:frontmatter 里出现这个命令
// (比如「不许碰: git push」)不算;放行只认 frontmatter 的「对外动作已放行」键,正文里写「已放行」不算。
describe('F4-9 · 对外动作表(默认 hold)', () => {
  const PUSH: ExternalAction[] = [{ class: 'push', cmd: '\\bgit push\\b', paths: '', why: '推送远端' }]
  /** 一份别的 lint 全绿的前置式任务书:frontmatter 与正文各加几行。 */
  const brief = (front: string[] = [], body: string[] = []) =>
    [
      '---',
      '级别: L2',
      '允许改动: src/a.ts',
      '期望值已重算: 是',
      ...front,
      '---',
      '# x · 一片',
      '**原始目标原文(owner 18.10)**:「q」',
      '对外签名:无',
      '## 成功判据',
      '绿',
      ...body,
    ].join('\n')
  const wired = (table: ExternalAction[], text: string): Record<string, string> => ({
    [`${CWD}/.claude/delegate.json`]: JSON.stringify({ externalActions: table }),
    [`${CWD}/src/a.ts`]: '',
    [`${CWD}/docs/b.md`]: text,
  })

  test('接线:正文写了 git push → 拒起,理由念出 class、why 与那张表', async ($, on) => {
    const { w } = await world(on, { files: wired(PUSH, brief([], ['- 跑完后 git push origin main'])) })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toContain('对外动作(push)')
    expect(out.deny).toContain('推送远端')
    expect(out.deny).toContain('docs/process/external-actions.md')
    expect(w.bash.length).toBe(0)
  })

  test('接线:frontmatter 写了「对外动作已放行」→ 同一 class 不拒,任务书照起', async ($, on) => {
    const text = brief(['对外动作已放行: push owner 18.10'], ['- 跑完后 git push origin main'])
    const { w } = await world(on, { files: wired(PUSH, text) })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toBeUndefined()
    expect(w.bash.length).toBe(1)
  })

  test('接线:git push 只写在 frontmatter 的「不许碰」里 → 不拒(只扫正文)', async ($, on) => {
    const { w } = await world(on, { files: wired(PUSH, brief(['不许碰: git push'])) })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toBeUndefined()
    expect(w.bash.length).toBe(1)
  })

  test('接线:cmd 写成 "(" → 拒起并点名第几项(配错了宁可停,不悄悄放过)', async ($, on) => {
    const bad: ExternalAction[] = [{ class: 'push', cmd: '(', paths: '', why: '推送远端' }]
    const { w } = await world(on, { files: wired(bad, brief()) })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toContain('externalActions 第 0 项正则写错:')
    expect(w.bash.length).toBe(0)
  })

  // 放行键只在 frontmatter 里算 —— 同一句话写进正文不放行,不然「已放行」就成了任务书正文里的一句散文,
  // 谁都能给自己开一道口子。
  test('接线:同一句「对外动作已放行」写进正文 → 不放行,照旧拒起', async ($, on) => {
    const text = brief([], ['对外动作已放行: push owner 18.10', '- 跑完后 git push origin main'])
    const { w } = await world(on, { files: wired(PUSH, text) })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toContain('对外动作(push)')
    expect(w.bash.length).toBe(0)
  })

  // 键不是数组(写成字符串)当空表:没配表的仓行为不变,也不能让整个 judge 抛出去。对象那种形状 register 的
  // `?.length` 就挡住了,到不了这里。
  test('接线:键写成字符串而不是数组 → 当空表,不拒也不抛', async ($, on) => {
    const files = wired(PUSH, brief([], ['- 跑完后 git push origin main']))
    files[`${CWD}/.claude/delegate.json`] = JSON.stringify({ externalActions: '\\bgit push\\b' })
    const { w } = await world(on, { files })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toBeUndefined()
    expect(w.bash.length).toBe(1)
  })
})

describe('G-B 全角冒号', () => {
  test('「期望值:无」「对外签名:无」写成全角冒号也认', () => {
    const t = `原始目标原文(owner):x\n允许改动: a.ts\n## 成功判据\nok\n期望值：无\n对外签名：无\n`
    const gaps = briefGaps(t)
    expect(gaps.some(g => g.includes('已重算'))).toBe(false)
    expect(gaps.some(g => g.includes('对外签名'))).toBe(false)
  })
})

describe('delegate: S17 the wake never holds a hook (宁重复不丢)', () => {
  /** The turn boundary S17 waits for: whatever a turn held back goes out here. */
  const turnEnd = (turnId = 't1') => ({ answer: 'x', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)
  const CMDX = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } } as never
  const pendingOf = (store: Map<string, unknown>, sid = 'S1') => (store.get(`wake:${sid}`) as { pending: string[] } | undefined)?.pending

  test('S17-A: a run ends mid-turn and submit cannot land until the turn ends; a launch still gets its verdict within 3 s', async ($, on) => {
    const { w, clock } = await world(on, { runs: [run({ label: 'a1' })] })
    await $.session.start(start)
    await $.turn.start({ turnId: 't1' } as never)
    w.onSubmit = () => new Promise(() => undefined)
    w.runs = [run({ label: 'a1', state: 'pass' })]
    await clock.advance(2_000)
    const verdict = await Promise.race([bash($, launch('r9')).then(() => 'answered'), new Promise(res => setTimeout(() => res('timeout'), 3_000))])
    expect(verdict).toBe('answered')
  })

  test('S17-B: submit is rejected (a /clear in flight): pending stays, the next session start sends it', async ($, on) => {
    const store = new Map<string, unknown>()
    const { w, clock } = await world(on, { runs: [run({ label: 'b1' })] }, store)
    await $.session.start(start)
    w.onSubmit = () => Promise.reject(new Error('clear in progress'))
    w.runs = [run({ label: 'b1', state: 'fail' })]
    await clock.advance(2_000)
    expect((store.get('wake:S1') as { pending: string[] }).pending).toEqual(['b1'])
    w.onSubmit = undefined
    await $.session.start(start)
    await clock.advance(0)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]).toContain('b1')
    expect((store.get('wake:S1') as { pending: string[] }).pending).toEqual([])
  })

  // GWT-3: the send reached the lead but its resolve never came (the worker was rebuilt mid-submit, so its
  // memory of that send is gone). A duplicate is allowed, a loss is not: the book keeps c1, no boundary sends
  // over the one in flight, and when the resolve lands the label goes and nothing follows it.
  test('S17-C: a submit whose resolve never arrives keeps its label pending; nothing is sent twice, nothing is lost', async ($, on) => {
    const store = new Map<string, unknown>()
    const { w, clock } = await world(on, { runs: [run({ label: 'c1' })] }, store)
    await $.session.start(start)
    const sent: string[] = []
    let land: (() => void) | undefined
    w.onSubmit = text => { sent.push(text); return new Promise<unknown>(res => { land = () => res({ text }) }) }
    w.runs = [run({ label: 'c1', state: 'pass' })]
    await clock.advance(2_000)
    expect(sent.length).toBe(1)
    expect(pendingOf(store)).toEqual(['c1'])
    await $.turn.start({ turnId: 't2' } as never)
    await $.turn.complete(turnEnd('t2'))
    await $.turn.complete(turnEnd('t3'))
    await clock.advance(0)
    expect(sent.length).toBe(1)
    expect(pendingOf(store)).toEqual(['c1'])
    land?.()
    await clock.advance(0)
    expect(pendingOf(store)).toEqual([])
    await $.turn.complete(turnEnd('t4'))
    await clock.advance(0)
    expect(sent.length).toBe(1)
  })

  // GWT-4: a heartbeat refresh and the launch's own refresh both reach kick; one wake in flight, one submit.
  test('S17-D: two refreshes reach kick; prompt.submit is called once', async ($, on) => {
    const store = new Map<string, unknown>()
    const { w, clock } = await world(on, { runs: [run({ label: 'g1' })] }, store)
    await $.session.start(start)
    const sent: string[] = []
    w.onSubmit = text => { sent.push(text); return new Promise(() => undefined) }
    w.runs = [run({ label: 'g1', state: 'pass' })]
    await clock.advance(2_000)
    expect(sent.length).toBe(1)
    const judged = await bash($, launch('r9'))
    await clock.advance(2_000)
    expect(judged.deny).toBeUndefined()
    expect(sent.length).toBe(1)
    expect(pendingOf(store)).toEqual(['g1'])
  })

  // GWT-5: the book cannot be read. Nothing is sent, nothing is rewritten, and the lead is told once.
  test('S17-E: store.get(wake:S1) throws: no submit, the book is left as it was, one toast says so', async ($, on) => {
    const store = new Map<string, unknown>()
    const { w, clock } = await world(on, { runs: [run({ label: 'd1' })] }, store)
    await $.session.start(start)
    const before = JSON.parse(JSON.stringify(store.get('wake:S1'))) as unknown
    w.storeGetFails = key => key === 'wake:S1'
    w.runs = [run({ label: 'd1', state: 'pass' })]
    await clock.advance(2_000)
    expect(w.submits.length).toBe(0)
    expect(JSON.parse(JSON.stringify(store.get('wake:S1')))).toEqual(before)
    expect(w.toasts.filter(t => t.includes('账本读不到')).length).toBe(1)
  })

  // GWT-6: with a run still going the 60 s window holds and then sends one note.
  test('S17-F: the 60 s window holds while a run is live, then sends one note', async ($, on) => {
    const store = new Map<string, unknown>()
    const { w, clock } = await world(on, { runs: [run({ label: 'e1' }), run({ label: 'g1' })] }, store)
    await $.session.start(start)
    w.runs = [run({ label: 'e1', state: 'pass' }), run({ label: 'g1' })]
    await clock.advance(2_000)
    expect(w.submits.length).toBe(0)
    await clock.advance(60_000)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]).toContain('- e1 · pass')
    expect(pendingOf(store)).toEqual([])
  })

  // GWT-1, measured at the seam itself: /runs only awaits refresh. With the submit hanging it must still answer
  // (02:44 shape: nothing left running, so noteEnded kicks the wake straight away).
  test('S17-A2: nothing running, submit hangs: /runs (await refresh) answers within 3 s', async ($, on) => {
    const { w, clock } = await world(on, { runs: [run({ label: 'p1' })] })
    await $.session.start(start)
    w.onSubmit = () => new Promise(() => undefined)
    w.runs = [run({ label: 'p1', state: 'pass' })]
    await clock.advance(2_000)
    const r = await Promise.race([$.command.run({ command: 'runs', args: '', ...CMDX }).then(() => 'answered'), new Promise(res => setTimeout(() => res('timeout'), 3_000))])
    expect(r).toBe('answered')
  })

  // GWT-1, timer shape: the window fires with a run still live; the submit from the timer hangs; refresh is not held.
  test('S17-A3: the window fires, submit hangs: /runs and a launch both answer within 3 s', async ($, on) => {
    const { w, clock } = await world(on, { runs: [run({ label: 'q1' }), run({ label: 'q2' })] })
    await $.session.start(start)
    const sent: string[] = []
    w.onSubmit = text => { sent.push(text); return new Promise(() => undefined) }
    w.runs = [run({ label: 'q1', state: 'pass' }), run({ label: 'q2' })]
    await clock.advance(62_000)
    expect(sent.length).toBe(1)
    const r = await Promise.race([$.command.run({ command: 'runs', args: '', ...CMDX }).then(() => bash($, launch('r9'))).then(() => 'answered'), new Promise(res => setTimeout(() => res('timeout'), 3_000))])
    expect(r).toBe('answered')
  })

  // A run that ends while the first wake is still in flight is not lost: once that submit lands, the next tick sends it.
  test('S17-L: a second run ends while the first submit is in flight; it goes out after the first lands', async ($, on) => {
    const store = new Map<string, unknown>()
    const { w, clock } = await world(on, { runs: [run({ label: 'u1' }), run({ label: 'u2' })] }, store)
    await $.session.start(start)
    const sent: string[] = []
    let land: (() => void) | undefined
    w.onSubmit = text => { sent.push(text); return new Promise<unknown>(res => { land = () => res({ text }) }) }
    w.runs = [run({ label: 'u1', state: 'pass' }), run({ label: 'u2' })]
    await clock.advance(62_000)
    expect(sent.length).toBe(1)
    w.runs = [run({ label: 'u1', state: 'pass' }), run({ label: 'u2', state: 'interrupted' })]
    await clock.advance(2_000)
    expect(sent.length).toBe(1)
    expect(pendingOf(store)).toEqual(['u1', 'u2'])
    land?.()
    await clock.advance(10_000)
    expect(sent.length).toBe(2)
    expect(sent[1]).toContain('u2')
    expect(sent[1]).not.toContain('- u1 ·')
  })

  // GWT-8: a pending label whose run dir is gone sends nothing alone, and goes out with the next note.
  test('S17-K: a pending label the scan cannot name does not block the next wake', async ($, on) => {
    const store = new Map<string, unknown>([['wake:S1', { known: { n1: 'running' }, pending: ['gone'], at: T0, prior: [] }]])
    const { w, clock } = await world(on, { runs: [run({ label: 'n1' })] }, store)
    await $.session.start(start)
    await clock.advance(2_000)
    expect(w.submits.length).toBe(0)
    expect(pendingOf(store)).toEqual(['gone'])
    w.runs = [run({ label: 'n1', state: 'pass' })]
    await clock.advance(2_000)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]).toContain('- n1 · pass')
    expect(pendingOf(store)).toEqual([])
  })

  // GWT-3: the worker reopened after the first submit landed but before pending was cleared. The new load finds the
  // label still pending and sends it once more (the second and last copy); after that lands nothing goes out again.
  test('S17-J: a reload between a landed submit and the clear: one more copy, then none', async ($, on) => {
    const store = new Map<string, unknown>([['wake:S1', { known: { c1: 'pass' }, pending: ['c1'], at: T0, prior: [] }]])
    const { w, clock } = await world(on, { runs: [run({ label: 'c1', state: 'pass' })] }, store)
    await $.session.start(start)
    await clock.advance(0)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]).toContain('- c1 · pass')
    expect(pendingOf(store)).toEqual([])
    await $.turn.start({ turnId: 't1' } as never)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(10_000)
    expect(w.submits.length).toBe(1)
  })

  // GWT-7: /clear moves the book (pending and all) to the new id, and the kick after that refresh sends it.
  test('S17-G: a refused submit under /clear: the book moves to the new session and that refresh sends it', async ($, on) => {
    const store = new Map<string, unknown>()
    const { w, clock } = await world(on, { runs: [run({ label: 'f1' })] }, store)
    on('classic.SessionStart', () => ({}) as never)
    await $.session.start(start)
    w.onSubmit = () => Promise.reject(new Error('clear in progress'))
    w.runs = [run({ label: 'f1', state: 'pass' })]
    await clock.advance(2_000)
    expect(w.submits.length).toBe(0)
    expect(pendingOf(store)).toEqual(['f1'])
    w.onSubmit = undefined
    w.sid = 'S2'
    await $.classic.SessionStart(sessionStart('clear', 'S2'))
    await clock.advance(2_000)
    expect(store.get('wake:S1')).toBeUndefined()
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]).toContain('f1')
    expect(pendingOf(store, 'S2')).toEqual([])
  })
})
