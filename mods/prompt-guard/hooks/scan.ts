// Pure helpers, kept apart so the tests can call them directly.

export type Hit = { label: string; start: number; end: number }

const PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'Stripe 密钥', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { label: 'MiniMax 密钥', re: /\bsk-(?:cp)-[A-Za-z0-9_-]{20,}/g },
  { label: 'Anthropic 密钥', re: /\bsk-(?:ant)-[A-Za-z0-9_-]{20,}/g },
  { label: 'API 密钥', re: /\bsk-[A-Za-z0-9]{32,}/g },
  { label: 'GitHub token', re: /\b(?:ghp|gho|ghs)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  { label: 'AWS key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: 'JWT / Supabase key', re: /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/g },
  { label: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
]

// 「密码是 X」「password: X」: the value is 6+ non-CJK characters, so
// 「密码是否正确」「密码是什么」 pass through.
const PASSWORD = /(密码|口令|password|passwd|salasana)\s*(?:是|为|[:：=])\s*([^\s㐀-鿿，,。？?！!、）)]{6,})/gi

export function scan(text: string): Hit[] {
  const hits: Hit[] = []
  for (const { label, re } of PATTERNS) {
    for (const m of text.matchAll(re)) hits.push({ label, start: m.index!, end: m.index! + m[0].length })
  }
  for (const m of text.matchAll(PASSWORD)) {
    const value = m[2] ?? ''
    const start = m.index! + m[0].length - value.length
    hits.push({ label: '密码', start, end: start + value.length })
  }
  return hits.sort((a, b) => a.start - b.start)
}

export function redact(text: string, hits: Hit[]): string {
  let out = ''
  let at = 0
  for (const h of hits) {
    if (h.start < at) continue
    out += text.slice(at, h.start) + `[已移除的${h.label}]`
    at = h.end
  }
  return out + text.slice(at)
}

export const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()
