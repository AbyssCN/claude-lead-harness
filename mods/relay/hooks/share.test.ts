import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { goSteps, rankFiles, redact } from './share'

const NOW = Date.UTC(2026, 9, 22, 9, 0)
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const HANDOFF_MD = '# 交接:修 header\n\n在 `/r` 接着做。key sk-abcdefghijklmnopqrstuvwxyz 别外传。'
const MESSAGES = [
  { role: 'user', text: '把 header 修好', toolUses: [] },
  {
    role: 'assistant',
    text: '看 https://example-app.fi/x',
    toolUses: [
      { tool_use_id: 't1', tool: 'Read', input: { file_path: '/r/a.ts' } },
      { tool_use_id: 't2', tool: 'Edit', input: { file_path: '/r/b.ts' } },
      { tool_use_id: 't3', tool: 'Skill', input: { skill: 'verify' } },
    ],
  },
]

type W = { files: Map<string, string>; submits: string[]; ran: string[][]; cleared: number }

function world(on: On, fork: 'ok' | 'fail' = 'ok') {
  const w: W = { files: new Map([['/r/a.ts', 'a'], ['/r/b.ts', 'b']]), submits: [], ran: [], cleared: 0 }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  on('session.cwd', async () => ({ value: '/r' }))
  on('session.id', async () => ({ value: 'sid-12345678' }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 1000 }, rateLimits: [] } as never }))
  on('session.messages', async () => ({ value: MESSAGES as never }))
  on('fs.read', async (_$, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', async (_$, e) => ({ value: w.files.has(e.path) }))
  on('fs.list', async () => ({ value: [] as never }))
  on('process.run', async (_$, e) => {
    w.ran.push([...e.argv])
    if (e.argv[0] === 'rm') for (const p of e.argv.slice(2)) w.files.delete(p)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } as never }
  })
  on('model.fork', async () =>
    fork === 'ok'
      ? { value: { isAnswered: true as const, text: HANDOFF_MD, usage: USAGE } }
      : { value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, usage: USAGE } as never },
  )
  on('prompt.submit', async (_$, e) => {
    w.submits.push(e.text)
    return { text: e.text } as never
  })
  on('command.run', async (_$, e, next) => {
    if (e.command === 'clear') {
      w.cleared++
      return { text: '' } as never
    }
    return next(e)
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.notify', async () => ({ value: { isSent: true as const, channel: 'terminal_bell' as const } }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  // The engine's own band: nothing.
  on('ui.render', async ($, e) => h($.ui.resolve(e).Box, {}) as never)
  return { w, clock }
}

const CMD = { args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
const BAND = { plugin: 'relay', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

async function handoff($: Engine, clock: ReturnType<typeof mock.clock>) {
  await $.command.run({ command: 'handoff', ...CMD })
  for (let i = 0; i < 6; i++) {
    await clock.advance(1000)
    await clock.settle()
  }
}

const sharePaths = (w: W) => [...w.files.keys()].filter(p => p.startsWith('/h/.claude/handoffs/share-'))

describe('/handoff (shareable, no clear)', () => {
  test('writes the handoff beside the chat: draft first, then the final file; no turn, no /clear', async ($, on) => {
    const { w, clock } = world(on)
    await handoff($, clock)
    const saved = sharePaths(w)
    expect(saved.length).toBe(1)
    expect(saved[0]?.endsWith('-draft.md')).toBe(false)
    const text = w.files.get(saved[0] ?? '') ?? ''
    expect(text).toContain('# 交接:修 header')
    expect(text).toContain('<已删去密钥>')
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(w.submits.length).toBe(0)
    expect(w.cleared).toBe(0)
    expect(w.files.get('/h/.claude/handoffs/handoff.log')).toContain('share ok')
  })

  test('the band shows the steps and, once ready, copy / hand off and clear / close', async ($, on) => {
    const { clock } = world(on)
    await handoff($, clock)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /交接写好了/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5\. 保存并核对/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
    await ui.press({ key: 'share-close' })
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /交接写好了/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a failed model step keeps the draft and offers retry', async ($, on) => {
    const { w, clock } = world(on, 'fail')
    await handoff($, clock)
    const saved = sharePaths(w)
    expect(saved.length).toBe(1)
    expect(saved[0]?.endsWith('-draft.md')).toBe(true)
    expect(w.files.get(saved[0] ?? '')).toContain('把 header 修好')
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /模型调用失败\(529\)/ })).toBeDefined()
    expect(await ui.find({ key: 'share-retry' })).toBeDefined()
    expect(w.files.get('/h/.claude/handoffs/handoff.log')).toContain('share failed at step 4')
    await ui.unmount()
  })
})

describe('/relay go progress', () => {
  test('/relay go draws its steps above the prompt and logs the arming', async ($, on) => {
    const { w, clock } = world(on)
    await $.command.run({ command: 'relay', ...CMD, args: 'go' })
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /交接并清空中/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\. 写交接/ })).toBeDefined()
    expect(w.files.get('/h/.claude/handoffs/handoff.log')).toContain('armed go')
    await ui.unmount()
  })
})

describe('share helpers', () => {
  test('files rank writes over reads and skip transcripts', () => {
    const ranked = rankFiles(
      [
        { role: 'assistant', text: '', toolUses: [
          { tool_use_id: 'a', tool: 'Read', input: { file_path: '/r/a.ts' } },
          { tool_use_id: 'b', tool: 'Edit', input: { file_path: '/r/b.ts' } },
          { tool_use_id: 'c', tool: 'Read', input: { file_path: '/h/.claude/projects/x.jsonl' } },
        ] },
      ] as never,
      '/h',
    )
    expect(ranked).toEqual(['/r/b.ts', '/r/a.ts'])
  })

  test('redact cuts keys and bearer tokens', () => {
    expect(redact('Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe('Bearer <已删去密钥>')
    expect(redact('ghp_abcdefghijklmnopqrstuvwxyz')).toBe('<已删去密钥>')
  })

  test('go steps follow the handoff phase and the clear stage', () => {
    expect(goSteps('armed', '').map(s => s.status)).toEqual(['run', 'wait', 'wait', 'wait', 'wait'])
    expect(goSteps('ready', '').map(s => s.status)).toEqual(['done', 'run', 'wait', 'wait', 'wait'])
    expect(goSteps('idle', 'side').map(s => s.status)).toEqual(['done', 'done', 'done', 'run', 'wait'])
  })
})
