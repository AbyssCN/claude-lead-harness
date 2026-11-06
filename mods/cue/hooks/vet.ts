// Pure: before a cue goes into a dialog on a turn owner did not start, check it against what is on disk
// (still holds / already stale) and whether it touches money, production data or owner's logins.
// No engine here (register.tsx gathers the evidence and calls the model); no runtime imports, so
// `node --test cue/cue.test.ts` loads it too.

export type Category = 'money' | 'prod' | 'login'
export const CATEGORY_NAME: Record<Category, string> = { money: '钱', prod: '生产数据', login: 'owner 的登录' }

/** The ticket's words (t1102-07 §3) plus their plain synonyms. CJK by substring; ASCII as whole words, any case. */
export const SENSITIVE_WORDS: Record<Category, readonly string[]> = {
  money: ['工资', '计薪', '税卡', '价格', '计费', 'money-gate', 'PayrollCo', '钱片终裁', '薪资', '月薪', '时薪', '发薪', '付款', '转账', '退款', '账单', '发票', 'payroll', 'salary', 'wage'],
  prod: ['生产库', 'prod', 'production', 'service role', 'service_role', '上生产', '生产迁移', '发版部署', '部署', 'deploy', '对外发信', '写生产', '写进生产', '生产数据', '迁移闸', 'migration-gate', 'supabase'],
  login: ['Chrome', 'huashu-chrome', '用我的登录', '我的登录', '登录态', '凭证', 'OAuth', '换号', '令牌', '密码', 'cookie'],
}

const ascii = (w: string) => /^[\x20-\x7e]+$/.test(w)
const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ _-]/g, '[ _-]?')

/** Every listed word the text contains, in category order. */
export function sensitiveWords(text: string): { category: Category; word: string }[] {
  const hits: { category: Category; word: string }[] = []
  for (const category of Object.keys(SENSITIVE_WORDS) as Category[]) {
    for (const word of SENSITIVE_WORDS[category]) {
      const found = ascii(word) ? new RegExp(`(?<![A-Za-z0-9])${escape(word)}(?![A-Za-z0-9])`, 'i').test(text) : text.includes(word)
      if (found) hits.push({ category, word })
    }
  }
  // 「我的登录」 inside 「用我的登录」, Chrome inside huashu-chrome: one hit, the longer word.
  const low = (w: string) => w.toLowerCase()
  return hits.filter((h) => !hits.some((o) => o.word !== h.word && low(o.word).includes(low(h.word))))
}

/** One block of the evidence pack: where it was read, and its lines (newest last). */
export type Evidence = { source: string; lines: string[] }

/** Lines kept per source; the ledger tail is the ticket's 80. */
export const TAIL = 80
const MAX_LINE = 400
const MAX_ANSWER = 3000

export function tail(text: string, n = TAIL): string[] {
  return text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n)
}

/** ~/.omd-lite/rulings.json → one line per ruling, the last `n` written. */
export function rulingLines(json: string, n = 40): string[] {
  let o: Record<string, { action?: string; why?: string; by?: string; at?: string }>
  try {
    o = JSON.parse(json)
  } catch {
    return []
  }
  return Object.entries(o).slice(-n).map(([k, r]) => `${k}: ${r.action ?? ''} · ${r.why ?? ''}${r.by || r.at ? `(${[r.by, r.at].filter(Boolean).join(' ')})` : ''}`)
}

const clipLine = (l: string) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '…' : l)

/** The pack as the model reads it: each source a header, each line on its own. */
export function evidenceText(ev: Evidence[]): string {
  return ev
    .filter((e) => e.lines.length)
    .map((e) => [`## ${e.source}`, ...e.lines.map(clipLine)].join('\n'))
    .join('\n\n')
}

/** One cheap-model call for both questions; the reply is one JSON object. */
export function vetPrompt(draft: string, answer: string, ev: Evidence[], now: string): string {
  const last = answer.length > MAX_ANSWER ? '…' + answer.slice(-MAX_ANSWER) : answer
  return [
    `现在是 ${now}(赫尔辛基)。下面 <草稿> 是一条准备替 owner 发给一个 Claude 会话的指令，由那个会话的最后一条回答(<回答>)生成。发出去之前，拿 <证据> 里磁盘上的现状核两件事。`,
    '',
    '一、草稿还成立吗?',
    '- 「已过时」:证据里有一行说明草稿要做的事已经被叫停、已经批过 / 起过 / 做完、或被后来的决定换掉了(看时间先后，证据比草稿新才算)。',
    '- 草稿要批准 / 开始 / 起的事，回答或证据里已经说它起了、批了、在跑了，也是已过时(再发一遍就是重复)。',
    '- 先用一句话写下草稿要的那个交付物或动作(比如「开始做 N3 的页面」),再找证据里说的是不是同一个东西。名字撞上不算：草稿要页面，证据合进去的是同名的迁移 / 后端 / 任务书 / 另一个子片，就不是同一个。',
    '- 「仍成立」:找不到说的就是这件事的行。只是话题相近、名字相同或沾边，都算仍成立。',
    '- 判已过时必须把证据(或回答)里那一行原样抄进 evidence(整行或其中连续的一段，至少 10 个字),抄不出来就判仍成立。',
    '',
    '二、草稿碰不碰下面三类(碰到任何一类就是敏感，判不准就填 unsure):',
    '- money 钱：工资、计薪、税卡、价格、计费、付款、PayrollCo、钱片终裁。',
    '- prod 生产数据：读写生产库、prod、service role、上生产的迁移、发版部署、对外发信(发给客户 / 员工 / 官方)。',
    '- login owner 的登录:用他的 Chrome / 浏览器登录、凭证、OAuth、换号、令牌。',
    '- 只是提到、不去做的(比如「别碰生产」)不算碰。',
    '',
    '只输出一个 JSON 对象，不要别的字:{"draftWants":"一句话：草稿要的交付物或动作","verdict":"holds" 或 "stale","evidence":"判 stale 时抄的那一行，否则空串","reason":"一句理由","sensitive":"money"、"prod"、"login"、"none" 或 "unsure","sensitiveWhy":"一句理由"}',
    '',
    '<草稿>',
    draft,
    '</草稿>',
    '',
    '<回答>',
    last,
    '</回答>',
    '',
    '<证据>',
    evidenceText(ev) || '(没读到任何证据)',
    '</证据>',
  ].join('\n')
}

