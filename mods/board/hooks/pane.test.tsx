import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Slice 5 of docs/plan/2026-10-23-board-unified.md: the plan tool, helper cards and the 500ms clock in the sidebar.

const HOME = '/home/t'
const NEXT_MD = ['最近更新:10.15', '## 现在', '- 生产', '', '**下一步**', '1. **接任务**', ''].join('\n')
const PLAN_FILE = `${HOME}/.claude/mods-state/plan-sid1.json`

// A hooks module is compiled on its own, so the run is a literal inside its register.
const delegateOne = {
  name: 'delegate',
  register(on: On) {
    on('engine.create', async (_, e, next) => {
      const list = [{ label: 'mm-1', runDir: '/r/mm-1', executor: 'mcode', model: 'MiniMax-M3.1', state: 'running', round: 2, maxRounds: 4, startedAt: 1_000_000 }]
      return { ...(await next(e)), delegate: { runs: async () => list, allRuns: async () => list } } as never
    })
  },
}

type World = { files: Record<string, string>; tools: string[]; clock: ReturnType<typeof mock.clock>; agents: Array<{ id: string; type: string; description: string; status: string; startedAt: number }> }

function world(on: On, enabled: Record<string, boolean>): World {
  const files: Record<string, string> = { [`${HOME}/repos/myapp/_NEXT.md`]: NEXT_MD }
  const tools: string[] = []
  const agents: World['agents'] = []
  const ids = ['agent-a1', 'agent-a2', 'agent-a3']
  let spawned = 0
  mock.env(on, { HOME })
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: `${HOME}/repos/myapp` }))
  on('session.id', async () => ({ value: 'sid1' }) as never)
  on('settings.read', async () => ({ value: { enabledPlugins: { 'board@owner-mods': true, ...enabled } } }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', async ($, e) => {
    tools.push((e as { name: string }).name)
    return { value: { tool: `mcp__board__${(e as { name: string }).name}` } } as never
  })
  on('prompt.compose', async () => ({ sections: [] }) as never)
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: ids[spawned++] }) as never)
  on('agent.list', async () => ({ value: agents }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('fs.stat', (_, e) => {
    if (!(e.path in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: 10, mtimeMs: 1_800_000_000_000, isLink: false } }
  })
  on('fs.exists', async ($, e) => ({ value: (e as { path: string }).path in files }) as never)
  on('fs.read', (_, e) => {
    if (!(e.path in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: files[e.path]! }
  })
  on('fs.write', async ($, e) => {
    const { path, text } = e as { path: string; text: string }
    files[path] = text
    return { value: undefined } as never
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  return { files, tools, clock, agents }
}

const start = ($: Engine, surface: 'desktop' | 'terminal') => $.session.start({ source: 'startup', cwd: `${HOME}/repos/myapp`, surface, isInteractive: true } as never)
const callTool = ($: Engine, input: unknown) => ($.tool.call as unknown as (i: unknown) => Promise<unknown>)(input)
const spawn = ($: Engine, description: string, subagentType: string) =>
  $.agent.spawn({ tool_use_id: `s-${description}`, prompt: 'Do it.', description, subagentType } as never)
const mount = ($: Engine, surface: 'desktop' | 'terminal') =>
  $.ui.mount({ plugin: 'board', surface, component: 'Pane', requestId: 'board', props: { bodyColumns: 60 } } as never)
const promptText = async ($: Engine) => ((await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [], sections: [] } as never)) as { sections: { text: string }[] }).sections.map(s => s.text).join('\n')
// Counts the 500ms periods board asks of the clock; `/ticks` reads the count. Compiled on its own, so the
// count lives inside its register.
const tickSpy = {
  name: 'tick-spy',
  register(on: On) {
    let n = 0
    on('clock.every', async ($, e, next) => {
      if ((e as { ms: number }).ms === 500) n += 1
      return next(e)
    })
    on('command.run', { command: 'ticks' }, async () => ({ text: String(n) }) as never)
  },
}
const tickCount = async ($: Engine) => Number(((await $.command.run({ command: 'ticks', args: '' } as never)) as { text?: string }).text)
/** The Svg a keyed Box holds: its markup. */
const svgUnder = (el: { children: unknown[] } | undefined) =>
  String((el?.children.find(c => typeof c === 'object' && (c as { type?: string }).type === 'Svg') as { props?: { source?: string } } | undefined)?.props?.source)
const steps3 = [
  { text: 'Read the brief', status: 'in_progress' },
  { text: 'Draft it', status: 'pending' },
  { text: 'Check it', status: 'pending' },
]

describe('board pane: plan tool, helper cards, 500ms clock', () => {
  test('GWT-1: helper-desk not enabled, no option → plan tool registered, board prompt injected', async ($, on) => {
    const w = world(on, { 'helper-desk@owner-mods': false })
    await start($, 'terminal')
    expect(w.tools).toContain('plan')
    const text = await promptText($)
    expect(text.includes('mcp__board__plan')).toBe(true)
    expect(text.includes('mcp__helper-desk__plan')).toBe(false)
  })

  test('GWT-1b: helper-desk enabled → board registers no plan tool and injects no plan prompt', async ($, on) => {
    const w = world(on, { 'helper-desk@owner-mods': true })
    await start($, 'terminal')
    expect(w.tools).not.toContain('plan')
    expect((await promptText($)).includes('mcp__board__plan')).toBe(false)
  })

  test('GWT-2: mcp__board__plan with 3 steps writes the plan file', async ($, on) => {
    const w = world(on, {})
    await start($, 'terminal')
    await callTool($, { tool: 'mcp__board__plan', tool_use_id: 'p1', title: 'Job', steps: steps3 })
    await w.clock.settle()
    expect(PLAN_FILE in w.files).toBe(true)
    const json = JSON.parse(w.files[PLAN_FILE]!) as { steps: unknown[]; updatedAt: unknown; title: string }
    expect(json.steps.length).toBe(3)
    expect(typeof json.updatedAt).toBe('string')
    expect(json.title).toBe('Job')
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    test(`GWT-4: only board + delegate → task-band and ≥2 helper cards (${surface})`, { plugins: [delegateOne] }, async ($, on) => {
      const w = world(on, {})
      await start($, surface)
      await spawn($, '写 board 合并', 'savvy-medium')
      await callTool($, { tool: 'mcp__board__plan', tool_use_id: 'p1', title: 'Job', steps: steps3 })
      await w.clock.advance(2_100)
      const ui = await mount($, surface)
      expect(await ui.find({ key: 'task-band' })).toBeDefined()
      const keys = (await ui.findAll({})).map(el => el.key ?? '').filter(k => /^helper-/.test(k))
      expect(new Set(keys).size).toBeGreaterThanOrEqual(2)
      await ui.unmount()
    })
  }

  // D-7 of docs/plan/2026-10-23-board-tui-judge.md: the terminal sprite is the .pen one, 14×10 pixels in 5 half-block rows.
  test('GWT-7: terminal heavy sprite is the .pen sprite, 5 rows, and holds still between ticks', async ($, on) => {
    const w = world(on, {})
    await start($, 'terminal')
    await spawn($, '审 relay 切片 1', 'savvy-heavy')
    await w.clock.settle()
    await w.clock.advance(500)
    const a = await mount($, 'terminal')
    const el = await a.find({ key: 'sprite-agent-a1' })
    const first = el?.text
    await a.unmount()
    await w.clock.advance(500)
    const b = await mount($, 'terminal')
    const second = (await b.find({ key: 'sprite-agent-a1' }))?.text
    await b.unmount()
    expect(first).toBeDefined()
    expect(first).toContain('▀')
    expect(first).toContain('审 relay 切片 1')
    const still = (t: string) => t.replace(/ · \d+s /, ' · ')
    expect(still(second!)).toBe(still(first!))
  })

  test('GWT-8: no working helper → no 500ms period is asked over 2000ms', { plugins: [tickSpy] }, async ($, on) => {
    const w = world(on, {})
    await start($, 'terminal')
    await spawn($, 'quick look', 'Explore')
    await w.clock.advance(1_000)
    const working = await tickCount($)
    expect(working, 'ticks while it works').toBeGreaterThanOrEqual(2)
    await $.turn.complete({ answer: 'ok', agentId: 'agent-a1', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' } as never)
    await w.clock.settle()
    const before = await tickCount($)
    await w.clock.advance(2_000)
    expect(await tickCount($)).toBe(before)
  })

  // GWT-3 / D-4 / D-5 of docs/plan/2026-10-23-board-fidelity.md: three subagents whose turns ended while their
  // background sleeps run report `waiting`; they are still running, in the sidebar and on line 2.
  test('subagents waiting on their own background work still count: 谁在跑 · 3 and 3 在跑', async ($, on) => {
    const w = world(on, {})
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box flexDirection="column" />
    })
    await start($, 'terminal')
    for (const d of ['后台 sleep 1', '后台 sleep 2', '后台 sleep 3']) await spawn($, d, 'general-purpose')
    w.agents.push(...['agent-a1', 'agent-a2', 'agent-a3'].map((id, i) => ({ id, type: 'general-purpose', description: `后台 sleep ${i + 1}`, status: 'waiting', startedAt: 1_000_000 })))
    for (const id of ['agent-a1', 'agent-a2', 'agent-a3'])
      await $.turn.complete({ answer: '', agentId: id, reason: 'answer', durationMs: 1, isAborted: false, turnId: `t-${id}` } as never)
    await w.clock.advance(30_000)
    const ui = await mount($, 'terminal')
    const shown = (await ui.findAll({ type: 'Text' })).map(el => el.text ?? '')
    expect(shown.some(t => /谁在跑 · 3\s+子 agent 3 · MiniMax 0/.test(t))).toBe(true)
    await ui.unmount()
    const hud = await $.ui.mount({ plugin: 'board', surface: 'terminal', component: 'AbovePrompt', props: { isWorking: false, hasSurvey: false, maxRows: 10, bodyColumns: 160 } } as never)
    const line2 = (await hud.findAll({ type: 'Text' })).map(el => el.text ?? '').find(t => t.includes('◷'))
    expect(line2).toContain('🬋🬴██🬗 🬋🬴██🬗 🬋🬴██🬗 3 在跑')
    await hud.unmount()
    // Done for real: the list says completed, the count drops.
    for (const a of w.agents) a.status = 'completed'
    await w.clock.advance(2_100)
    const ui2 = await mount($, 'terminal')
    expect((await ui2.findAll({ type: 'Text' })).map(el => el.text ?? '').some(t => t.includes('│ 谁在跑 · 0 '))).toBe(true)
    await ui2.unmount()
  })

  test('desktop: a running heavy card draws class="c-heavy run" with the reduced-motion rule', async ($, on) => {
    const w = world(on, {})
    await start($, 'desktop')
    await spawn($, '审 relay 切片 1', 'savvy-heavy')
    await callTool($, { tool: 'mcp__board__plan', tool_use_id: 'p1', title: 'Job', steps: steps3 })
    await w.clock.settle()
    const ui = await mount($, 'desktop')
    const svg = svgUnder(await ui.find({ key: 'sprite-agent-a1' }))
    expect(svg).toContain('class="c-heavy run"')
    expect(svg).toContain('@media (prefers-reduced-motion: reduce)')
    const band = svgUnder(await ui.find({ key: 'task-band' }))
    expect(band).toContain('2.6s')
    expect(band).toContain('prefers-reduced-motion')
    await ui.unmount()
  })
})

