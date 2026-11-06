#!/usr/bin/env node
// 空转判官:读 lead 会话记录(Claude Code 的 *.jsonl),点名两类事。
//
// ① 停在问 owner 上:这一轮不是 owner 推的(叫醒 · 后台回执 · /loop · relay 续跑 · 别的会话),回答停在问句或
//    「你定了以后 / 等你拍板」上,没有 relay 认可的停法(`RELAY: owner|done` 由 relay 挂单或验收),
//    之后同一会话超过 --gap 分钟没有下一条消息。
// ② 早上的空等:窗口里 owner 发第一条消息之前,每个会话最后一轮结束到这条消息之间,lead 闲着,
//    而它最后一轮既不是 relay 的停机汇总(`relay:` 汇总那轮后面不再有续跑),也没写 `RELAY: done`。
//
// 用法:node stall-scan.mjs [--since ISO] [--until ISO] [--gap 15] [--json] [文件或目录 …]
// 默认读 ~/.claude/projects/-home-owner-repos-myapp/。退出码:有 ① 的条目退 1,否则 0。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { asksNick, lines, sanctioned } from '../hooks/asks.ts'

export { asksNick, sanctioned }

/** owner 自己推的:键盘 / 手机,或 cue 替他按下「发送」。 */
export function byNick(origin) {
  if (!origin) return true // 老记录没有 origin:按人打的算,宁可漏报不误报
  if (origin.kind === 'human' || origin.kind === 'bridge' || origin.kind === 'composer') return true
  return origin.kind === 'plugin' && origin.name === 'cue' && origin.asUser === true
}

function readRecords(file) {
  const out = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw) continue
    try {
      const r = JSON.parse(raw)
      if (r && r.timestamp) out.push(r)
    } catch {
      // 半行(会话还在写):跳过
    }
  }
  return out
}

const isPrompt = (r) => r.type === 'user' && typeof r.message?.content === 'string' && !r.isMeta
const text = (r) =>
  Array.isArray(r.message?.content) ? r.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('') : ''

/** 一个会话文件 → 每一轮:谁推的、回答全文、结束时刻、下一条消息时刻。 */
export function turns(records) {
  const out = []
  let prompt = null
  let answer = ''
  let lastAt = null
  const close = (nextAt) => {
    if (prompt && answer) out.push({ origin: prompt.origin, promptAt: prompt.timestamp, answer, endAt: lastAt, nextAt })
  }
  for (const r of records) {
    if (isPrompt(r)) {
      close(r.timestamp)
      prompt = r
      answer = ''
      lastAt = null
    } else if (r.type === 'assistant') {
      const t = text(r)
      if (t) {
        answer = t
        lastAt = r.timestamp
      }
    }
  }
  close(null)
  return out
}

export function scan(files, { since = '', until = new Date().toISOString(), gapMin = 15 } = {}) {
  const stalls = []
  const morning = []
  const sessions = files.map((f) => ({ file: f, records: readRecords(f) }))
  // 早上那条:owner 在窗口里最长一段沉默(睡觉)之后的第一条。窗口常从前一晚开始,取最早一条会取到睡前那条
  const nickAt = []
  for (const s of sessions)
    for (const r of s.records)
      if (isPrompt(r) && r.timestamp > since && r.timestamp < until && byNick(r.origin) && r.origin) nickAt.push(r.timestamp)
  nickAt.sort()
  let firstNick = null
  let longest = -1
  nickAt.forEach((t, i) => {
    const gap = Date.parse(t) - (i ? Date.parse(nickAt[i - 1]) : since ? Date.parse(since) : 0)
    if (gap > longest) [firstNick, longest] = [t, gap]
  })
  for (const s of sessions) {
    const id = s.file.split('/').pop().slice(0, 8)
    const ts = turns(s.records).filter((t) => t.endAt > since && t.endAt < until)
    for (const t of ts) {
      if (byNick(t.origin) || sanctioned(t.answer) || !asksNick(t.answer)) continue
      const end = t.nextAt ?? until
      const idle = (Date.parse(end) - Date.parse(t.endAt)) / 60_000
      if (idle <= gapMin) continue
      stalls.push({ session: id, at: t.endAt, idleMin: Math.round(idle), by: t.origin?.kind ?? '?', tail: lines(t.answer).slice(-2).join(' / ').slice(0, 160) })
    }
    if (firstNick) {
      const before = ts.filter((t) => t.endAt < firstNick)
      const last = before[before.length - 1]
      // 交接后清空的会话由下一个会话接着跑,它的空等不算在这里
      if (last && !byNick(last.origin) && !/^[>*_`\s]*RELAY\s*[:：]\s*done\b/im.test(last.answer) && !/^\s*HANDOFF-READY\s*$/m.test(last.answer) && (last.nextAt === null || last.nextAt >= firstNick)) {
        const idle = (Date.parse(firstNick) - Date.parse(last.endAt)) / 60_000
        morning.push({ session: id, at: last.endAt, idleMin: Math.round(idle), tail: lines(last.answer).slice(-1).join('').slice(0, 120) })
      }
    }
  }
  stalls.sort((a, b) => a.at.localeCompare(b.at))
  return { firstNick, stalls, morning }
}

function main(argv) {
  const opt = { since: '', until: new Date().toISOString(), gapMin: 15 }
  const paths = []
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--since') opt.since = argv[++i]
    else if (a === '--until') opt.until = argv[++i]
    else if (a === '--gap') opt.gapMin = Number(argv[++i])
    else if (a === '--json') json = true
    else paths.push(a)
  }
  if (!paths.length) paths.push(join(homedir(), '.claude/projects/-home-owner-repos-myapp'))
  const files = paths.flatMap((p) =>
    statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith('.jsonl')).map((f) => join(p, f)) : [p],
  )
  const live = files.filter((f) => !opt.since || statSync(f).mtime.toISOString() > opt.since)
  const r = scan(live, opt)
  if (json) console.log(JSON.stringify(r, null, 2))
  else {
    console.log(`① 停在问 owner 上、之后 > ${opt.gapMin} 分钟没动静:${r.stalls.length} 条`)
    for (const s of r.stalls) console.log(`  ${s.session} ${s.at.slice(5, 16)}Z 闲 ${s.idleMin} 分 · 推它的:${s.by} · ${s.tail}`)
    console.log(`② owner 第一条消息:${r.firstNick ?? '(窗口里没有)'};之前各会话最后一轮到它的空等:`)
    for (const m of r.morning) console.log(`  ${m.session} ${m.at.slice(5, 16)}Z 闲 ${m.idleMin} 分 · ${m.tail}`)
    const worst = Math.max(0, ...r.morning.map((m) => m.idleMin))
    console.log(`② 最长空等 ${worst} 分(判据 ≤ ${opt.gapMin})`)
  }
  return r.stalls.length ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
