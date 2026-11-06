// Mechanical checks from myapp CLAUDE.md「写作铁律」and docs/marketing/voice.md.

// Files holding outward copy: marketing docs, web messages / content, video scripts.
const COPY_PATH = /\/repos\/myapp[^/]*\/(docs\/marketing\/|apps\/web\/messages\/|apps\/web\/content\/|docs\/plan\/[^/]+\/(video|mkt)\/)/

export const isCopyPath = (path: string): boolean => COPY_PATH.test(path) && !/\/voice\.md$/.test(path)

// myapp 的其余 .md(文档 · 任务书 · 契约)只查固定义项的禁用词;列出禁用词表本身的几份不查。
const DOC_PATH = /\/repos\/myapp[^/]*\/(?:[^/]+\/)*[^/]+\.md$/
const RULE_FILES = /\/(CLAUDE|AGENTS)\.md$|\/docs\/marketing\/voice\.md$|\/docs\/process\/executor-brief\.md$|\/\.claude\//
export const isDocPath = (path: string): boolean => DOC_PATH.test(path) && !RULE_FILES.test(path) && !isCopyPath(path)
const DOC_BANNED = ['落盘', '压实', '拉通', '拉齐', '打通', '闭环', '收口', '抓手', '赋能', '打法', '组合拳', '击穿', '引爆', '撬动', '卡位', '造势', '借势', '心智', '体感', '搞定', '妥了']
export function lintDoc(text: string): string[] {
  const words = DOC_BANNED.filter(w => text.includes(w))
  return words.length ? [`禁用词:${words.join('、')}`] : []
}

const BANNED = [
  '落盘', '压实', '拉通', '拉齐', '对齐', '打通', '闭环', '收口', '抓手', '赋能', '沉淀',
  '打法', '组合拳', '击穿', '引爆', '撬动', '卡位', '造势', '借势', '心智', '体感', '搞定', '妥了',
]
const RETIRED = [/ei maksukorttia/i]

export function lint(text: string): string[] {
  const out: string[] = []
  const words = BANNED.filter(w => text.includes(w))
  if (words.length > 0) out.push(`禁用词:${words.join('、')}`)
  for (const re of RETIRED) if (re.test(text)) out.push(`已废的片尾句:${re.source}(片尾只留「Kokeile MyApp 90 päivää maksutta」)`)
  const headings = text
    .split('\n')
    .filter(l => /^#{1,6}\s.*。\s*$/.test(l) || /"(title|heading|headline|h1|h2)[^"]*"\s*:\s*"[^"]*。"/i.test(l))
    .map(l => l.trim().slice(0, 40))
  if (headings.length > 0) out.push(`标题以句号结尾:${headings.join(' | ')}`)
  return out
}
