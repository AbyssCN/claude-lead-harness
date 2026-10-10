import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { normalize, redact, scan } from './scan'

const last = atom({ plugin: 'prompt-guard', key: 'last' } as const, null)

// Prompts a person typed (terminal or phone). Others pass untouched.
const FROM_PERSON = new Set(['composer', 'bridge'])
// Typed on purpose to let a secret through: the marker is taken off first.
const ALLOW = /^#allow-secret\s+/
const DUPLICATE_MS = 5 * 60_000

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (!FROM_PERSON.has(e.origin.kind)) return next(e)

    if (ALLOW.test(e.text)) return next({ ...e, text: e.text.replace(ALLOW, '') })

    const hits = scan(e.text)
    if (hits.length > 0) {
      const labels = [...new Set(hits.map(h => h.label))].join('、')
      await $.prompt.fill({ text: redact(e.text, hits), mode: 'replace' })
      return {
        drop: `prompt-guard:消息里有${labels},没有发出。去掉密钥的版本已放回输入框;密钥请放密码管理器 / secret store 或环境变量,在 prompt 里写「用环境变量 X」。确实要发,在开头加 #allow-secret。`,
      }
    }

    const now = await $.clock.now()
    const text = normalize(e.text)
    const prev = await read($, last)
    if (prev && prev.text === text && now - prev.at < DUPLICATE_MS && text.length > 0) {
      const seconds = Math.round((now - prev.at) / 1000)
      return { drop: `prompt-guard:这条 ${seconds} 秒前刚发过,已经在处理或排队,这次没有重复发送。要再发一次,改一个字即可。` }
    }

    await update($, last, () => ({ text, at: now }))
    return next(e)
    // A bug here must never eat a prompt: let it through.
  }).catch(($, e, next) => next(e))
}
