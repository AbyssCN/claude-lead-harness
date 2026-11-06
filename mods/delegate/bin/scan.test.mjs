// node --test bin/scan.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { allowedFromBrief, isAlive, isRunnerCmdline, scan, scanAll, scanOrphans } from './scan.mjs'

// A live process that reads as an omd-lite driver, and a pid that is surely dead.
const driver = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', 'omd-lite'], { stdio: 'ignore' })
after(() => driver.kill())
const LIVE = driver.pid
const DEAD = 2 ** 22 - 3

const json = o => JSON.stringify(o)
const piEnd = (stopReason, errorMessage) =>
  json({ type: 'agent_end', messages: [{ role: 'assistant', stopReason, ...(errorMessage ? { errorMessage } : {}) }] })

function fixture(runs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-scan-'))
  for (const [label, meta, files = {}] of runs) {
    const dir = path.join(root, label)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'meta.json'), json({ label, claude_session: 'S1', max_rounds: 4, start_epoch: 100, ...meta }))
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
      fs.writeFileSync(path.join(dir, name), text)
    }
  }
  return root
}
const byLabel = root => Object.fromEntries(scan('S1', root).map(r => [r.label, r]))

test('only runs launched from the given session', () => {
  const root = fixture([
    ['mine', { driver_pid: LIVE }],
    ['other', { claude_session: 'S2', driver_pid: LIVE }],
  ])
  assert.deepEqual(scan('S1', root).map(r => r.label), ['mine'])
  assert.deepEqual(scan('', root), [])
})

test('G-5: scanAll lists every session\'s runs, and runs with no claude_session; scan stays this session\'s', () => {
  const root = fixture([
    ['mine', { driver_pid: LIVE }],
    ['other', { claude_session: 'S2', driver_pid: LIVE }],
    ['queued', { claude_session: undefined, driver_pid: LIVE }],
  ])
  assert.deepEqual(scanAll(root).map(r => r.label).sort(), ['mine', 'other', 'queued'])
  assert.deepEqual(scan('S1', root).map(r => r.label), ['mine'])
  const other = scanAll(root).find(r => r.label === 'other')
  assert.equal(other.state, 'running')
  assert.equal(other.claudeSession, 'S2')
})

test('G-5: scanAll skips run dirs untouched for over two days and dirs without a meta.json; oldest first', () => {
  const root = fixture([
    ['b-late', { start_epoch: 300, driver_pid: LIVE }],
    ['a-early', { start_epoch: 200, claude_session: 'S9', driver_pid: LIVE }],
    ['stale', { driver_pid: LIVE }],
  ])
  fs.mkdirSync(path.join(root, 'no-meta'))
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  fs.utimesSync(path.join(root, 'stale'), old, old)
  assert.deepEqual(scanAll(root).map(r => r.label), ['a-early', 'b-late'])
  assert.deepEqual(scanAll(path.join(root, 'nope')), [])
})

test('G-1: a list of session ids (the lineage across /clear) finds the runs of each', () => {
  const root = fixture([
    ['old', { claude_session: 'S0', driver_pid: LIVE }],
    ['new', { claude_session: 'S1', driver_pid: LIVE }],
    ['other', { claude_session: 'S2', driver_pid: LIVE }],
  ])
  assert.deepEqual(scan('S1,S0', root).map(r => r.label).sort(), ['new', 'old'])
  assert.deepEqual(scan(['S1', 'S0'], root).map(r => r.label).sort(), ['new', 'old'])
  assert.deepEqual(scan('S1', root).map(r => r.label), ['new'])
  assert.deepEqual(scan(' , ', root), [])
})

test('GWT-7: result.json without wall_seconds is still running', () => {
  const root = fixture([['early', { driver_pid: LIVE, executor: 'mcode' }, { 'result.json': json({ gates: 'pass', round: 1 }) }]])
  const r = byLabel(root).early
  assert.equal(r.state, 'running')
  assert.equal(r.failureClass, undefined)
  assert.equal(r.wallSeconds, undefined)
})

