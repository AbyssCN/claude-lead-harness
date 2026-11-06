import { describe, expect, test } from 'claude-code/testing'

import { isCopyPath, isDocPath, lint, lintDoc } from './lint'

describe('copy-lint', () => {
  test('only outward copy paths', () => {
    expect(isCopyPath('/home/user/repos/myapp/apps/web/messages/zh.json')).toBe(true)
    expect(isCopyPath('/home/user/repos/myapp-109/docs/marketing/x.md')).toBe(true)
    expect(isCopyPath('/home/user/repos/myapp/docs/marketing/voice.md')).toBe(false)
    expect(isCopyPath('/home/user/repos/myapp/apps/web/src/app/page.tsx')).toBe(false)
  })

  test('finds banned words, retired outro and full stops in titles', () => {
    const hits = lint('# 一次排好。\n把规则对齐,搞定。\n"heroTitle": "排班交给 MyApp。"\nKokeile MyApp, ei maksukorttia')
    expect(hits.length).toBe(3)
    expect(hits[0]).toBe('禁用词:对齐、搞定')
  })

  test('clean copy passes', () => {
    expect(lint('# 排班交给 MyApp\n规则,MyApp 来算。')).toEqual([])
  })

  test('myapp 其余文档只查固定义项的禁用词', () => {
    expect(isDocPath('/home/user/repos/myapp/docs/plan/10.23/x.md')).toBe(true)
    expect(isDocPath('/home/user/repos/myapp-agents/w/docs/process/a.md')).toBe(true)
    expect(isDocPath('/home/user/repos/myapp/CLAUDE.md')).toBe(false)
    expect(isDocPath('/home/user/repos/myapp/docs/marketing/x.md')).toBe(false)
    expect(isDocPath('/home/user/repos/otherapp/docs/a.md')).toBe(false)
    expect(lintDoc('像素级对齐;读数落盘')).toEqual(['禁用词:落盘'])
  })
})
