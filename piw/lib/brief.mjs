// The one brief parser behind the factory (F1a, docs/plan/f1a-factory-brief.md). Pure: it reads the text it is
// handed, nothing else — no fs, no git, no dependencies.
//
// Two copies of this file exist and must stay byte-identical: factory/lib/brief.mjs is the original, and
// delegate/hooks/brief.mjs is the one the plugin loads, because a plugin installed under
// ~/.claude/plugins/cache cannot import across directories. `node factory/bin/brief-sync.mjs --check` decides
// whether they still match; edit the original, then copy it over.
//
// Two shapes of brief, and the caller always learns which one it got:
//   frontmatter  a `---` fenced block on the first lines, `键: 值` per line (half- or full-width colon).
//                It owns every field; the body's 「允许改动:」 line is not read at all.
//   legacy       no block: only 「允许改动:」 is read, exactly as delegate's guard read it before F1a, so a
//                brief that predates frontmatter keeps the verdict it has always had. The other fields are
//                left empty on purpose — the ruling froze `allowed` for legacy and no reader exists yet for
//                the rest, and guessing them out of prose would be a new rule nobody asked for.

const LEVELS = ['L1', 'L2', 'L3']

/**
 * What a brief says about itself. `source` is which shape answered; `allowed` is null when the brief names no
 * 允许改动 at all (nothing to check) and [] when it names an empty one (the gap is real), which is the one
 * distinction a scope gate has to make. `forbidden` is null / [] on the same terms. The other fields are only
 * filled in from a frontmatter block.
 */
export function parseBrief(text) {
  const lines = text.split('\n')
  const block = frontmatterOf(lines)
  if (!block) return { source: 'legacy', level: null, allowed: legacyAllowed(lines), forbidden: null, signatures: null, methods: [], recomputed: null }

  const fields = new Map()
  for (const line of block) {
    const pair = keyValue(line)
    // First one wins, the way the legacy reader takes the first matching line: a repeated key is not merged.
    if (pair && !fields.has(pair[0])) fields.set(pair[0], pair[1])
  }
  const level = fields.get('级别') ?? ''
  const recomputed = fields.get('期望值已重算') ?? ''
  return {
    source: 'frontmatter',
    level: LEVELS.includes(level) ? level : null,
    // A key the block does not carry stays null; an empty value is an empty list, not a missing one.
    allowed: fields.has('允许改动') ? allowedEntries(fields.get('允许改动')) : null,
    // 不许碰 is a key of the block or nothing at all (F3b-a): the body's 「不许碰」 line is prose, never read,
    // so a legacy brief has no forbidden list and says so with null rather than guessing one out of it.
    forbidden: fields.has('不许碰') ? forbiddenEntries(fields.get('不许碰')) : null,
    signatures: fields.get('对外签名') ?? null,
    methods: (fields.get('借的方法') ?? '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
    // Only 是 and 否 are recorded. Anything else stays null rather than becoming false: "not written down" and
    // "computed and false" are different facts, and this field exists to keep them apart.
    recomputed: recomputed === '是' ? true : recomputed === '否' ? false : null,
  }
}

/** The brief's allowed paths as plain strings, or null when the brief names none (the shape gates want). */
export function allowedList(text) {
  return parseBrief(text).allowed?.map(p => p.path) ?? null
}

/** The lines between a leading `---` fence and the next one, or null when there is no fenced block at all. */
function frontmatterOf(lines) {
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  // No closing fence: this was not a block (a leading horizontal rule, a half-written brief). Read it as a
  // legacy brief rather than dropping the keys it does have.
  return end < 0 ? null : lines.slice(1, end)
}

/** One `键: 值` line of a block, both halves trimmed; null when the line is not one. */
function keyValue(line) {
  const m = /^([^:：]+)\s*[:：]\s*(.*)$/.exec(line.trim())
  return m ? [m[1].trim(), m[2].trim()] : null
}

// The legacy reader, moved over verbatim from delegate/hooks/logic.ts (its `allowedPaths`, before F1a):
// ** stripped, both ends trimmed, the first line starting with 「允许改动」 wins, its value split on commas,
// 、 and whitespace, a `(新建)` that stands on its own marks the path before it. The one addition is the
// full-width paren, which the task book asks for and which changes nothing for any brief written since —
// the replay in brief.test.mjs is what proves it.
const ALLOWED_KEY = /^允许改动\s*[::]/

function legacyAllowed(lines) {
  const line = lines.map(l => l.replace(/\*\*/g, '').trim()).find(l => ALLOWED_KEY.test(l))
  if (line === undefined) return null
  return allowedEntries(line.replace(ALLOWED_KEY, ''))
}

/**
 * A 「不许碰」 value → one path per token, backticks off. No `(新建)` marks here: a forbidden list says nothing
 * about age, so the tokens go out as written.
 */
function forbiddenEntries(value) {
  return value.split(/[,，\s]+/).map(s => s.replace(/`/g, '').trim()).filter(Boolean)
}

/** A 「允许改动」 value → one entry per path, each marked when the brief says it is new (`(新建)`). */
function allowedEntries(value) {
  const out = []
  for (const raw of value.split(/[,,、\s]+/)) {
    const s = raw.replace(/[`'"]/g, '').trim()
    if (!s) continue
    if (/^[（(]?新建[）)]?$/.test(s)) {
      const last = out.at(-1)
      if (last) last.isNew = true
      continue
    }
    const isNew = /[（(]新建[）)]$/.test(s)
    out.push({ path: s.replace(/[（(]新建[）)]$/, ''), isNew })
  }
  return out
}