test('ended: wall_seconds set → pass / fail / not-run from result.json', () => {
  const root = fixture([
    ['ok', { driver_pid: DEAD, wall_seconds: 50, end_epoch: 150 }, { 'result.json': json({ gates: 'pass', round: 1, outside: [] }), 'diffstat.txt': ' a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n' }],
    ['red', { driver_pid: DEAD, wall_seconds: 60, executor: 'mcode' }, {
      'result.json': json({ gates: 'fail', round: 2, failed_gate: 'npx tsc', exit: 1, outside: ['src/x.ts'] }),
      'gate-round-2.log': Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n\n',
      'mcode-round-2.jsonl': json({ type: 'exec.completed', result: { status: 'succeeded' } }),
    }],
    ['nr', { driver_pid: DEAD, wall_seconds: 3 }, { 'result.json': json({ gates: 'not-run', pi_exit: 1 }) }],
  ])
  const runs = byLabel(root)
  assert.equal(runs.ok.state, 'pass')
  assert.equal(runs.ok.wallSeconds, 50)
  assert.equal(runs.ok.endedAt, 150_000)
  assert.equal(runs.ok.diffstat, '1 file changed, 1 insertion(+), 1 deletion(-)')
  assert.equal(runs.red.state, 'fail')
  assert.equal(runs.red.failureClass, 'gate')
  assert.equal(runs.red.round, 2)
  assert.deepEqual(runs.red.outside, ['src/x.ts'])
  assert.equal(runs.red.gateTail.length, 20)
  assert.equal(runs.red.gateTail.at(-1), 'line 29')
  assert.equal(runs.nr.state, 'not-run')
})

test('interrupted: no result and the driver is dead', () => {
  const root = fixture([['gone', { driver_pid: DEAD }]])
  const r = byLabel(root).gone
  assert.equal(r.state, 'interrupted')
  assert.equal(r.failureClass, 'interrupted')
})

test('provider failures: pi agent_end 529 / 2056, fallback stream, mcode 502', () => {
  const root = fixture([
    ['p529', { driver_pid: DEAD, wall_seconds: 9, model: 'minimax-cp/MiniMax-M3.1' }, {
      'result.json': json({ gates: 'not-run', pi_exit: 1 }),
      'pi.jsonl': [piEnd('stop'), piEnd('error', '529: {"type":"overloaded_error"}')].join('\n'),
    }],
    ['p2056', { driver_pid: DEAD, wall_seconds: 9 }, {
      'result.json': json({ gates: 'not-run' }),
      'pi.jsonl': piEnd('stop'),
      'fallback/pi.jsonl': piEnd('error', '429: 已达到 Token Plan 用量上限 (2056)'),
    }],
    ['raw529', { driver_pid: DEAD, wall_seconds: 9 }, { 'result.json': json({ gates: 'fail', round: 1, failed_gate: 'x' }), 'pi.jsonl': piEnd('529') }],
    ['m502', { driver_pid: DEAD, wall_seconds: 9, executor: 'mcode' }, {
      'result.json': json({ gates: 'not-run', error: 'exec failed' }),
      'mcode-round-1.jsonl': json({ type: 'exec.completed', result: { status: 'failed', error: { message: '502 Bad Gateway' } } }),
    }],
    ['notprov', { driver_pid: DEAD, wall_seconds: 9 }, { 'result.json': json({ gates: 'fail', round: 4, failed_gate: 'tsc', stuck: 'stuck-gate' }), 'pi.jsonl': piEnd('stop') }],
  ])
  const runs = byLabel(root)
  assert.equal(runs.p529.failureClass, 'provider')
  assert.equal(runs.p529.executor, 'minimax')
  assert.equal(runs.p2056.failureClass, 'provider')
  assert.equal(runs.raw529.failureClass, 'provider')
  assert.equal(runs.m502.failureClass, 'provider')
  assert.equal(runs.notprov.failureClass, 'stuck-gate')
  assert.equal(runs.notprov.stuck, 'stuck-gate')
})

test('a running pi run: tool in flight; the brief\'s allowed paths come from the worktree', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-wt-'))
  fs.mkdirSync(path.join(wt, 'docs'))
  fs.writeFileSync(path.join(wt, 'docs/b.md'), '# x\n**允许改动:** `src/a.ts` src/b/ src/new.ts(新建)\n')
  const root = fixture([['live', { driver_pid: LIVE, worktree: wt, spec: 'docs/b.md' }, {
    'pi.jsonl': json({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'npx  tsc' } }),
  }]])
  const r = byLabel(root).live
  assert.equal(r.state, 'running')
  assert.equal(r.tool, 'bash: npx tsc')
  assert.deepEqual(r.allowed, ['src/a.ts', 'src/b/', 'src/new.ts'])
})

