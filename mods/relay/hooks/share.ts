// /handoff: a handoff prompt of this chat written beside it ($.model.fork), for a teammate or a fresh window.
// No turn, no /clear: relay's own /relay go stays the way to hand off and clear. Pure parts here, the run in register.

import type { SessionMessage } from 'claude-code'

import type { GoStage, ShareStep } from '../types'

export const SHARE_LABELS = ['读会话', '找用过的文件', '列技能、工具和链接', '写交接', '保存并核对'] as const

export const freshSteps = (): ShareStep[] => SHARE_LABELS.map(label => ({ label, detail: '', status: 'wait', progress: 0 }))

export type Gathered = { files: string[]; skills: string[]; links: string[] }

const PATH_RE = /(?:~|\/home|\/mnt)\/[^\s'"`<>()|;,*]+/g
const URL_RE = /https?:\/\/[^\s'"`<>()\]]+/g

/** Paths the chat read or changed, most used first (writes weigh 3, reads 2, a path in a Bash command 1). */
export function rankFiles(messages: readonly SessionMessage[], home: string): string[] {
  const count = new Map<string, number>()
  const add = (raw: string, weight: number): void => {
    let p = raw.replace(/[.:]+$/, '')
    if (p.startsWith('~/')) p = home + p.slice(1)
    if (p.includes('/.claude/projects/') || p.includes('/tool-results/') || p.startsWith('/tmp')) return
    count.set(p, (count.get(p) ?? 0) + weight)
  }
  for (const m of messages) {
    for (const u of m.toolUses) {
      const input = u.input as Record<string, unknown>
      const fp = input.file_path ?? input.notebook_path ?? input.path
      if (typeof fp === 'string' && fp.startsWith('/')) add(fp, u.tool === 'Read' ? 2 : 3)
      if (u.tool === 'Bash' && typeof input.command === 'string') for (const hit of input.command.match(PATH_RE) ?? []) add(hit, 1)
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)
}

export function skillsOf(messages: readonly SessionMessage[]): string[] {
  const skills = new Set<string>()
  const servers = new Set<string>()
  for (const m of messages) {
    for (const u of m.toolUses) {
      const input = u.input as Record<string, unknown>
      if (u.tool === 'Skill' && typeof input.skill === 'string') skills.add(`/${input.skill}`)
      if (u.tool.startsWith('mcp__')) servers.add(u.tool.split('__')[1] ?? u.tool)
    }
  }
  return [...skills, ...[...servers].map(s => `MCP ${s}`)]
}

export function linksOf(messages: readonly SessionMessage[]): string[] {
  const links = new Set<string>()
  for (const m of messages) {
    for (const hit of m.text.match(URL_RE) ?? []) {
      const url = hit.replace(/[.,:;]+$/, '')
      if (!/localhost|127\.0\.0\.1|example\.com/.test(url)) links.add(url)
    }
  }
  return [...links].slice(-20)
}

const list = (xs: readonly string[]): string => (xs.length ? xs.map(x => `- ${x}`).join('\n') : '- 没找到')

export function sharePrompt(cwd: string, g: Gathered): string {
  return `给一个全新的 Claude Code 会话写一份交接 prompt,让它接着做这件事。不要调用任何工具。只回交接本身:不要开场白,不要用代码块包起来。

读者从空上下文开始。它能打开这台机器上的文件,但看不到这段对话。CLAUDE.md、AGENTS.md 和记忆索引它会自己加载,不要重复。读者也可能是 owner 的同事,所以只写对接手有用的事实。

relay 从会话记录里抽出的事实(对照你记得的核对;对下一步没用的删掉):
工作目录:${cwd}
读过或改过的文件,用得最多的在前:
${list(g.files)}
用过的技能和 MCP:
${list(g.skills)}
对话里的链接:
${list(g.links)}

按下面的形状写,中文,短句。没内容的节整节省掉。

# 交接:<目标,几个字>

在 \`${cwd}\` 接着做。目标:<用户眼下要做成什么>。

## 用户要过什么
这段对话里的每个请求,按顺序,保留用户原话里的关键词。每条标:已完成 / 进行中 / 没开始。

## 现在到哪了
做完并核过的、关键决定和理由、测过什么没测过什么。

## 用户定的规矩
这段对话里给的长期约束和偏好:禁用词、绝不做的事、要谁批、语气。

## 先打开这些文件
- \`<路径>\`:一行说为什么。只列下一步要用的,最多 15 个。只写路径,不抄文件内容。

## 用哪些技能和工具
- \`<技能 / CLI / 连接器>\`:什么时候用,这段对话里踩过的坑。

## 已经解决的错误
- <错误>:<怎么修的>。

## 只在对话里的数据
磁盘上哪里都没有的:id、URL、数字、只在对话里出现的决定。原样照抄。

## 下一步
1. 紧接着要做的那一步,具体到不用再问就能开工。

绝不写 API key、token、密码;写它放在哪里(比如「在 ~/.config/myapp/」)。全文控制在 1500 字以内。`
}

/** A plain handoff from the transcript alone, saved before the model step: a failed or slow fork still leaves something. */
export function draftText(cwd: string, messages: readonly SessionMessage[], g: Gathered): string {
  const asks = messages
    .filter(m => m.role === 'user' && m.text.trim() && !m.text.trim().startsWith('<'))
    .slice(-25)
    .map(m => `- ${m.text.trim().replace(/\s+/g, ' ').slice(0, 300)}`)
  return `# 交接草稿(没经过模型)

在 \`${cwd}\` 接着做。这份草稿是模型写完整交接之前存下的。先读下面的请求、打开文件,再问用户下一步做什么。

## 用户要过什么(最新的在最后)
${asks.join('\n') || '- 没找到'}

## 先打开这些文件
${list(g.files.slice(0, 15).map(f => `\`${f}\``))}

## 用过的技能和工具
${list(g.skills)}

## 对话里的链接
${list(g.links)}
`
}

/** Anything shaped like a secret is cut before the handoff is saved or copied. */
export function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})\b/g, '<已删去密钥>')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{20,}/g, '$1<已删去密钥>')
}

export const unfence = (text: string): string => text.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, '$1')

/** `YYYY-MM-DD-HHMM` in local time. */
export function stamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/** One thick bar of `width` cells: the filled part and the rest. */
export function bar(progress: number, width: number): { on: string; off: string } {
  const filled = Math.round(Math.max(0, Math.min(1, progress)) * width)
  return { on: '━'.repeat(filled), off: '━'.repeat(width - filled) }
}

/** The steps of a /relay go or auto handoff, from relay's own handoff phase and the clear's stage. */
export const GO_LABELS = ['写交接', '等子 agent 和这一轮结束', '补存 checkpoint', '写原文旁车', '/clear 并续接'] as const
export function goSteps(phase: string, stage: GoStage): ShareStep[] {
  const at = phase === 'armed' ? 0 : stage === 'flush' ? 2 : stage === 'side' ? 3 : stage === 'clear' ? 4 : 1
  return GO_LABELS.map((label, i) => ({
    label,
    detail: '',
    status: i < at ? 'done' : i === at ? 'run' : 'wait',
    progress: i < at ? 1 : i === at ? 0.5 : 0,
  }))
}
