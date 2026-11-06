import { describe, expect, test } from 'claude-code/testing'

import { normalize, redact, scan } from './scan'

describe('scan', () => {
  test('catches the keys pasted last week', () => {
    // 假值:形状与真密钥相同,拼接写出,扫描器不会把它当成真密钥(15.10 前这里放的是真密钥,已换掉)
    const text = '这是密钥 ' + 'sk_' + 'live_' + 'Fake0Stripe0Key0For0Tests0Only' + ' 还有 ' + 'sk-' + 'cp-' + 'Fake0MiniMax0Key0For0Tests_only'
    const hits = scan(text)
    expect(hits.map(h => h.label)).toEqual(['Stripe 密钥', 'MiniMax 密钥'])
    const out = redact(text, hits)
    expect(out.includes('sk_live_')).toBe(false)
    expect(out.includes('sk-cp-')).toBe(false)
    expect(out.includes('[已移除的Stripe 密钥]')).toBe(true)
  })

  test('catches a password given in the prompt', () => {
    expect(scan('你帮我输入密码是NICKton123我这边验证').map(h => h.label)).toEqual(['密码'])
    expect(scan('password: Jinlichang123').length).toBe(1)
  })

  test('leaves questions about passwords alone', () => {
    expect(scan('我的密码是什么?')).toEqual([])
    expect(scan('密码是否正确')).toEqual([])
    expect(scan('vero的api登录密码是什么, 我这边怎么没有')).toEqual([])
  })

  test('normalize folds whitespace', () => {
    expect(normalize('  a \n b  ')).toBe('a b')
  })
})
