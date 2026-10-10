import type { EngineInterface, Register } from 'claude-code'

import { isCopyPath, lint, parseConfig } from './lint'
import type { Config } from './lint'

const CONFIG = '.claude/copy-lint.json'

// The nearest `.claude/copy-lint.json` above the file, stopping at the repo root (a `.git`).
async function findConfig($: EngineInterface, file: string): Promise<{ base: string; config: Config } | null> {
  let dir = file.replace(/\/[^/]*$/, '')
  while (dir !== '') {
    const path = `${dir}/${CONFIG}`
    if (await $.fs.exists(path)) {
      const text = await $.fs.read(path).then(t => t as string, () => null)
      const config = parseConfig(text)
      return config ? { base: dir, config } : null
    }
    if (await $.fs.exists(`${dir}/.git`)) return null
    dir = dir.replace(/\/[^/]*$/, '')
  }
  return null
}

export const register: Register = on => {
  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || !e.file_path.startsWith('/')) return ran
    const found = await findConfig($, e.file_path)
    if (!found) return ran
    const rel = e.file_path.slice(found.base.length + 1)
    if (!isCopyPath(rel, found.config)) return ran
    const text = e.tool === 'Write' ? e.content : e.new_string
    const hits = lint(text, found.config)
    if (hits.length === 0) return ran
    const guide = found.config.guide ? `对照 ${found.config.guide} ` : ''
    const note = `copy-lint(${e.file_path}):${hits.join(';')}。${guide}改掉;代码标识符里的不算。`
    return { ...ran, context: [...(ran.context ?? []), note] }
    // Only ever a hint: a fault here must not touch the write.
  }).catch(($, e, next) => next(e))
}