export type Verdict = { verdict: 'holds' | 'stale' | 'unsure'; reason: string; evidence: string | null }
export type Sensitivity = { sensitive: boolean; category: Category | 'unsure' | null; why: string }

// Full-width and ASCII punctuation fold together (a model quoting 「，」 back as 「,」 still cites the line).
const norm = (s: string) => s.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '')

/** Whether `quote` is a run of at least 10 characters of one evidence line (whitespace and quote marks ignored). */
export function cites(quote: string, ev: Evidence[]): boolean {
  const q = norm(quote).replace(/…$/, '')
  if (q.length < 10) return false
  return ev.some((e) => e.lines.some((l) => norm(l).includes(q)))
}

function parseObject(reply: string | null): Record<string, unknown> | null {
  if (!reply) return null
  const s = reply.indexOf('{')
  const e = reply.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    const o = JSON.parse(reply.slice(s, e + 1))
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * The model's reply → the two verdicts. Fails closed both ways: no reply, a reply that does not parse,
 * or a 'stale' whose quoted line is not in the pack → 'unsure' (voided, not sent); a sensitivity it did not
 * name as `none` → sensitive.
 */
export function parseVet(reply: string | null, ev: Evidence[], answer = ''): { stale: Verdict; sensitivity: Sensitivity } {
  ev = answer ? [...ev, { source: '本会话最后一条回答', lines: answer.split('\n') }] : ev
  const o = parseObject(reply)
  const str = (k: string) => (o && typeof o[k] === 'string' ? (o[k] as string).trim() : '')
  let stale: Verdict
  if (!o) stale = { verdict: 'unsure', reason: '核现状的模型没给出可读的判词', evidence: null }
  else if (o.verdict === 'holds') stale = { verdict: 'holds', reason: str('reason'), evidence: null }
  else if (o.verdict === 'stale' && cites(str('evidence'), ev)) stale = { verdict: 'stale', reason: str('reason'), evidence: str('evidence') }
  else if (o.verdict === 'stale') stale = { verdict: 'unsure', reason: `判了过时，但引的行在证据里找不到:${str('evidence') || '(没引)'}`, evidence: null }
  else stale = { verdict: 'unsure', reason: `判词不认识:${String(o.verdict)}`, evidence: null }
  const s = str('sensitive')
  const sensitivity: Sensitivity =
    s === 'none'
      ? { sensitive: false, category: null, why: str('sensitiveWhy') }
      : { sensitive: true, category: s === 'money' || s === 'prod' || s === 'login' ? s : 'unsure', why: str('sensitiveWhy') || (o ? '模型判不准' : '核现状的模型没回话') }
  return { stale, sensitivity }
}

/**
 * Where a fresh cue goes.
 * - `owner`: a turn owner started (typed at the terminal or on the phone): the dialog as before, never sent by itself.
 * - `park`: sensitive, whoever started the turn: no dialog; to owner's phone and the 待 owner file, kept on the band.
 * - `void`: stale, or its check could not be read: dropped, one log line.
 * - `popup`: still holds and touches none of the three: the dialog, sent by itself after five minutes.
 */
export type Route = 'owner' | 'park' | 'void' | 'popup'

export function route(r: { ownerTurn: boolean; words: { category: Category; word: string }[]; vet?: { stale: Verdict; sensitivity: Sensitivity } }): Route {
  if (r.ownerTurn) return r.words.length ? 'park' : 'owner'
  if (!r.vet || r.vet.stale.verdict !== 'holds') return 'void'
  if (r.words.length || r.vet.sensitivity.sensitive) return 'park'
  return 'popup'
}

/** A dialog on a turn owner did not start is sent by itself after this long without an answer. */
export const AUTO_SEND_MS = 5 * 60_000
/** Five-minute sends in a row with nothing else coming in: past this the next cue is dropped, the session waits for a person. */
export const MAX_AUTO_CHAIN = 3

const oneField = (t: string) => t.replace(/\s+/g, ' ').replace(/ · /g, ' / ').trim()

/**
 * Parks a held cue in a 待 owner file the way relay does (`- [ ] #n 问题 · 推荐:…` under `## 待 owner`),
 * numbered after the highest `#n` already there. Returns the file and the number.
 */
export function nextParkNumber(md: string): number {
  let max = 0
  for (const m of md.matchAll(/^\s*[-*]\s*\[[ xX✓]\]\s*#(\d+)/gm)) max = Math.max(max, Number(m[1]))
  return max + 1
}

export function parkInto(md: string, question: string, recommend: string): { md: string; n: number } {
  const n = nextParkNumber(md)
  const entry = `- [ ] #${n} ${oneField(question)} · 推荐:${oneField(recommend)}`
  const lines = md.replace(/\s+$/, '').split('\n')
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s*/, '').trim() === '待 owner')
  if (start < 0) return { md: `${lines.join('\n')}\n\n## 待 owner\n${entry}\n`, n }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i] ?? '')) { end = i; break }
  let at = end
  while (at > start + 1 && (lines[at - 1] ?? '').trim() === '') at--
  lines.splice(at, 0, entry)
  return { md: `${lines.join('\n')}\n`, n }
}
