// Public test set. The private suite replays real session transcripts, so only pure logic with synthetic input ships here.
import { describe, expect, test } from 'claude-code/testing'

import { cites, nextParkNumber, parkInto, sensitiveWords } from './hooks/vet.ts'

describe('vet', () => {
  test('sensitive words: ASCII matches whole words only (product is not prod)', () => {
    expect(sensitiveWords('open the product page')).toEqual([])
    expect(sensitiveWords('把工资单导出').map((w) => w.category)).toEqual(['money'])
  })

  test('a ruling must quote an evidence line; invented quotes do not count', () => {
    const ev = [{ source: 'GOAL.md', lines: ['- 15:30 owner decided to drop the fifth retry round'] }]
    expect(cites('owner decided to drop the fifth retry round', ev)).toBe(true)
    expect(cites('owner decided to ship on Friday afternoon', ev)).toBe(false)
  })

  test('parked items continue the existing numbering', () => {
    const md = '## 待 owner\n\n- [ ] #4 earlier question\n'
    expect(nextParkNumber(md)).toBe(5)
    expect(parkInto(md, 'new question', 'yes').n).toBe(5)
  })
})
