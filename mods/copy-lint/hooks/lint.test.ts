import { describe, expect, test } from 'claude-code/testing'

import { globToRegExp, isCopyPath, lint, parseConfig } from './lint'

const config = parseConfig(
  JSON.stringify({
    include: ['docs/marketing/**', 'web/messages/*.json', 'docs/plan/*/{video,mkt}/**'],
    exclude: ['docs/marketing/style-guide.md'],
    banned: [
      'synergy',
      { word: 'leverage', reason: '写 use' },
      { pattern: 'no credit card required', flags: 'i', reason: '已废的片尾句' },
    ],
    headingNoTrailing: '。.',
    guide: 'docs/marketing/style-guide.md',
  }),
)!

describe('copy-lint', () => {
  test('no or empty config does nothing', () => {
    expect(parseConfig(null)).toBe(null)
    expect(parseConfig('{')).toBe(null)
    expect(parseConfig('{"banned": ["x"]}')).toBe(null)
  })

  test('globs', () => {
    expect(globToRegExp('docs/**/*.md').test('docs/a/b/c.md')).toBe(true)
    expect(globToRegExp('docs/**/*.md').test('docs/c.md')).toBe(true)
    expect(globToRegExp('web/*.json').test('web/a/b.json')).toBe(false)
  })

  test('only public copy paths', () => {
    expect(isCopyPath('web/messages/zh.json', config)).toBe(true)
    expect(isCopyPath('docs/marketing/launch/post.md', config)).toBe(true)
    expect(isCopyPath('docs/plan/q3/video/script.md', config)).toBe(true)
    expect(isCopyPath('docs/marketing/style-guide.md', config)).toBe(false)
    expect(isCopyPath('src/app/page.tsx', config)).toBe(false)
  })

  test('finds banned words, phrases and trailing punctuation in titles', () => {
    const hits = lint('# Ship it.\nWe leverage synergy.\n"heroTitle": "排班交给我们。"\nTry it, No credit card required', config)
    expect(hits.length).toBe(2)
    expect(hits[0]).toBe('禁用词:「synergy」、「leverage」(写 use)、「No credit card required」(已废的片尾句)')
    expect(hits[1]!.startsWith('标题以标点结尾:# Ship it.')).toBe(true)
  })

  test('clean copy passes', () => {
    expect(lint('# Scheduling, done for you\nWe use rules.', config)).toEqual([])
  })
})