test('allowedFromBrief: plain, bold, absent', () => {
  assert.deepEqual(allowedFromBrief('允许改动: a.ts、b.ts, c/'), ['a.ts', 'b.ts', 'c/'])
  assert.deepEqual(allowedFromBrief('**允许改动:** x.ts (新建) y.ts'), ['x.ts', 'y.ts'])
  assert.equal(allowedFromBrief('no line'), null)
})

// G-3: runs that died with no result.json, from any session.
test('G-3: orphans = driver dead, no result, no wall_seconds, worktree there, not resumed; any session', () => {
  const wt = name => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `delegate-wt-${name}-`))
    return d
  }
  const w = { dead: wt('dead'), other: wt('other'), live: wt('live'), res: wt('res'), done: wt('done'), ended: wt('ended'), resumed: wt('resumed') }
  const now = Date.now()
  const base = { driver_pid: DEAD, start_epoch: Math.floor(now / 1000) - 3600, repo: '/r/myapp', base: 'main', base_sha: 'abc123', spec: 'docs/b.md', prompt_arm: 'omd-leaf', gates: ['true'], max_rounds: 3, model: 'minimax-cp/M', executor: 'pi', context: true }
  const root = fixture([
    ['dead', { ...base, worktree: w.dead, branch: 'omdl/dead', role: 'worker' }],
    ['other-session', { ...base, claude_session: 'S9', worktree: w.other, context: false }],
    ['live', { ...base, driver_pid: LIVE, worktree: w.live }],
    ['has-result', { ...base, worktree: w.res }, { 'result.json': json({ gates: 'fail' }) }],
    ['ended', { ...base, worktree: w.ended, wall_seconds: 99 }],
    ['no-worktree', { ...base, worktree: '/nonexistent/wt' }],
    ['no-pid', { ...base, driver_pid: undefined, worktree: w.done }],
    ['old', { ...base, start_epoch: Math.floor(now / 1000) - 8 * 24 * 3600, worktree: w.done }],
    ['resumed', { ...base, worktree: w.resumed }],
    ['resumed-r2', { ...base, driver_pid: LIVE, worktree: w.resumed, resumedFrom: 'resumed' }],
  ])
  const got = scanOrphans(root, now)
  assert.deepEqual(got.map(o => o.label).sort(), ['dead', 'other-session'])
  const dead = got.find(o => o.label === 'dead')
  assert.equal(dead.worktree, w.dead)
  assert.equal(dead.base, 'abc123')
  assert.equal(dead.role, 'worker')
  assert.deepEqual(dead.gates, ['true'])
  assert.equal(got.find(o => o.label === 'other-session').context, false)
  assert.deepEqual(scanOrphans(path.join(root, 'nope')), [])
})

test('G-3: a <label>-rN dir (even a failed one) also marks the run as taken up', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-wt-'))
  const base = { driver_pid: DEAD, start_epoch: Math.floor(Date.now() / 1000) - 60, worktree: wt }
  const root = fixture([['a', base], ['a-r2', { ...base, driver_pid: DEAD }, { 'result.json': json({ gates: 'fail' }) }], ['b', base], ['b-rx', base]])
  assert.deepEqual(scanOrphans(root).map(o => o.label).sort(), ['b', 'b-rx'])
})

