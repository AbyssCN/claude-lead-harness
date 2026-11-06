import type { EngineInterface, Register } from 'claude-code'

import { isCopyPath, isDocPath, lint, lintDoc } from './lint'

// 每次判完写一行 ~/.omd-lite/discipline.jsonl(myapp 纪律普查 R17 读它)。
async function log($: EngineInterface, hit: boolean, detail: string) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), check: 'copy-lint', hit: hit ? 1 : 0, detail: detail.slice(0, 200) })}\n`
  try { await $.process.run(['sh', '-c', 'mkdir -p "$HOME/.omd-lite" && cat >> "$HOME/.omd-lite/discipline.jsonl"'], { stdin: line }) } catch {}
}

export const register: Register = on => {
  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const ran = await next(e)
    const copy = isCopyPath(e.file_path)
    if (ran.deny !== undefined || ran.isError === true || !(copy || isDocPath(e.file_path))) return ran
    const text = e.tool === 'Write' ? e.content : e.new_string
    const hits = copy ? lint(text) : lintDoc(text)
    await log($, hits.length > 0, `${e.file_path} ${hits.join(';')}`)
    if (hits.length === 0) return ran
    const note = `copy-lint(${e.file_path}):${hits.join(';')}。对照 docs/marketing/voice.md 和 CLAUDE.md 写作铁律改掉;代码标识符里的不算。`
    return { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))
}
