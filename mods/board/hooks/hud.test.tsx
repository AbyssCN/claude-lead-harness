import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Slice 8 of docs/plan/2026-10-23-board-unified.md: the two lines above the prompt (INV-6, INV-7).

const HOME = '/home/t'
const NOW = 1_000_000

// lastEnd 2 minutes ago, a 1 hour cache: 58 minutes left. Compiled on its own, so the numbers are literals.
const cacheClockStub = {
  name: 'cache-clock',
  register(on: On) {
    on('engine.create', async (_, e, next) => ({
      ...(await next(e)),
      cacheClock: { state: async () => ({ lastEnd: 1_000_000 - 120_000, ttlMs: 3_600_000, warm: null }) },
    }) as never)
  },
}

type Usage = { context: Record<string, number>; rateLimits: Array<{ kind: string; percentUsed: number; resetsAt?: string }> }

function world(on: On, usage: Usage) {
  const files: Record<string, string> = {}
  const ids = ['agent-a1', 'agent-a2']
  let spawned = 0
  mock.env(on, { HOME })
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: `${HOME}/repos/myapp` }))
  on('session.id', async () => ({ value: 'sid1' }) as never)
  on('session.model', async () => ({ value: 'claude-opus-5-5' }) as never)
  on('session.usage', async () => ({ value: { startedAt: NOW, ...usage } }) as never)
  on('settings.read', async () => ({ value: { enabledPlugins: { 'board@lead-harness': true } } }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', async ($, e) => ({ value: { tool: `mcp__board__${(e as { name: string }).name}` } }) as never)
  on('prompt.compose', async () => ({ sections: [] }) as never)
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: ids[spawned++] }) as never)
  on('agent.list', async () => ({ value: [] }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: e.model, input_tokens: 1, output_tokens: 1 } } as never
  })
  on('fs.stat', (_, e) => {
    if (!(e.path in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: 10, mtimeMs: 0, isLink: false } }
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
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box flexDirection="column" />
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  return { clock }
}

const start = ($: Engine) => $.session.start({ source: 'startup', cwd: `${HOME}/repos/myapp`, surface: 'terminal', isInteractive: true } as never)
const steps3 = [
  { text: 'Read the brief', status: 'in_progress' },
  { text: 'Draft it', status: 'pending' },
  { text: 'Check it', status: 'pending' },
]

type El = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
// A Text's shown text, nested Texts included; a column Box puts each child on its own line.
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  const el = node as El
  const kids = (el.children ?? []).map(textOf)
  if (el.type === 'Box' && el.props?.flexDirection === 'column') return kids.filter(k => k !== '').join('\n')
  return kids.join('')
}
async function band($: Engine): Promise<string[]> {
  const ui = await $.ui.mount({ plugin: 'board', surface: 'terminal', component: 'AbovePrompt', props: { isWorking: false, hasSurvey: false, maxRows: 10, bodyColumns: 160 } } as never)
  const text = textOf(await ui.drawn())
  await ui.unmount()
  return text.split('\n')
}
async function step($: Engine, effort: string) {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort, messageCount: 1 } as never)
  for await (const _ of s) {
    // drain
  }
  await s.result
}

const READ: Usage = {
  context: { tokens: 240_000, window: 1_000_000, percent: 24 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 44, resetsAt: new Date(NOW + 59 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 6 * 86_400_000).toISOString() },
  ],
}

async function busy($: Engine, on: On) {
  const w = world(on, READ)
  await start($)
  await $.agent.spawn({ tool_use_id: 's-1', prompt: 'Do it.', description: '写 board', subagentType: 'savvy-medium' } as never)
  await ($.tool.call as unknown as (i: unknown) => Promise<unknown>)({ tool: 'mcp__board__plan', tool_use_id: 'p1', title: 'Job', steps: steps3 })
  await w.clock.settle()
  return band($)
}

describe('board above the prompt: two lines', () => {
  test('GWT-9: a helper running, a 3-step plan, cache-clock present → exactly 2 lines', { plugins: [cacheClockStub] }, async ($, on) => {
    const lines = await busy($, on)
    expect(lines.length).toBe(2)
  })

  test('GWT-10: no URL anywhere', { plugins: [cacheClockStub] }, async ($, on) => {
    const lines = await busy($, on)
    expect(lines.join('\n').includes('https://')).toBe(false)
  })

  test('GWT-11 (board half): line 2 shows ◷ 58m', { plugins: [cacheClockStub] }, async ($, on) => {
    const lines = await busy($, on)
    expect(lines[1]!.includes('◷ 58m')).toBe(true)
    expect(lines[1]!.includes('▶ 任务')).toBe(true)
    expect(lines[1]!.includes('1 在跑')).toBe(true)
  })

  test('GWT-12: line 1 reads the engine: Opus 5.5, low, 24%, 44%, 59m, 30%', async ($, on) => {
    world(on, READ)
    await start($)
    await step($, 'low')
    const [l1] = await band($)
    for (const s of ['Opus 5.5', 'low', '24%', '44%', '59m', '30%']) expect(l1!.includes(s), s).toBe(true)
  })

  test('GWT-13: before the first reply ctx / 5h / 周 are —, never 0%', async ($, on) => {
    world(on, { context: { window: 1_000_000 }, rateLimits: [] })
    await start($)
    const [l1] = await band($)
    expect(l1!.includes('0%')).toBe(false)
    expect(l1!.includes('ctx —')).toBe(true)
    expect(l1!.includes('5h —')).toBe(true)
    expect(l1!.includes('周 —')).toBe(true)
  })
})
