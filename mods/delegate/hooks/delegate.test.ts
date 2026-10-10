// claude plugin test <path-to>/mods/delegate
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { ScanRun } from './logic'
import { findLaunches, findMerges, fullGatesVerdict, layerGatesFor, overlap, rewriteLaunches, runsSliceGate, tokenize, wakeText } from './logic'

const T0 = 1_800_000_000_000
const CWD = '/r/app'
const GOOD_BRIEF = [
  '# s1 · 一句目标(MiniMax 任务书)',
  '**原始目标原文(owner)**:「性能优先」',
  '**允许改动:** src/a.ts src/b.ts src/new.ts(新建) src/a.test.ts',
  '## 成功判据',
  '`scripts/dev/gate-slice.sh main` 绿',
].join('\n')

const run = (over: Partial<ScanRun> = {}): ScanRun => ({
  label: 'r1',
  runDir: '/h/t/.omd-lite/runs/r1',
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
  git?: (argv: string[]) => string
}

async function world(on: On, over: Partial<World> = {}, store: Record<string, unknown> = {}) {
  const w: World = {
    runs: [],
    files: { [`${CWD}/docs/b.md`]: GOOD_BRIEF, [`${CWD}/src/a.ts`]: '', [`${CWD}/src/b.ts`]: '' },
    usedKB: 10 * 1048576,
    freeKB: 300 * 1048576,
    bash: [],
    submits: [],
    argv: [],
    ...over,
  }
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, store)
  mock.env(on, { HOME: '/h/t' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: { isShown: true } }) as never)
  on('fs.exists', (_, e) => ({ value: e.path in w.files }))
  on('fs.read', (_, e) => {
    const text = w.files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    w.argv.push(argv)
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (String(argv[1]).endsWith('/bin/scan.mjs')) return ok(JSON.stringify(w.runs))
    if (argv[0] === 'sh') return ok(`${w.usedKB}\n${w.freeKB}\n`)
    if (argv[0] === 'git' && w.git) return ok(w.git(argv))
    return ok()
  })
  on('prompt.submit', (_, e) => {
    w.submits.push(e.text)
    return { text: e.text }
  })
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    w.bash.push(String(e.command))
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  })
  return { w, clock }
}

const start = { cwd: CWD, surface: 'terminal', isInteractive: true } as const
const launch = (name = 'r9', extra = '') =>
  `cd ${CWD} && nohup /opt/omd-lite/bin/omd-lite run --repo ${CWD} --base main --spec docs/b.md --model m --prompt omd-leaf --gate "scripts/dev/gate-slice.sh main" --name ${name}${extra} > /tmp/${name}.log 2>&1 &`

async function bash($: Engine, command: string) {
  return $.tool.call({ tool: 'Bash', command })
}

// A consumer, as savvy-progress or relay would be: it reads `$.delegate.runs()` and answers /peek with it.
const consumer = {
  name: 'consumer',
  register(on: On) {
    on('command.run', { command: 'peek' }, async $ => ({ text: JSON.stringify(await $.delegate.runs()) }))
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
})

describe('delegate: the launch guard', () => {
  test('a good launch passes, its gates wrapped in gate-slot.sh (C-5)', async ($, on) => {
    const { w } = await world(on)
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toBeUndefined()
    expect(w.bash.length).toBe(1)
    expect(w.bash[0]).toContain(`/bin/gate-slot.sh 'scripts/dev/gate-slice.sh main'`)
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

  test('GWT-8: overlapping 允许改动 with a running run is refused, naming the path', async ($, on) => {
    const { w } = await world(on, { runs: [run({ label: 'busy', allowed: ['src/a.ts', 'lib/'] })] })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toContain('src/a.ts')
    expect(out.deny).toContain('busy')
    expect(w.bash.length).toBe(0)
  })

  test('GWT-9: a launch 30 s after the last is refused at the configured 60 s spacing', { options: { launchSpacingSeconds: 60 } }, async ($, on) => {
    const { w } = await world(on, {}, { lastLaunchAt: T0 - 30_000 })
    await $.session.start(start)
    const out = await bash($, launch())
    expect(out.deny).toContain('60 s')
    expect(w.bash.length).toBe(0)
  })

  test('spacing: the default 10 s lets a launch 30 s later through, and records it', async ($, on) => {
    const { w, clock } = await world(on, {}, { lastLaunchAt: T0 - 30_000 })
    await $.session.start(start)
    expect((await bash($, launch())).deny).toBeUndefined()
    await clock.advance(5_000)
    const again = await bash($, launch('r10'))
    expect(again.deny).toContain('10 s')
    expect(w.bash.length).toBe(1)
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
    w.files['/h/t/.omd-lite/runs/m1/meta.json'] = JSON.stringify({ repo: CWD, worktree: '/r/omdl-m1', branch: 'omdl/m1' })
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

  test('rewrite: quoting survives, idempotent, config defaults filled', () => {
    const cmd = `omd-lite run --spec s.md --gate 'a "b" $X' --name n`
    const ls = findLaunches(cmd)
    const out = rewriteLaunches(cmd, ls, '/p/gate-slot.sh', { executor: 'mcode', envFile: '/e/.env' })
    expect(out).toContain('env OMD_LITE_ENV_FILE=/e/.env omd-lite run --executor mcode')
    const again = findLaunches(out)
    expect(again[0]?.gates[0]?.value).toBe(`/p/gate-slot.sh 'a "b" $X'`)
    expect(rewriteLaunches(out, again, '/p/gate-slot.sh')).toBe(out)
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
