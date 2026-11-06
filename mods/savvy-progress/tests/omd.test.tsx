import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code/testing'

// savvy-progress draws what delegate reports (`$.delegate.runs()`, C-0), so each scenario seats a delegate stand-in.
// A hooks module is compiled on its own: a stand-in cannot close over the test's data, so the runs are literals in its register.
const delegateRunning = {
  name: 'delegate',
  register(on: On) {
    on('engine.create', async (_, e, next) => {
      const list = [{ label: 'g5-w', runDir: '/r/g5-w', executor: 'mcode', model: 'MiniMax-M3.1-Flash-Preview', state: 'running', round: 2, maxRounds: 4, startedAt: 1_000, tool: 'bash: npx tsc --noEmit', tokens: 1_200_000 }]
      return { ...(await next(e)), delegate: { runs: async () => list, allRuns: async () => list } } as never
    })
  },
}
const delegateEndedLongAgo = {
  name: 'delegate',
  register(on: On) {
    on('engine.create', async (_, e, next) => {
      const list = [{ label: 'g5-w', runDir: '/r/g5-w', executor: 'mcode', state: 'pass', round: 2, maxRounds: 4, startedAt: 1_000, endedAt: 2_000 }]
      return { ...(await next(e)), delegate: { runs: async () => list, allRuns: async () => list } } as never
    })
  },
}
const delegateMixed = {
  name: 'delegate',
  register(on: On) {
    on('engine.create', async (_, e, next) => {
      const list = [
        { label: 'g5-w', runDir: '/r/g5-w', executor: 'mcode', model: 'MiniMax-M3.1-Flash-Preview', state: 'running', round: 2, maxRounds: 4, startedAt: 1_000, tool: 'bash: npx tsc --noEmit', tokens: 1_200_000 },
        { label: 'l-4', runDir: '/r/l-4', executor: 'pi', state: 'interrupted', startedAt: 1_000, endedAt: 5_000 },
        { label: 'p-2', runDir: '/r/p-2', executor: 'pi', state: 'fail', failureClass: 'provider', startedAt: 1_000, endedAt: 6_000 },
      ]
      return { ...(await next(e)), delegate: { runs: async () => list, allRuns: async () => list } } as never
    })
  },
}
const delegateNone = {
  name: 'delegate',
  register(on: On) {
    on('engine.create', async (_, e, next) => ({ ...(await next(e)), delegate: { runs: async () => [], allRuns: async () => [] } }) as never)
  },
}

// The panel polls delegate on session.start; nothing else beneath the plugin.
async function world(on: On, at: number) {
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
  // S10: savvy-progress has no scanner of its own any more; it must not start a process for runs.
  const argv: string[][] = []
  on('process.run', (_, e) => {
    argv.push([...e.argv])
    return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { clock, argv }
}
const start = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 },
} as const
const PANE = {
  component: 'Pane',
  requestId: 'savvy-agents',
  props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the band shows a running omd-lite run, and ✕ hides it', { plugins: [delegateRunning] }, async ($, on) => {
  const { argv } = await world(on, 62_000)
  await $.session.start(start)
  expect(argv).toEqual([])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'savvy-progress', surface, ...BAND })
    expect(await ui.find({ key: 'omd-agents' })).toBeDefined()
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: 'g5-w' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /round 2 of 4 · executing/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /bash: npx tsc --noEmit · 1\.2M tokens · 1:01/ })).toBeDefined()
    }
    if (surface === 'desktop') {
      await ui.press({ key: 'omd-dismiss' })
      expect(await ui.find({ key: 'omd-agents' })).toBeUndefined()
    }
    await ui.unmount()
  }
})

test('no band for a run that ended over ten minutes ago', { plugins: [delegateEndedLongAgo] }, async ($, on) => {
  await world(on, 2_000 + 11 * 60 * 1000)
  await $.session.start(start)
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'omd-agents' })).toBeUndefined()
  await ui.unmount()
})

test('the panel lists omd-lite runs with the MiniMax sprite', { plugins: [delegateMixed] }, async ($, on) => {
  await world(on, 62_000)
  await $.session.start(start)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'savvy-progress', surface, ...PANE })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: 'omd-lite · 1 running' })).toBeDefined()
      expect(await ui.find({ key: 'mm-omd:g5-w' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /interrupted/ })).toBeDefined()
      // a provider failure reads as its failureClass; the tool-call count C-0 does not carry is not drawn as "0 tools"
      expect(await ui.find({ type: 'Text', text: /provider/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /0 tools/ })).toBeUndefined()
    } else {
      expect(await ui.find({ type: 'Text', text: 'omd-lite · 1 running' })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('a Claude subagent row draws the pixel crab in the terminal', { plugins: [delegateNone] }, async ($, on) => {
  await world(on, 62_000)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-haiku-5-5' }))
  await $.session.start(start)
  await $.agent.spawn({ subagentType: 'general-purpose', description: 'count lines', prompt: 'x', tool_use_id: 't1' } as never)
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'crab-a1' })).toBeDefined()
  await ui.unmount()
})

test('without delegate the omd-lite section stays empty and nothing breaks', async ($, on) => {
  const { argv } = await world(on, 62_000)
  await $.session.start(start)
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'omd-agents' })).toBeUndefined()
  await ui.unmount()
  expect(argv).toEqual([])
})