// G-4: piw's own failureClass / failedCoords (meta.json, result.json), kept apart from C-0's failureClass
test('G-4: an ended run reports piw\'s failureClass and failedCoords, with a launch recipe only for quota / stream', () => {
  const launchMeta = { repo: '/r/p', base_sha: 'abc123', base: 'main', worktree: '/r/omdl-q', branch: 'omdl/q', spec: 'docs/b.md', prompt_arm: 'omd-leaf', gates: ['true'], context: true, role: 'worker' }
  const root = fixture([
    ['q', { ...launchMeta, driver_pid: DEAD, wall_seconds: 30, failureClass: 'quota', failedCoords: ['a/m1', 'b/m2'] }, { 'result.json': json({ gates: 'not-run', pi_exit: 1, failureClass: 'quota', failedCoords: ['a/m1', 'b/m2'] }) }],
    ['s', { ...launchMeta, driver_pid: DEAD, wall_seconds: 30 }, { 'result.json': json({ gates: 'not-run', failureClass: 'stream', failedCoords: ['a/m1'] }) }],
    ['g', { ...launchMeta, driver_pid: DEAD, wall_seconds: 30, failureClass: 'gate', failedCoords: [] }, { 'result.json': json({ gates: 'fail', round: 3, failed_gate: 'npx tsc', failureClass: 'gate', failedCoords: [] }) }],
    ['rq', { ...launchMeta, driver_pid: DEAD, wall_seconds: 30, failureClass: 'request', failedCoords: ['a/m1'] }, { 'result.json': json({ gates: 'not-run', failureClass: 'request' }) }],
    ['ok', { ...launchMeta, driver_pid: DEAD, wall_seconds: 30, failureClass: null, failedCoords: [] }, { 'result.json': json({ gates: 'pass', round: 1 }) }],
    ['old', { ...launchMeta, driver_pid: DEAD, wall_seconds: 30 }, { 'result.json': json({ gates: 'not-run' }) }],
    ['live', { ...launchMeta, driver_pid: LIVE, failureClass: 'quota', failedCoords: ['a/m1'] }],
  ])
  const runs = byLabel(root)
  assert.equal(runs.q.piwFailure, 'quota')
  assert.deepEqual(runs.q.failedCoords, ['a/m1', 'b/m2'])
  assert.equal(runs.q.claudeSession, 'S1')
  assert.deepEqual(runs.q.launch, { repo: '/r/p', base: 'abc123', worktree: '/r/omdl-q', branch: 'omdl/q', spec: 'docs/b.md', prompt: 'omd-leaf', gates: ['true'], maxRounds: 4, role: 'worker', context: true, claudeSession: 'S1' })
  // meta.json lacking it: result.json answers
  assert.equal(runs.s.piwFailure, 'stream')
  assert.deepEqual(runs.s.failedCoords, ['a/m1'])
  assert.ok(runs.s.launch)
  // gate / request / pass / nothing recorded: the class is reported (or absent), no recipe to start again
  assert.equal(runs.g.piwFailure, 'gate')
  assert.equal(runs.g.launch, undefined)
  assert.equal(runs.g.failedCoords, undefined)
  assert.equal(runs.rq.piwFailure, 'request')
  assert.equal(runs.rq.launch, undefined)
  assert.equal(runs.ok.piwFailure, undefined)
  assert.equal(runs.old.piwFailure, undefined)
  // a run still going reports nothing, whatever the file says
  assert.equal(runs.live.state, 'running')
  assert.equal(runs.live.piwFailure, undefined)
  assert.equal(runs.live.launch, undefined)
  // C-0's own failureClass is not touched by piw's
  assert.equal(runs.q.failureClass, 'not-run')
  assert.equal(runs.g.failureClass, 'gate')
})

test('G-4: the orphans list is unchanged by sharing the launch recipe', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-wt-'))
  const now = 200_000
  const root = fixture([['d', { repo: '/r/p', base_sha: 'abc', worktree: wt, branch: 'omdl/d', spec: 's.md', prompt_arm: 'minimal', gates: ['g'], driver_pid: DEAD, role: 'worker', context: false, start_epoch: 100 }]])
  assert.deepEqual(scanOrphans(root, now).map(({ startedAt: _, ...o }) => o), [
    { label: 'd', repo: '/r/p', base: 'abc', worktree: wt, branch: 'omdl/d', spec: 's.md', prompt: 'minimal', gates: ['g'], maxRounds: 4, role: 'worker', context: false, claudeSession: 'S1' },
  ])
})

// ── S11: omd-lite is now piw. isAlive reads /proc/<pid>/cmdline; a fixture stands in for /proc (the plugin-test sandbox
// cannot import node:fs, so this lives here and not in hooks/delegate.test.ts).
const NUL = '\0'
const alive = argv => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-proc-'))
  try {
    // this very process, so the kill(pid, 0) probe passes; only the cmdline differs
    fs.mkdirSync(path.join(root, String(process.pid)))
    fs.writeFileSync(path.join(root, String(process.pid), 'cmdline'), argv.join(NUL) + NUL)
    return isAlive(process.pid, { procRoot: root })
  } finally {
    fs.rmSync(root, { recursive: true })
  }
}

