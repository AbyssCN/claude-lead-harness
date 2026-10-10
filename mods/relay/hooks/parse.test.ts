import { describe, expect, test } from 'claude-code/testing'

import { isReadyAnswer, openDecisionRows, openGoalNine, parseDf, resumePrompt } from './parse'

describe('parse', () => {
  test('df output', () => {
    expect(parseDf(' Avail\n  123G\n')).toBe(123)
    expect(parseDf('')).toBe(null)
  })

  test('open decision rows skip struck-out and closed ones', () => {
    const md = [
      '| # | 问题 | 选项 |',
      '|---|---|---|',
      '| 1 | R18 缓存策略 | x |',
      '| 3 | ~~试用期改 30 天~~ **关闭** | — |',
      '| 4 | 支付商回信 | y |',
    ].join('\n')
    expect(openDecisionRows(md)).toEqual(['R18 缓存策略', '支付商回信'])
  })

  test('GOAL §9 bullets only, struck-out ones settled', () => {
    const md = ['## §8 x', '- not this', '## §9 等 owner', '- **A**:问题', '- ~~**B**~~ 已定', '- C', '## §10', '- no'].join('\n')
    expect(openGoalNine(md)).toEqual(['**A**:问题', 'C'])
  })

  test('ready marker only on a line of its own', () => {
    expect(isReadyAnswer('交接写好了。\nHANDOFF-READY')).toBe(true)
    expect(isReadyAnswer('写完后写 HANDOFF-READY 标记')).toBe(false)
  })

  test('resume prompt names the checkpoint only when there is one', () => {
    expect(resumePrompt('/h.md').includes('checkpoint')).toBe(false)
    expect(resumePrompt('/h.md', '/c.md').includes('omd checkpoint /c.md')).toBe(true)
    expect(resumePrompt('/h.md', null).includes('目标文件')).toBe(false)
    expect(resumePrompt('/h.md', null, ['/g/GOAL.md', '/g/LOOP-GOAL.md']).includes('目标文件 /g/GOAL.md、/g/LOOP-GOAL.md')).toBe(true)
  })
})
