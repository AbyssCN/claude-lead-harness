import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { OmdRun } from '../types'

const run = (over: Partial<OmdRun> = {}): OmdRun => ({
  id: 'omd:g5-w',
  label: 'g5-w',
  executor: 'mcode',
  spec: 'docs/plan/g5-w.md',
  model: 'MiniMax-M3.1-Flash-Preview',
  status: 'running',
  phase: 'exec',
  note: '',
  round: 2,
  maxRounds: 4,
  toolCalls: 31,
  lastTool: 'bash: npx tsc --noEmit',
  message: '',
  tokens: 1_200_000,
  contextTokens: 0,
  startedAt: 1_000,
  ...over,
})

// The scanner's answer stands in for bin/omd-scan.mjs; the plugin polls it on session.start.
async function world(on: On, runs: OmdRun[], at: number) {
  const clock = mock.clock(on)
  await clock.set(at)
  mock.env(on, { LANG: 'en_US.UTF-8' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: {} }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__savvy-progress__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // Nothing of the engine's own above the prompt or in the pane.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.id', () => ({ value: 'S1' }))
  const argv: string[][] = []
  on('process.run', (_, e) => {
    argv.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify(runs), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { clock, argv }
}
const start = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const PANE = {
  component: 'Pane',
  requestId: 'savvy-agents',
  props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the band shows a running omd-lite run, and ✕ hides it', async ($, on) => {
  const { argv } = await world(on, [run()], 62_000)
  await $.session.start(start)
  expect(argv[0]?.slice(-1)).toEqual(['S1'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'savvy-progress', surface, ...BAND })
    expect(await ui.find({ key: 'omd-agents' })).toBeDefined()
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: 'g5-w' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /round 2 of 4 · executing/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /31 tools · bash: npx tsc --noEmit · 1\.2M tokens · 1:01/ })).toBeDefined()
    }
    if (surface === 'desktop') {
      await ui.press({ key: 'omd-dismiss' })
      expect(await ui.find({ key: 'omd-agents' })).toBeUndefined()
    }
    await ui.unmount()
  }
})

test('no band for a run that ended over ten minutes ago', async ($, on) => {
  await world(on, [run({ status: 'done', phase: 'end', endedAt: 2_000 })], 2_000 + 11 * 60 * 1000)
  await $.session.start(start)
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'omd-agents' })).toBeUndefined()
  await ui.unmount()
})

test('the panel lists omd-lite runs with the MiniMax sprite', async ($, on) => {
  await world(on, [run(), run({ id: 'omd:l-4', label: 'l-4', status: 'failed', phase: 'end', note: 'interrupted', endedAt: 5_000 })], 62_000)
  await $.session.start(start)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'savvy-progress', surface, ...PANE })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: 'omd-lite · 1 running' })).toBeDefined()
      expect(await ui.find({ key: 'mm-omd:g5-w' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /interrupted/ })).toBeDefined()
    } else {
      expect(await ui.find({ type: 'Text', text: 'omd-lite · 1 running' })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('a Claude subagent row draws the pixel crab in the terminal', async ($, on) => {
  await world(on, [], 62_000)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-haiku-5-5' }))
  await $.session.start(start)
  await $.agent.spawn({ subagentType: 'general-purpose', description: 'count lines', prompt: 'x', tool_use_id: 't1' } as never)
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'crab-a1' })).toBeDefined()
  await ui.unmount()
})
