// Pure rules, kept apart so the tests can call them directly.
// Everything product-specific comes from the repo's `.claude/copy-lint.json`.

export type Banned = {
  // A literal word or phrase (case-sensitive) ...
  word?: string
  // ... or a regular expression source, with `flags` (e.g. "i").
  pattern?: string
  flags?: string
  // Why it is banned / what to write instead; shown to the model.
  reason?: string
}

export type Config = {
  // Globs, relative to the directory holding `.claude/`, of files that count as public copy.
  include: string[]
  // Globs excluded even when included (e.g. the style guide itself, which quotes the banned words).
  exclude: string[]
  banned: Banned[]
  // Characters a heading must not end with, e.g. "。." ; empty turns the check off.
  headingNoTrailing: string
  // A doc the model should read before fixing, e.g. "docs/style-guide.md".
  guide: string | null
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

// Null when the file is absent, broken or has nothing to check: the mod then does nothing.
export function parseConfig(text: string | null): Config | null {
  if (text === null) return null
  let j: Record<string, unknown>
  try {
    j = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof j !== 'object' || j === null) return null
  const include = strings(j.include)
  if (include.length === 0) return null
  const banned = (Array.isArray(j.banned) ? j.banned : [])
    .map((b): Banned | null => {
      if (typeof b === 'string') return { word: b }
      if (typeof b !== 'object' || b === null) return null
      const o = b as Record<string, unknown>
      const out: Banned = {}
      if (typeof o.word === 'string' && o.word) out.word = o.word
      if (typeof o.pattern === 'string' && o.pattern) out.pattern = o.pattern
      if (typeof o.flags === 'string') out.flags = o.flags
      if (typeof o.reason === 'string' && o.reason) out.reason = o.reason
      return out.word || out.pattern ? out : null
    })
    .filter((b): b is Banned => b !== null)
  return {
    include,
    exclude: strings(j.exclude),
    banned,
    headingNoTrailing: typeof j.headingNoTrailing === 'string' ? j.headingNoTrailing : '',
    guide: typeof j.guide === 'string' && j.guide ? j.guide : null,
  }
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// `**` any depth, `*` and `?` within one segment, `{a,b}` alternatives.
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/'
        re += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end < 0) re += '\\{'
      else {
        re += `(?:${glob.slice(i + 1, end).split(',').map(escape).join('|')})`
        i = end
      }
    } else re += escape(c)
  }
  return new RegExp(`^${re}$`)
}

// `rel` is the path relative to the directory holding `.claude/`.
export const isCopyPath = (rel: string, config: Config): boolean =>
  config.include.some(g => globToRegExp(g).test(rel)) && !config.exclude.some(g => globToRegExp(g).test(rel))

export function lint(text: string, config: Config): string[] {
  const out: string[] = []
  const found: string[] = []
  for (const b of config.banned) {
    let hit: string | null = null
    if (b.word !== undefined) hit = text.includes(b.word) ? b.word : null
    else if (b.pattern !== undefined) {
      try {
        const m = new RegExp(b.pattern, (b.flags ?? '').replace(/g/g, '')).exec(text)
        hit = m ? m[0] : null
      } catch {
        hit = null
      }
    }
    if (hit !== null) found.push(b.reason ? `「${hit}」(${b.reason})` : `「${hit}」`)
  }
  if (found.length > 0) out.push(`禁用词:${found.join('、')}`)

  if (config.headingNoTrailing) {
    const end = `[${escape(config.headingNoTrailing)}]`
    const md = new RegExp(`^#{1,6}\\s.*${end}\\s*$`)
    const json = new RegExp(`"(title|heading|headline|h1|h2)[^"]*"\\s*:\\s*"[^"]*${end}"`, 'i')
    const headings = text
      .split('\n')
      .filter(l => md.test(l) || json.test(l))
      .map(l => l.trim().slice(0, 40))
    if (headings.length > 0) out.push(`标题以标点结尾:${headings.join(' | ')}`)
  }
  return out
}
