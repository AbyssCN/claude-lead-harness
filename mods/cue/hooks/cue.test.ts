import { describe, expect, mock, test } from 'claude-code/testing'

import { editKind, editRatio, parseCues, stats } from './seat'

const LONG = '这是一条足够长的回答。'.repeat(12)
const COMMANDS = [
  { name: 'verify', description: '统一验证 gate', source: 'user' as const },
  { name: 'commit', description: '智能 git commit', source: 'user' as const },
]
const USAGE = { input_tokens: 10, output_tokens: 200, cache_creation_input_tokens: 5, cache_read_input_tokens: 90000 }
const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never,
}
const TWO = JSON.stringify([
  { title: '拍板 cue 并验收', prompt: '/verify --full 跑完给我读数' },
  { title: '方向 B:只做 /enhance', prompt: '先只做 /enhance,不做回答后自动生成' },
])

function done(turnId: string, answer: string) {
  return { answer, durationMs: 1000, isAborted: false, turnId, reason: 'answer' as const }
}
const composer = { kind: 'composer' as const }
const RUN = { origin: composer, presentation: { isFullscreen: false, columns: 100 } }

describe('seat helpers', () => {
  test('parseCues keeps at most two, drops unknown slash commands, bad items and duplicates', () => {
    const known = new Set(['verify'])
    const text = '好的:\n' + JSON.stringify([
      { title: 'x', prompt: '/nope 做点什么' },
      { title: 'a', prompt: '/verify --full' },
      { title: 'b' },
      { title: 'a2', prompt: '/verify --full' },
      { title: 'c', prompt: '跑 e2e' },
      { title: 'd', prompt: '第三条' },
    ])
    expect(parseCues(text, known)).toEqual([
      { title: 'a', prompt: '/verify --full' },
      { title: 'c', prompt: '跑 e2e' },
    ])
    expect(parseCues('no json here', new Set())).toEqual([])
  })
  test('edit measure: equal / edited / discarded', () => {
    expect(editKind(editRatio('跑 verify 给我读数', '跑 verify 给我读数'))).toBe('equal')
    expect(editKind(editRatio('跑 verify 给我读数,不要问', '跑 verify --full 给我读数,不要问'))).toBe('edited')
    expect(editKind(editRatio('跑 verify 给我读数', 'hello world something else'))).toBe('discarded')
  })
})

