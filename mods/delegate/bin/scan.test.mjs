// node --test bin/scan.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { allowedFromBrief, scan } from './scan.mjs'

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
