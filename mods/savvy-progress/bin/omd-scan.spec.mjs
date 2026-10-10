// node --test bin/omd-scan.spec.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test, { after } from 'node:test'

import { scan } from './omd-scan.mjs'

// A live process that reads as an omd-lite driver.
const driver = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', 'omd-lite'], { stdio: 'ignore' })
after(() => driver.kill())
const PID = driver.pid

const ev = (type, extra = {}) => JSON.stringify({ schemaVersion: 1, timestampMs: 1, type, ...extra })
const tool = (name, input) => [
  ev('item.started', { item: { id: name, type: 'tool_call', toolCall: { name, input } } }),
  ev('item.completed', { item: { id: name, type: 'tool_call', toolCall: { name, input, status: 2 } } }),
]

function fixture(runs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-scan-'))
  for (const [label, meta, files = {}] of runs) {
    const dir = path.join(root, label)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ label, max_rounds: 4, start_epoch: 100, ...meta }))
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
  }
  return root
}

test('only runs launched from the given session', () => {
  const root = fixture([
    ['mine', { claude_session: 'S1', executor: 'mcode', driver_pid: PID }],
    ['other', { claude_session: 'S2', executor: 'mcode', driver_pid: PID }],
    ['old', { executor: 'mcode' }],
  ])
  assert.deepEqual(scan('S1', root).map(r => r.label), ['mine'])
  assert.deepEqual(scan('', root), [])
})

test('a running mcode round: tool calls, the tool in flight, round and phase', () => {
  const round1 = [ev('exec.started'), ...tool('read', { path: 'a.md' }), ev('turn.completed', { usage: { inputTokens: 100, outputTokens: 10 }, model: { modelId: 'MiniMax-M3.1' } }), ev('exec.completed', { result: { status: 'succeeded' } })]
  const round2 = [ev('exec.started'), ...tool('bash', { command: 'npx   tsc --noEmit' }), tool('edit', { path: 'b.ts' })[0]]
  const root = fixture([
    ['r', { claude_session: 'S1', executor: 'mcode', driver_pid: PID }, {
      'mcode-round-1.jsonl': round1.join('\n'),
      'gate-round-1.log': '### $ tsc\n### exit=1\n',
      'mcode-round-2.jsonl': round2.join('\n'),
    }],
  ])
  const [r] = scan('S1', root)
  assert.equal(r.status, 'running')
  assert.equal(r.round, 2)
  assert.equal(r.phase, 'exec')
  assert.equal(r.toolCalls, 2)
  assert.equal(r.lastTool, 'edit: b.ts')
  assert.equal(r.tokens, 110)
})

test('a finished round without its gate log is at the gates', () => {
  const root = fixture([
    ['r', { claude_session: 'S1', executor: 'mcode', driver_pid: PID }, {
      'mcode-round-1.jsonl': [ev('exec.started'), ev('exec.completed', { result: { status: 'succeeded' } })].join('\n'),
    }],
  ])
  assert.equal(scan('S1', root)[0].phase, 'gate')
})

test('result.json decides; a dead driver without one is interrupted', () => {
  const root = fixture([
    ['pass', { claude_session: 'S1', executor: 'mcode', driver_pid: PID, end_epoch: 200 }, { 'result.json': '{"gates":"pass","round":1}' }],
    ['stuck', { claude_session: 'S1', executor: 'mcode', driver_pid: PID, end_epoch: 300 }, { 'result.json': '{"gates":"fail","stuck":"stuck-gate"}' }],
    ['dead', { claude_session: 'S1', executor: 'mcode', driver_pid: 2 ** 22 + 7 }],
  ])
  const by = Object.fromEntries(scan('S1', root).map(r => [r.label, r]))
  assert.equal(by.pass.status, 'done')
  assert.equal(by.pass.endedAt, 200_000)
  assert.equal(by.stuck.status, 'failed')
  assert.equal(by.stuck.note, 'stuck-gate')
  assert.equal(by.dead.status, 'failed')
  assert.equal(by.dead.note, 'interrupted')
})

test('a claude -p round: tool uses and its result', () => {
  const lines = [
    JSON.stringify({ type: 'system', model: 'claude-sonnet-5-5' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x.ts' } }] } }),
    JSON.stringify({ type: 'result', is_error: false, usage: { input_tokens: 5, output_tokens: 7 } }),
  ]
  const root = fixture([['c', { claude_session: 'S1', executor: 'claude', driver_pid: PID }, { 'claude-round-1.jsonl': lines.join('\n') }]])
  const [r] = scan('S1', root)
  assert.equal(r.model, 'claude-sonnet-5-5')
  assert.equal(r.toolCalls, 1)
  assert.equal(r.tokens, 12)
  assert.equal(r.phase, 'gate')
})