test('S11 isAlive: node /home/user/repos/piw/bin/piw run … is alive', () => {
  assert.equal(alive(['node', '/home/user/repos/piw/bin/piw', 'run', '--repo', '/r/myapp', '--name', 'a1']), true)
})
test('S11 isAlive: node …/omd-lite run … is alive', () => {
  assert.equal(alive(['node', '/home/user/repos/omd-lite/bin/omd-lite', 'run', '--repo', '/r/myapp', '--name', 'a1']), true)
})
test('S11 isAlive: the old directory through the new file name (and the reverse) is alive', () => {
  assert.equal(alive(['node', '/home/user/repos/omd-lite/bin/piw', 'run']), true)
  assert.equal(alive(['node', '/home/user/repos/piw/bin/omd-lite', 'run']), true)
})
test('S11 isAlive: a reused pid that is someone else is not alive', () => {
  assert.equal(alive(['sleep', '30']), false)
  assert.equal(alive(['node', '/home/user/repos/piw/lib/other.js']), false)
  assert.equal(alive(['node', '/home/user/repos/hippiw/bin/hippiw', 'run']), false)
})
test('S11 isAlive: a dead pid is not alive; no /proc to read (macOS) trusts the signal check', () => {
  assert.equal(isAlive(DEAD, { procRoot: '/nonexistent-proc-root' }), false)
  assert.equal(isAlive(process.pid, { procRoot: '/nonexistent-proc-root' }), true)
  assert.equal(isAlive(0), false)
})
test('S11 isAlive: the real /proc — the live omd-lite-argv driver of this file is alive, with the default names', () => {
  assert.equal(isAlive(LIVE), true)
})
test('S11 isRunnerCmdline: custom names replace the defaults', () => {
  assert.equal(isRunnerCmdline(['node', '/x/bin/worker', 'run'].join(NUL), ['worker']), true)
  assert.equal(isRunnerCmdline(['node', '/x/bin/piw', 'run'].join(NUL), ['worker']), false)
})
test('S11: a real process whose argv is the piw driver keeps its run "running" in a scan (real /proc)', async () => {
  const piwDriver = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', '/home/user/repos/piw/bin/piw', 'run'], { stdio: 'ignore' })
  try {
    await new Promise(r => setTimeout(r, 200))
    assert.equal(isAlive(piwDriver.pid), true)
    const root = fixture([['r-new', { driver_pid: piwDriver.pid }]])
    assert.equal(byLabel(root)['r-new'].state, 'running')
  } finally {
    piwDriver.kill()
  }
})

test('piUsage sums assistant message_end usage and reads only new bytes', async () => {
  const { piUsage } = await import('./scan.mjs')
  const piTokens = (...a) => piUsage(...a).tokens
  const fsm = await import('node:fs')
  const osm = await import('node:os')
  const pathm = await import('node:path')
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'pitok-'))
  const f = pathm.join(dir, 'pi.jsonl')
  const end = (n, role = 'assistant') => JSON.stringify({ type: 'message_end', message: { role, usage: { totalTokens: n } } }) + '\n'
  fsm.writeFileSync(f, end(100) + JSON.stringify({ type: 'message_update', message: { role: 'assistant', usage: { totalTokens: 999 } } }) + '\n' + end(5, 'user'))
  assert.equal(piTokens(f, 'k', dir), 100)
  fsm.appendFileSync(f, end(40) + '{"type":"message_end","mess')
  assert.equal(piTokens(f, 'k', dir), 140, 'a half-written last line waits for the next scan')
  fsm.appendFileSync(f, 'age":{"role":"assistant","usage":{"totalTokens":2}}}\n')
  assert.equal(piTokens(f, 'k', dir), 142)
})

test('a pi run that fell back counts the main log and the fallback log', () => {
  const end = (n, usd) => json({ type: 'message_end', message: { role: 'assistant', usage: { totalTokens: n, cost: { total: usd } } } })
  const label = `fb-${process.pid}-${Date.now()}`
  const root = fixture([[label, { driver_pid: LIVE, executor: 'pi' }, { 'pi.jsonl': `${end(500, 0)}\n`, 'fallback/pi.jsonl': `${end(70, 0.004)}\n` }]])
  assert.equal(byLabel(root)[label].tokens, 570, 'main 500 + fallback 70, not the fallback alone')
  assert.equal(byLabel(root)[label].costUsd, 0.004, 'dollars from the usage lines')
  const free = `free-${process.pid}-${Date.now()}`
  const root2 = fixture([[free, { driver_pid: LIVE, executor: 'pi' }, { 'pi.jsonl': `${end(500, 0)}\n` }]])
  assert.equal(byLabel(root2)[free].costUsd, undefined, 'a subscription run reports no cost, not $0')
})
