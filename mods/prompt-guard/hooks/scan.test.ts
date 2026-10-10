import { describe, expect, test } from 'claude-code/testing'

import { normalize, redact, scan } from './scan'

// Fake keys, assembled at run time so no key-shaped literal sits in the source.
const STRIPE = 'sk_' + 'live_' + 'FAKEfake0123456789abcdefXYZ'
const MINIMAX = 'sk' + '-cp-' + 'FAKEfake0123456789_abcdef-XYZ'

describe('scan', () => {
  test('catches pasted API keys', () => {
    const text = `这是密钥 ${STRIPE} 还有 ${MINIMAX}`
    const hits = scan(text)
    expect(hits.map(h => h.label)).toEqual(['Stripe 密钥', 'MiniMax 密钥'])
    const out = redact(text, hits)
    expect(out.includes(STRIPE)).toBe(false)
    expect(out.includes(MINIMAX)).toBe(false)
    expect(out.includes('[已移除的Stripe 密钥]')).toBe(true)
  })

  test('catches a password given in the prompt', () => {
    expect(scan('你帮我输入密码是Example123我这边验证').map(h => h.label)).toEqual(['密码'])
    expect(scan('password: Hunter2xyz').length).toBe(1)
  })

  test('leaves questions about passwords alone', () => {
    expect(scan('我的密码是什么?')).toEqual([])
    expect(scan('密码是否正确')).toEqual([])
    expect(scan('这个服务的 api 登录密码是什么, 我这边怎么没有')).toEqual([])
  })

  test('normalize folds whitespace', () => {
    expect(normalize('  a \n b  ')).toBe('a b')
  })
})
