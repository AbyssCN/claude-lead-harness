import { describe, expect, test } from 'claude-code/testing'

import { handoffNote, isReadyAnswer, lastBlock, openDecisionRows, openGoalNine, parseDf, resumePrompt, runsSection } from './parse'

describe('parse', () => {
  test('旁车块第一行就是「## owner 最后一条消息」(D-2)', () => {
    expect(lastBlock({ text: '按推荐来', at: 0 }, [], '').startsWith('## owner 最后一条消息(')).toBe(true)
    expect(lastBlock(null, [], '').startsWith('## owner 最后一条消息')).toBe(true)
  })

  test('df output', () => {
    expect(parseDf(' Avail\n  123G\n')).toBe(123)
    expect(parseDf('')).toBe(null)
  })

  test('open decision rows skip struck-out and closed ones', () => {
    const md = [
      '| # | 问题 | 选项 |',
      '|---|---|---|',
      '| 1 | R18 年资 | x |',
      '| 3 | ~~试用补到 90 天~~ **关闭 08.10** | — |',
      '| 4 | PayrollCo 回信 | y |',
    ].join('\n')
    expect(openDecisionRows(md)).toEqual(['R18 年资', 'PayrollCo 回信'])
  })

  test('GOAL §9 bullets only, struck-out ones settled', () => {
    const md = ['## §8 x', '- not this', '## §9 等 owner', '- **A**:问题', '- ~~**B**~~ 已定', '- C', '## §10', '- no'].join('\n')
    expect(openGoalNine(md)).toEqual(['**A**:问题', 'C'])
  })

  test('ready marker only on a line of its own', () => {
    expect(isReadyAnswer('交接写好了。\nHANDOFF-READY')).toBe(true)
    expect(isReadyAnswer('写完后写 HANDOFF-READY 标记')).toBe(false)
  })

  test('handoff note wants screenshot paths beside each pending decision', () => {
    expect(handoffNote(400_000, '/h.md')).toContain('截图绝对路径')
  })

  test('resume prompt lists the pending decisions (with screenshots) before any work', () => {
    const p = resumePrompt('/h.md')
    expect(p).toContain('等用户拍板')
    expect(p.indexOf('用 Read 逐张读出来')).toBeLessThan(p.indexOf('按「下一步」接着做'))
  })

  test('resume prompt names the checkpoint only when there is one', () => {
    expect(resumePrompt('/h.md').includes('checkpoint')).toBe(false)
    expect(resumePrompt('/h.md', '/c/checkpoint.md')).toContain('continuity checkpoint /c/checkpoint.md')
    expect(resumePrompt('/h.md', '/c/checkpoint.md')).not.toContain('omd checkpoint')
    expect(resumePrompt('/h.md', null).includes('目标文件')).toBe(false)
    expect(resumePrompt('/h.md', null, ['/g/GOAL.md', '/g/LOOP-GOAL.md']).includes('目标文件 /g/GOAL.md、/g/LOOP-GOAL.md')).toBe(true)
  })

  // S6: continuity 的 latest() 会说这份是不是降级版;降级版只信交接,别当事实(17.10 近 7 天 37 份里 18 份降级)。
  test('a degraded checkpoint says so beside its path, a good one says nothing', () => {
    expect(resumePrompt('/h.md', '/c/checkpoint.md', [], null, true)).toContain('(这份是降级版,只信交接,别拿它当事实)')
    expect(resumePrompt('/h.md', '/c/checkpoint.md', [], null, false)).not.toContain('降级版')
    expect(resumePrompt('/h.md', null, [], null, true)).not.toContain('降级版')
  })

  test('handoffNote without runs keeps the old text; with runs it adds the section before the subagent line', () => {
    expect(handoffNote(400_000, '/h.md')).not.toContain('run 和重派状态')
    const note = handoffNote(400_000, '/h.md', [{ label: 'x', state: 'running' }])
    expect(note).toContain('本 session 的 run 和重派状态')
    expect(note.indexOf('- x · running')).toBeLessThan(note.indexOf('会话内的子 agent'))
    expect(handoffNote(400_000, '/h.md', [])).toContain('没有 run')
    expect(handoffNote(400_000, '/h.md', null)).toContain('读不到')
  })

  test('runsSection: running first, redispatch / resume links, cap of 12 lines', () => {
    const sec = runsSection([
      { label: 'a', state: 'fail', failureClass: 'provider' },
      { label: 'a-p2', state: 'fail', failureClass: 'provider' },
      { label: 'e', state: 'interrupted' },
      { label: 'e-r2', state: 'running', round: 2, maxRounds: 3 },
    ])
    const lines = sec.split('\n')
    expect(lines[1]).toBe('- e-r2 · running · 第 2/3 轮')
    expect(sec).toContain('- a · fail · provider  → 已自动重派为 a-p2(fail)')
    expect(sec).toContain('- a-p2 · fail · provider  → 自动重派的结果,同一 label 不再自动重派')
    expect(sec).toContain('- e · interrupted  → 已续跑为 e-r2(running)')
    const many = runsSection(Array.from({ length: 15 }, (_, i) => ({ label: `r${i}`, state: 'pass' })))
    expect(many.split('\n').length).toBe(1 + 12 + 1)
    expect(many).toContain('另有 3 个 run 未列出')
  })
})