describe('cue', () => {
  test('GWT-1: press fills once, submits zero times; band clears', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1000 })
    const fills: string[] = []
    let submitted = 0
    on('command.list', async () => ({ value: COMMANDS }))
    on('model.fork', async () => ({ value: { isAnswered: true as const, text: TWO, usage: USAGE } }))
    on('ui.render', async ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, { key: 'engine' }) as never })
    on('prompt.fill', async (_$, e) => { fills.push(e.text); return { isFilled: true } })
    on('prompt.submit', async (_$, e) => { submitted += 1; return { text: e.text } as never })
    on('turn.complete', async (_$, e) => ({ text: e.answer }))

    await $.turn.complete(done('t1', LONG))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'cue', surface, ...BAND })
      expect((await ui.findAll({ type: 'Button' })).length).toBe(2)
      expect((await ui.findAll({ type: 'Button', text: /Enhance/ })).length).toBe(1)
      await ui.unmount()
    }

    const ui = await $.ui.mount({ plugin: 'cue', surface: 'terminal', ...BAND })
    await ui.press({ key: 's2' })
    expect(fills).toEqual(['先只做 /enhance,不做回答后自动生成'])
    expect(submitted).toBe(0)
    expect((await ui.findAll({ type: 'Button' })).length).toBe(0)
    await ui.unmount()
  })

  test('relay running: no fork and no buttons', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1000 })
    let forks = 0
    on('state.get', async (_$, e) => ({ value: { value: e.plugin === 'relay' ? 'running' : undefined, version: 1 } as never }))
    on('command.list', async () => ({ value: COMMANDS }))
    on('model.fork', async () => { forks += 1; return { value: { isAnswered: true as const, text: TWO, usage: USAGE } } })
    on('ui.render', async ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, { key: 'engine' }) as never })
    on('turn.complete', async (_$, e) => ({ text: e.answer }))

    await $.turn.complete(done('t1', LONG))
    expect(forks).toBe(0)
    const ui = await $.ui.mount({ plugin: 'cue', surface: 'terminal', ...BAND })
    expect((await ui.findAll({ type: 'Button' })).length).toBe(0)
    await ui.unmount()
  })

  test('short answer and subagent turns are skipped', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1000 })
    let forks = 0
    on('command.list', async () => ({ value: COMMANDS }))
    on('model.fork', async () => { forks += 1; return { value: { isAnswered: true as const, text: TWO, usage: USAGE } } })
    on('turn.complete', async (_$, e) => ({ text: e.answer }))

    await $.turn.complete(done('t1', '好的,已完成。'))
    await $.turn.complete({ ...done('t2', LONG), agentId: 'sub-1' })
    expect(forks).toBe(0)
  })

  test('unknown slash command dropped from the band', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1000 })
    on('command.list', async () => ({ value: COMMANDS }))
    on('model.fork', async () => ({ value: { isAnswered: true as const, usage: USAGE, text: JSON.stringify([
      { title: '假命令', prompt: '/ghost 跑一下' },
      { title: '真推荐', prompt: '把 cue 的测试补齐,跑 claude plugin test 给我读数' },
    ]) } }))
    on('ui.render', async ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, { key: 'engine' }) as never })
    on('turn.complete', async (_$, e) => ({ text: e.answer }))

    await $.turn.complete(done('t1', LONG))
    const ui = await $.ui.mount({ plugin: 'cue', surface: 'terminal', ...BAND })
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.length).toBe(1)
    expect((await ui.findAll({ type: 'Button', text: /真推荐/ })).length).toBe(1)
    await ui.unmount()
  })

  test('/enhance rewrites the draft into the box (replace), never submits', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1000 })
    const fills: { text: string; mode: string }[] = []
    let asked = ''
    let submitted = 0
    on('command.list', async () => ({ value: COMMANDS }))
    on('prompt.read', async () => ({ value: { text: '修一下 relay 那个 bug', cursor: 10 } }))
    on('model.fork', async (_$, e) => {
      asked = e.prompt
      return { value: { isAnswered: true as const, usage: USAGE, text: JSON.stringify([{ title: '修 relay', prompt: '修 relay 的停机判定 bug。判据:…' }]) } }
    })
    on('prompt.fill', async (_$, e) => { fills.push({ text: e.text, mode: e.mode }); return { isFilled: true } })
    on('prompt.submit', async (_$, e) => { submitted += 1; return { text: e.text } as never })

    const out = await $.command.run({ command: 'enhance', args: '', ...RUN })
    expect(asked).toContain('修一下 relay 那个 bug')
    expect(fills).toEqual([{ text: '修 relay 的停机判定 bug。判据:…', mode: 'replace' }])
    expect(submitted).toBe(0)
    expect(out.text ?? '').toContain('已写入')
  })

  test('stats counts forks and a press, and resolves edited at submit', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1000 })
    on('command.list', async () => ({ value: COMMANDS }))
    on('model.fork', async () => ({ value: { isAnswered: true as const, text: TWO, usage: USAGE } }))
    on('ui.render', async ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, { key: 'engine' }) as never })
    on('prompt.fill', async () => ({ isFilled: true }))
    on('prompt.submit', async (_$, e) => ({ text: e.text }) as never)
    on('turn.complete', async (_$, e) => ({ text: e.answer }))

    await $.turn.complete(done('t1', LONG))
    const ui = await $.ui.mount({ plugin: 'cue', surface: 'terminal', ...BAND })
    await ui.press({ key: 's1' })
    await ui.unmount()
    await $.prompt.submit({ text: '/verify --full 跑完给我读数,别问', wait: false, origin: composer } as never)

    const out = (await $.command.run({ command: 'cue', args: 'stats', ...RUN })).text ?? ''
    expect(out).toContain('生成 1 次')
    expect(out).toContain('缓存读 90000')
    expect(out).toContain('1 = 1')
    expect(out).toContain('改写 1')
  })

  test('stats text from logs', () => {
    const t = stats(
      [{ ts: 1, kind: 'answer', engine: 'fork', input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }],
      [{ ts: 2, slot: '1', text: 'x', edited: 'equal', ratio: 0 }],
    )
    expect(t).toContain('原样 1(100%)')
  })
})
