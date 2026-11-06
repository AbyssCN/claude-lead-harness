#!/usr/bin/env node
// 交接判官:读会话记录(Claude Code 的 *.jsonl),量 relay 的交接到底把上下文稳住没有。零模型。
//
// ① 每个 owner 的会话:cache_read_input_tokens 超过 400k 的请求数(判据 ≤ 20)、超过 550k 的(判据 0)、峰值;
//    compact_boundary 次数(判据 0)。
// ② 轮中冲高:一轮从 400k 以下开始、轮内超过 550k —— 轮末才交接挡不住的那种。
// ③ 每次 armed(「[relay] 上下文已到 Nk。…写交接到 <path>」)的去向:cleared(之后某个会话的第一条是
//    「[relay] 上一段上下文已自动清空。先读交接 <path>」)· cancelled(没清、owner 说过话)· stuck(没清、
//    owner 没说话、过了 35 分钟)· pending(还不到 35 分钟)。GOAL 期间:35 分钟内 cleared 的比例(判据 ≥ 95%,
//    owner 说话取消的不进分母)、stuck 条数(判据 0)。
// ④ 每次 cleared:新会话第一轮用 SendUserFile 把旁车 <交接>.last.md 发给 owner(原文不进 prompt、不让模型复述,
//    10-23 逐字复述引来 reasoning_extraction);新会话之后至少 3 次工具调用且没被拦停,算接着干下去了(判据 ≥ CONTINUE_BASE)。
// ⑥ safeguards 拦停:~/.claude/projects 下全部会话里 model_refusal 按类别计数;reasoning_extraction 判据 0。
// ⑤ /goal:/goal 到 GOAL.md 落盘 p90 ≤ 90 秒;落盘到 lead 收到激活(工具结果里的 note 或开工 prompt)≤ 30 秒;
//    lead 自己 Write 覆盖 0 次;写出的 GOAL 没有模板提示、没有「(待补:」。落盘时刻读 handoff.log 的 `goal` 行。
// ⑦ 孤儿 GOAL:一条 GOAL 线断了以后多久没人接上 —— 条数、最长时长(扣掉 WSL 关机空档)、断开到恢复的秒数。
//    断了的线再和 owner.log 的 `mode` 行对账:找得到 mode 行的线落进 orphan(属主死了)、false(属主还活着)或者
//    「relay 自己停了」(不进 orphans),不再落进盲区。只读会话记录、journalctl --list-boots 的 boot 区间、/proc、
//    ~/.claude/sessions 和 owner.log 里的 `mode` 行;不读 relay 自己的 store、不读 handoff.log。
//
// 用法:node handoff-audit.mjs [--since ISO] [--until ISO] [--sessions id8,id8…] [--boots 文件] [--owner-log 文件] [--no-orphans] [--json] [目录或文件 …]
// --sessions:只量这些会话和它们续接出来的会话(每日一跑从 handoff.log 的 `start relay 0.6.0` 行取)。
// --boots:journalctl --list-boots -o json 的输出;不给就自己跑一次,跑不成当没有 boot 数据(wslDownS 记 null)。
// 默认读 ~/.claude/projects/-home-owner-repos-*(不含 worktree)。退出码:有判据没到退 1,否则 0。

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { byNick } from './stall-scan.mjs'

const OVER = 400_000
const CEIL = 550_000
const MAX_OVER = 20
const CLEAR_MIN = 35
const GOAL_WRITE_P90_S = 90
const GOAL_DELIVER_S = 30
const ARM = /\[relay\] 上下文已到 (\d+)k。[^\n]{0,80}?写交接到 (\/\S+?\.md)/
const RESUME = /\[relay\] 上一段上下文已(?:自动|按 \/relay go )?清空。[\s\S]*?读交接 (\/\S+?\.md)/
const CONTINUE_BASE = 0.92 // 改前基线:10-20 至 10-23 cleared 37 次里 34 次接着干下去
const RELAY_ASK = /^\[relay\] (上下文已到|交接没接上|子 agent 都已返回)/
// ⑦ 孤儿 GOAL
const ORPHAN_MIN = 35
// owner.log 的 mode 行:时刻可以比断开时刻晚 120 秒(契约 D-9「判官怎么用 mode 行」)
const MODE_GRACE_MS = 120_000
const CONT_PROMPT = '[relay] 按 GOAL 继续:'
const ACTIVATE_PROMPT = '[relay] GOAL 已写好并激活:'
const AUTO_CLEAR = '[relay] 上一段上下文已自动清空'
// 裁定 1:自动清空的正文里只有「激活中的 GOAL:<P>」这一句说明哪份 GOAL 在跑
const ACTIVE_GOAL = /激活中的 GOAL:(\/\S+?\.md)/
// <P> 是以 / 开头、以 GOAL.md 或 GOAL-<n>.md 结尾的绝对路径。
// 前面的 (?<![\w.\/-]) 把「docs/plan/10.13/GOAL.md」这种相对写法挡在外面(它不以 / 开头)。
const GOAL_PATH = /(?<![\w.\/-])\/[^\s"'()\[\]，。、,;；]*GOAL(?:-\d+)?\.md/g
const CMD_CLEAR = /<command-name>\/clear<\/command-name>/
const CMD_GOAL_CLEAR = /<command-name>\/goal<\/command-name>[\s\S]*?<command-args>\s*clear\b/
const CMD_RELAY_STOP = /<command-name>\/relay<\/command-name>[\s\S]*?<command-args>\s*stop\b/
// RELAY 行:回答里单独一行写的那行(可以带 ** 之类的 markdown 装饰)
const RELAY_LINE = /^(?:[*_`>\s]*)RELAY\s*[:：]/i
const RELAY_DONE = /RELAY\s*[:：]\s*done\b/i
// relay 自己停了的提醒:上一轮没有以 RELAY 行收尾,或者上一轮不是 owner 推的
const RELAY_HALTED = /^\[relay\] 上一轮(没有以 RELAY 行收尾|不是 owner 推的)/

function readRecords(file) {
  const out = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw) continue
    try {
      const r = JSON.parse(raw)
      if (r && r.timestamp && !r.isSidechain) out.push(r)
    } catch {
      // 半行(会话还在写):跳过
    }
  }
  return out
}

const promptText = (r) => {
  const c = r.message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c) || c.some((x) => x?.type === 'tool_result')) return null
  const t = c.filter((x) => x?.type === 'text').map((x) => x.text)
  return t.length || c.some((x) => x?.type === 'image') ? t.join('\n') : null
}
const isPrompt = (r) => r.type === 'user' && !r.isMeta && r.toolUseResult === undefined && promptText(r) !== null
const nickSaid = (r) => isPrompt(r) && r.origin && byNick(r.origin) && !promptText(r).startsWith('<command-')
const assistantText = (r) =>
  Array.isArray(r.message?.content) ? r.message.content.filter((c) => c?.type === 'text').map((c) => c.text).join('') : ''
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/^\s*HANDOFF-READY\s*$/gm, '').trim()
const ms = (t) => Date.parse(t)

/** 一个会话 → 轮:推它的 prompt、轮内每次请求的 cache_read、各条回答文字。 */
function turnsOf(records) {
  const out = []
  let cur = null
  const seen = new Set()
  for (const r of records) {
    if (isPrompt(r)) {
      cur = { prompt: r, text: promptText(r), reads: [], texts: [] }
      out.push(cur)
    } else if (r.type === 'assistant' && cur) {
      const id = r.message?.id
      const u = r.message?.usage
      if (u && !(id && seen.has(id))) {
        if (id) seen.add(id)
        cur.reads.push(u.cache_read_input_tokens ?? 0)
      }
      const t = assistantText(r)
      if (t) cur.texts.push(t)
    }
  }
  return out
}

export function audit(paths, { since = '', until = '9999', only = null, log = '', boots = [], sessionsDir = join(homedir(), '.claude/sessions'), procRoot = '/proc', ownerLog = '', orphans: withOrphans = true } = {}) {
  const files = paths.flatMap((p) =>
    statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith('.jsonl')).map((f) => join(p, f)) : [p],
  )
  const all = files.map((f) => {
    const records = readRecords(f).filter((r) => r.timestamp >= since && r.timestamp <= until)
    const name = f.split('/').pop()
    const talk = talkRecords(records)
    return {
      session: name.slice(0, 8),
      id: name.replace(/\.jsonl$/, ''),
      dir: dirname(f),
      firstAt: records[0]?.timestamp ?? '',
      lastAt: records[records.length - 1]?.timestamp ?? '',
      // 断开时刻看的是「在说话」的最后一条记录:queue-operation、cost-state、turn_duration 这些记账记录挂在
      // 会话尾巴上,不代表会话还在说话(裁定 2 的「最后一条记录」按这个口径算)。
      talkAt: talk.length ? talk[talk.length - 1].timestamp : (records[records.length - 1]?.timestamp ?? ''),
      records,
      turns: turnsOf(records),
    }
  })
  const resumes = []
  for (const s of all)
    for (const t of s.turns) {
      const m = t.text.match(RESUME)
      if (m && t.text.startsWith('[relay]')) resumes.push({ at: t.prompt.timestamp, path: m[1], s, t })
    }
  resumes.sort((a, b) => a.at.localeCompare(b.at))

  // only:给定会话,加上它们交接后续接出来的会话(一路接下去)
  let scope = all
  if (only) {
    const keep = new Set(only)
    for (let grew = true; grew; ) {
      grew = false
      for (const s of all) {
        if (!keep.has(s.session)) continue
        for (const r of s.records) {
          const raw = r.type === 'attachment' ? JSON.stringify(r.attachment ?? '') : isPrompt(r) ? promptText(r) : null
          const m = raw && raw.match(ARM)
          if (!m) continue
          for (const x of resumes) if (x.path === m[2] && x.at > r.timestamp && !keep.has(x.s.session)) (keep.add(x.s.session), (grew = true))
        }
      }
    }
    scope = all.filter((s) => keep.has(s.session))
  }

  const nickSessions = scope.filter((s) => s.records.some(nickSaid) || resumes.some((x) => x.s === s))
  const sessions = []
  const surges = []
  let compacts = 0
  for (const s of nickSessions) {
    const reads = s.turns.flatMap((t) => t.reads)
    const c = s.records.filter((r) => r.type === 'system' && r.subtype === 'compact_boundary').length
    compacts += c
    // 第一次越过 400k 的那一轮里,>400k 的请求数:交接最早也要等这一轮答完
    const cross = s.turns.find((t) => t.reads.some((x) => x > OVER))
    const crossTail = cross ? cross.reads.filter((x) => x > OVER).length : 0
    sessions.push({
      session: s.session,
      over400: reads.filter((x) => x > OVER).length,
      over550: reads.filter((x) => x > CEIL).length,
      peak: Math.max(0, ...reads),
      compacts: c,
      crossTail,
    })
    for (const t of s.turns)
      if (t.reads.length && t.reads[0] < OVER && Math.max(...t.reads) > CEIL)
        surges.push({ session: s.session, at: t.prompt.timestamp, from: t.reads[0], peak: Math.max(...t.reads), requests: t.reads.length })
  }

  const handoffs = []
  for (const s of scope) {
    const arms = []
    for (const r of s.records) {
      const raw = r.type === 'attachment' ? JSON.stringify(r.attachment ?? '') : isPrompt(r) ? promptText(r) : null
      const m = raw && raw.match(ARM)
      if (!m) continue
      const last = arms[arms.length - 1]
      if (last && last.path === m[2] && ms(r.timestamp) - ms(last.at) < 60_000) continue
      arms.push({ at: r.timestamp, k: Number(m[1]), path: m[2] })
    }
    arms.forEach((a, i) => {
      const next = arms[i + 1]?.at ?? null
      const goal = s.records.some((r) => r.timestamp <= a.at && isPrompt(r) && r.origin?.name === 'relay' && promptText(r).includes('GOAL'))
      const res = resumes.find((x) => x.path === a.path && x.at > a.at && (!next || x.at < next))
      const h = { session: s.session, at: a.at, k: a.k, path: a.path, goal }
      if (res) {
        Object.assign(h, { outcome: 'cleared', minutes: Math.round((ms(res.at) - ms(a.at)) / 60_000) }, delivered(res))
        return void handoffs.push(h)
      }
      // owner 在该清的时限内说话才算他取消的;过了时限才说话,是卡到他说话为止
      const spoke = s.records.find((r) => r.timestamp > a.at && (!next || r.timestamp < next) && nickSaid(r))
      if (spoke && ms(spoke.timestamp) - ms(a.at) <= CLEAR_MIN * 60_000) {
        h.outcome = 'cancelled'
      } else {
        const age = ((spoke ? ms(spoke.timestamp) : next ? ms(next) : ms(until) || Date.now()) - ms(a.at)) / 60_000
        h.outcome = age > CLEAR_MIN ? 'stuck' : 'pending'
        h.minutes = Math.round(age)
      }
      handoffs.push(h)
    })
  }
  handoffs.sort((a, b) => a.at.localeCompare(b.at))

  const g = handoffs.filter((h) => h.goal && h.outcome !== 'cancelled' && h.outcome !== 'pending')
  const fast = g.filter((h) => h.outcome === 'cleared' && h.minutes <= CLEAR_MIN).length
  const goal = { armed: g.length, fast, stuck: g.filter((h) => h.outcome === 'stuck').length, rate: g.length ? fast / g.length : 1 }
  const stuckAll = handoffs.filter((h) => h.outcome === 'stuck').length
  const lost = handoffs.filter((h) => h.delivered === false)
  const cleared = handoffs.filter((h) => h.outcome === 'cleared')
  const continueRate = cleared.length ? cleared.filter((h) => h.continued).length / cleared.length : 1
  const verdict = {
    over400: sessions.filter((s) => s.over400 > MAX_OVER).map((s) => s.session),
    over550: sessions.filter((s) => s.over550 > 0).map((s) => s.session),
    compacts,
    goalRate: goal.rate,
    stuck: stuckAll,
    lost: lost.length,
    continueRate,
  }
  const goals = goalsOf(all, log, since, until)
  const writes = goals.map((x) => x.writeSec).filter((x) => x !== null).sort((a, b) => a - b)
  verdict.goal = {
    writeP90: writes.length ? writes[Math.min(writes.length - 1, Math.floor(writes.length * 0.9))] : 0,
    slowDeliver: goals.filter((x) => x.deliverSec === null || x.deliverSec > GOAL_DELIVER_S).length,
    overwrites: goals.reduce((n, x) => n + x.overwrites, 0),
    unclean: goals.filter((x) => !x.clean).length,
  }
  const goalOk = verdict.goal.writeP90 <= GOAL_WRITE_P90_S && !verdict.goal.slowDeliver && !verdict.goal.overwrites && !verdict.goal.unclean
  // ⑦ 孤儿 GOAL:一条 GOAL 线断了以后多久没人接上
  // orphans: false(--no-orphans):每日一跑的主读数不量 ⑦,⑦ 另跑一遍只量 0.8.0 起的会话
  const orphans = withOrphans ? orphansOf(all, { until, boots, sessionsDir, procRoot, modes: modeLines(ownerLog), scope: only ? new Set(scope.map((x) => x.id)) : null }) : []
  // 裁定 8:三类分开记 —— 孤儿(有证据)· 盲区(没证据、连 pid 文件都没有)· 误报(没证据、pid 文件还在)
  verdict.orphans = orphans.filter((o) => o.kind === 'orphan').length
  verdict.orphanBlind = orphans.filter((o) => o.kind === 'blind').length
  verdict.orphanFalse = orphans.filter((o) => o.kind === 'false').length
  verdict.orphanMaxS = orphans.reduce((m, o) => Math.max(m, o.countedS), 0)
  verdict.pass = goalOk && !verdict.over400.length && !verdict.over550.length && !compacts && goal.rate >= 0.95 && !stuckAll && !lost.length && continueRate >= CONTINUE_BASE && !orphans.length
  const tails = sessions.filter((s) => s.crossTail > 0).map((s) => s.crossTail).sort((a, b) => a - b)
  const at = (q) => (tails.length ? tails[Math.min(tails.length - 1, Math.floor(tails.length * q))] : 0)
  const crossTail = { sessions: tails.length, median: at(0.5), p90: at(0.9), max: tails[tails.length - 1] ?? 0, over20: tails.filter((x) => x > MAX_OVER).length }
  return { sessions, surges, crossTail, handoffs, goal, goals, compacts, orphans, verdict }
}

// ⑦ 孤儿 GOAL:一条 GOAL 线(同一项目目录里同一份 <P> 的会话)在哪断了,断了以后多久没人接上。
//
// GOAL 线(裁定 1):只有三种 [relay] 记录说明 <P> 这份 GOAL 在跑,收到它们的会话就在 <P> 这条线上:
//   「[relay] 按 GOAL 继续:<P>」·「[relay] GOAL 已写好并激活:<P>」·「[relay] 上一段上下文已自动清空…」正文里的
//   「激活中的 GOAL:<P>」。自动清空的正文不管有没有 GOAL 在跑都会列出仓里最新的 GOAL.md,所以只认「激活中的
//   GOAL」这一句里的路径,正文里别处出现的 GOAL 路径不算。同一项目目录里这条线上的会话按第一条记录的时刻排。
// 断开时刻(裁定 2):线上一个会话最后一条「在说话」的记录(assistant 或 user)的时刻 —— 从那里往后,这份 GOAL
//   没人接,就是断了。记账记录(queue-operation、cost-state、turn_duration、attachment)不算说话。
// 不算断开(裁定 2,只有这几种,一条都不许多加):所有 assistant 文本里最后一个 RELAY 行是 done(之后没有 relay
//   推回)· 之后有 /goal clear 或 /relay stop · 之后 owner 自己敲的 /clear · 同目录里 relay 自己清空后接上 ·
//   relay 自己停了(最后一条 [relay] prompt 是「上一轮没有以 RELAY 行收尾」这类提醒,之后没有 RELAY 行)·
//   被别的 GOAL 顶掉 · 这个会话的属主进程还活着 · 属主进程还活着、只是换了会话。
//   没有别的规则:答完一轮、看着像正常收工的会话,照样进 orphans;没有证据就算盲区或误报(裁定 2、8)。
// 恢复时刻(裁定 3):断开之后第一条「接手 <P>」的记录的时刻 —— 「[relay] 按 GOAL 继续:<P>」或者带「激活中的
//   GOAL:<P>」的自动清空。没有就是 null。
// 孤儿(裁定 4):恢复时刻减断开时刻 > 35 分钟,或者到 --until 为止都没有恢复。
// owner.log 对账(切片 7):上面判成断了的每一条,再到 owner.log 里找那一行 `mode` —— 新 mode 是 idle / done 就是
//   relay 自己停了,这条不进 orphans;新 mode 是 running / waiting-owner 就看属主进程还在不在:不在 → orphan,
//   还在 → false(会话记录推出来的「断开」不成立)。找得到 mode 行的线不落进盲区。
function orphansOf(all, { until, boots, sessionsDir, procRoot, modes = [], scope = null }) {
  const idx = sessionIndex(sessionsDir)
  const bs = bootIntervals(boots)
  const endMs = Number.isFinite(ms(until)) ? ms(until) : Date.now()
  const lines = new Map() // 目录+<P> → 该目录里这条线上的会话
  const takes = new Map() // <P> → 接手它的时刻(接手 = relay 又把这份 GOAL 捡起来了)
  const take = (path, at) => {
    if (!takes.has(path)) takes.set(path, [])
    takes.get(path).push(at)
  }
  for (const s of all)
    for (const r of s.records) {
      if (r.type !== 'user') continue
      const t = promptText(r)
      if (!t || !t.startsWith('[relay]')) continue
      const paths = lineGoals(t)
      for (const p of paths) addTo(lines, s, p)
      // 接手(裁定 3):「按 GOAL 继续」或者带「激活中的 GOAL」的自动清空。「GOAL 已写好并激活」是开新线,不是接手。
      if (t.startsWith(CONT_PROMPT) || t.startsWith(AUTO_CLEAR)) {
        const p = paths[0]
        if (p) take(p, r.timestamp)
      }
    }
  for (const list of takes.values()) list.sort((a, b) => ms(a) - ms(b))
  const out = []
  for (const line of lines.values()) {
    const sessions = [...line.sessions].sort((a, b) => a.firstAt.localeCompare(b.firstAt) || a.lastAt.localeCompare(b.lastAt) || a.id.localeCompare(b.id))
    const took = takes.get(line.path) ?? []
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]
      // --sessions:只有范围里的会话会被记成断开;规则照样读全部会话(恢复、relay 清空后接上都要看别的会话)
      if (scope && !scope.has(s.id)) continue
      const at = ms(s.talkAt)
      if (!Number.isFinite(at)) continue
      if (notDisconnected(s, idx, procRoot, all)) continue
      const resumedAt = took.find((x) => ms(x) > at) ?? null
      const end = resumedAt ? ms(resumedAt) : endMs
      const durationS = Math.round((end - at) / 1000)
      if (durationS <= ORPHAN_MIN * 60) continue
      // 裁定 2:被别的 GOAL 顶掉(一个仓只存一份 GOAL,新的起来了,旧的不再有人接)
      const sup = supersededAt(all, s.dir, line.path, at)
      if (sup !== null && sup - at <= ORPHAN_MIN * 60_000 && (resumedAt === null || sup < ms(resumedAt))) continue
      const wslDownS = bs.length ? wslDown(bs, at, end) : null
      const evidence = evidenceOf(s, at, bs, idx, procRoot)
      const mode = findMode(modes, line.path, s.id, at)
      if (mode && (mode.to === 'idle' || mode.to === 'done')) continue // relay 自己停了,这条不进 orphans
      let kind = kindOf(evidence, idx, s.id)
      if (mode) {
        // 新 mode 是 running / waiting-owner:看属主进程还在不在(不在契约四个 mode 里的值也当属主还在,
        // 免得这条落进盲区)。属主活着 → 会话记录推出来的「断开」不成立,判成误报。
        const st = procStart(procRoot, mode.pid)
        const alive = st !== null && String(st) === String(mode.procStart)
        evidence.push(alive ? 'owner-alive' : 'owner-dead')
        kind = alive ? 'false' : 'orphan'
      }
      out.push({
        goal: line.path,
        session: s.id,
        disconnectedAt: s.talkAt,
        resumedAt,
        durationS,
        wslDownS,
        countedS: wslDownS === null ? durationS : durationS - wslDownS,
        evidence,
        kind,
      })
    }
  }
  // 裁定 5:同一个会话在 orphans 里最多出现一次(一个会话可能在两条线上都断了);留断得最久的那条。
  out.sort((a, b) => b.durationS - a.durationS || a.goal.localeCompare(b.goal))
  const kept = []
  const seen = new Set()
  for (const o of out) {
    if (seen.has(o.session)) continue
    seen.add(o.session)
    kept.push(o)
  }
  kept.sort((a, b) => a.disconnectedAt.localeCompare(b.disconnectedAt) || a.goal.localeCompare(b.goal))
  return kept
}

/** 裁定 1:这条 [relay] 记录说明哪份 GOAL 在跑。三种形状,别的形状一律不在线上。 */
function lineGoals(text) {
  if (text.startsWith(CONT_PROMPT)) return goalPaths(text.slice(CONT_PROMPT.length)).slice(0, 1)
  if (text.startsWith(ACTIVATE_PROMPT)) return goalPaths(text.slice(ACTIVATE_PROMPT.length)).slice(0, 1)
  if (text.startsWith(AUTO_CLEAR)) {
    const m = text.match(ACTIVE_GOAL)
    return m ? [m[1]] : []
  }
  return []
}

/** 裁定 8:有证据是孤儿;没证据就看 sessions 目录里还有没有它的 pid 文件 —— 没有是盲区,有是误报。 */
function kindOf(evidence, idx, sessionId) {
  if (evidence.length) return 'orphan'
  return idx.has(sessionId) ? 'false' : 'blind'
}

/** owner.log 里的 `mode` 行(D-12):`<ISO> mode <cwd> <goalPath> <sid8> <pid> <procStart> <from>-><to> <why>[ <旧 sid8>]`。
 *  列数不是 9 或 10、第 2 列不是 mode 的行一律跳过;路径里的空格写成 %20,比较前还原。文件不在当空文件。 */
function modeLines(file) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const raw of text.split('\n')) {
    const c = raw.trim().split(/\s+/)
    if (c.length !== 9 && c.length !== 10) continue
    if (c[1] !== 'mode') continue
    const at = ms(c[0])
    if (!Number.isFinite(at)) continue
    const t = c[7].split('->')
    if (t.length !== 2) continue
    out.push({ at, goal: c[3], sid8: c[4], pid: c[5], procStart: c[6], from: t[0], to: t[1], why: c[8] })
  }
  return out
}

/** 找 owner.log 里那一行 `mode`:第 4 列是这条线的 <P>、第 5 列是断开那个会话的 sid8、时刻不晚于断开时刻加 120 秒;
 *  符合的取文件里最后一行。路径两边都还原(%20 → 空格)再比。 */
function findMode(modes, path, sessionId, at) {
  const sid8 = sessionId.slice(0, 8)
  let hit = null
  for (const m of modes) {
    if (restore(m.goal) !== restore(path)) continue
    if (m.sid8 !== sid8) continue
    if (m.at > at + MODE_GRACE_MS) continue
    hit = m
  }
  return hit
}

/** owner.log 里路径的空格写成 %20,比较前还原。 */
const restore = (s) => s.replace(/%20/g, ' ')

/** 裁定 2:被别的 GOAL 顶掉 —— 同一目录里别的 <P'> 在断开之后被「按 GOAL 继续」或「GOAL 已写好并激活」捡起来了。 */
function supersededAt(all, dir, path, at) {
  let best = null
  for (const o of all) {
    if (o.dir !== dir) continue
    for (const r of o.records) {
      if (r.type !== 'user') continue
      const t = promptText(r) ?? ''
      const m = t.match(/^\[relay\] (?:按 GOAL 继续:|GOAL 已写好并激活:)(\/\S+?\.md)/)
      if (!m || m[1] === path) continue
      const x = ms(r.timestamp)
      if (x > at && (best === null || x < best)) best = x
    }
  }
  return best
}

/** 裁定 1:一段正文里出现的 GOAL 路径。 */
function goalPaths(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(GOAL_PATH)) out.push(m[0])
  return out
}

const addTo = (lines, s, path) => {
  const key = `${s.dir}\u0000${path}`
  if (!lines.has(key)) lines.set(key, { path, dir: s.dir, sessions: new Set() })
  lines.get(key).sessions.add(s)
}

/** 这条线是「停完了」还是「断了」:裁定 2 列的八条,一条都不许多加。 */
function notDisconnected(last, idx, procRoot, all) {
  const recs = last.records
  // (1) relay 自己清空后接上:同一目录里别的会话,它的自动清空 prompt 点名了 <仓>-<本会话 id 前 8 位>.md 或 .last.md
  //     —— 说明清空那一刻本进程还活着,这份 GOAL 是 relay 自己接走的
  const id8 = last.id.slice(0, 8)
  const named = new RegExp(`-${id8}\\.(last\\.)?md`)
  const succ = all.find(
    (o) =>
      o.dir === last.dir &&
      o.id !== last.id &&
      o.records.some((r) => {
        if (r.type !== 'user') return false
        const t = promptText(r) ?? ''
        return t.startsWith(AUTO_CLEAR) && named.test(t)
      }),
  )
  if (succ) return true
  // (2) owner 自己敲了 /clear,下一个会话开头:来源不是插件、在本会话最后一条说话记录之后 120 秒内、
  //     后面 10 秒内没有跟着 [relay] prompt(跟着的话那是 relay 自己清的)
  const t0 = ms(last.talkAt)
  const nickClear = all.find((o) => {
    if (o.dir !== last.dir || o.id === last.id) return false
    const us = o.records.filter((r) => r.type === 'user').slice(0, 3)
    const f = us.find((r) => CMD_CLEAR.test(promptText(r) ?? '') && !isPlugin(r))
    if (!f) return false
    const fol = o.records.find((r) => r.type === 'user' && (promptText(r) ?? '').startsWith('[relay]'))
    if (fol && ms(fol.timestamp) - ms(f.timestamp) <= 10_000) return false
    const d = ms(f.timestamp) - t0
    return d >= 0 && d <= 120_000
  })
  if (nickClear) return true
  // (3) 属主进程还活着、只是换了会话:同一个进程 /clear 以后接着在用,那是 stall-scan 的读数
  if (aliveContinuation(last, idx, procRoot, all)) return true
  // (4) relay 自己停了:最后一条 [relay] prompt 是「上一轮没有以 RELAY 行收尾」这类提醒,之后没有 RELAY 行
  const relayPs = recs.map((r, i) => [r, i]).filter(([r]) => r.type === 'user' && (promptText(r) ?? '').startsWith('[relay]'))
  const lastP = relayPs[relayPs.length - 1]
  if (lastP && RELAY_HALTED.test(promptText(lastP[0]))) {
    const lr = lastRelayLine(recs)
    if (!lr || lr.index < lastP[1]) return true
  }
  // (5) 所有 assistant 文本里最后一个 RELAY 行是 done(不是只看最后一条 assistant 文本),并且之后没有 relay 推回
  const done = lastRelayLine(recs)
  if (done && RELAY_DONE.test(done.line) && !pushbackAfter(recs, done.index)) return true
  // (6) 本会话最后一次把 GOAL 续上之后有 /goal clear 或者 /relay stop:GOAL 是被有意停掉的(之后 assistant 回不回话都算)
  let took = -1
  for (let i = recs.length - 1; i >= 0; i--) if (recs[i].type === 'user' && lineGoals(promptText(recs[i]) ?? '').length) { took = i; break }
  if (recs.slice(took + 1).some((r) => CMD_GOAL_CLEAR.test(cmdText(r)) || CMD_RELAY_STOP.test(cmdText(r)))) return true
  // (7) 只看尾巴:owner 自己的 /clear 出现在会话尾巴上才算数
  let anchor = -1
  for (let i = recs.length - 1; i >= 0; i--) if (recs[i].type === 'assistant') { anchor = i; break }
  const after = recs.slice(anchor + 1)
  // 之后 owner 自己敲了 /clear:来源不是插件(relay 自己清的 origin 是 plugin)
  if (after.some((r) => CMD_CLEAR.test(cmdText(r)) && !isPlugin(r))) return true
  // (8) 这个会话还活着:属主进程还在,GOAL 没停
  const pf = idx.get(last.id)
  if (pf && pf.procStart !== null && pf.procStart !== undefined) {
    const start = procStart(procRoot, pf.pid)
    if (start !== null && String(start) === String(pf.procStart)) return true
  }
  return false
}

/** 这条记录是插件发的(不是 owner 敲的)。 */
const isPlugin = (r) => (r.origin ?? {}).kind === 'plugin'

/** 裁定 2:属主进程还活着、只是换了会话 —— sessions 目录里的活进程,启动时刻早于本会话最后一条说话记录,
 *  它现在挂着的会话在同一目录、开始时刻晚于本会话最后一条说话记录。 */
function aliveContinuation(last, idx, procRoot, all) {
  let btime = null
  try {
    btime = Number((readFileSync(join(procRoot, 'stat'), 'utf8').match(/^btime (\d+)/m) || [])[1]) * 1000
  } catch {
    return null
  }
  if (!btime) return null
  const t = ms(last.talkAt)
  for (const [sid, pf] of idx) {
    if (sid === last.id) continue
    const st = procStart(procRoot, pf.pid)
    if (st === null || String(st) !== String(pf.procStart)) continue
    const startMs = btime + Number(pf.procStart) * 10 // starttime 是时钟滴答(每秒 100 滴)
    if (startMs > t) continue
    const o = all.find((x) => x.id === sid)
    if (!o || o.dir !== last.dir || !(ms(o.firstAt) >= t)) continue
    return sid
  }
  return null
}

/** 这个会话所有 assistant 文本里的最后一个 RELAY 行(裁定 2:不是只看最后一条 assistant 文本)。 */
function lastRelayLine(records) {
  let last = null
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    if (r.type !== 'assistant') continue
    for (const b of blocksOf(r)) {
      if (b?.type !== 'text') continue
      for (const raw of b.text.split('\n')) {
        const line = raw.trim()
        if (RELAY_LINE.test(line)) last = { at: r.timestamp, line, index: i }
      }
    }
  }
  return last
}

/** done 之后有没有 relay 推回(「[relay] 你写了 RELAY: done,但验收没过」这类)。 */
function pushbackAfter(records, index) {
  for (let i = index + 1; i < records.length; i++) {
    const r = records[i]
    if (r.type !== 'user') continue
    const t = promptText(r) ?? ''
    if (t.startsWith('[relay]') && RELAY_DONE.test(t)) return true
  }
  return false
}

/** 会话里「在说话」的记录:assistant 或 user。queue-operation、cost-state、turn_duration 这些是记账,不算说话。 */
const talkRecords = (records) => records.filter((r) => r.type === 'assistant' || r.type === 'user')

/** 一条记录的消息内容块。 */
const blocksOf = (r) => (Array.isArray(r?.message?.content) ? r.message.content : [])

/** 记录里「用户敲的命令」的文本:slash 命令在 user 记录或 local_command 记录里。 */
const cmdText = (r) => {
  if (r.type === 'user') return promptText(r) ?? ''
  if (r.type === 'system' && r.subtype === 'local_command') return r.content ?? ''
  return ''
}

/** 每条孤儿占的证据类别:一类都占不上就是误报。 */
function evidenceOf(last, disconnectedMs, boots, idx, procRoot) {
  const out = []
  // (a) 断开时刻之后 60 秒内有一次 boot 的最后一条
  if (boots.some((b) => b[1] >= disconnectedMs && b[1] - disconnectedMs <= 60_000)) out.push('boot-end')
  // (b) 最后一条在说话的记录是 assistant 的 tool_use,后面没有对应的 tool_result
  const recs = last.records
  const conv = talkRecords(recs)
  const tail = conv[conv.length - 1]
  const blocks = blocksOf(tail)
  const use = tail && tail.type === 'assistant' ? blocks[blocks.length - 1] : null
  if (use?.type === 'tool_use') {
    const answered = recs.slice(recs.indexOf(tail) + 1).some((r) => blocksOf(r).some((c) => c?.type === 'tool_result' && c.tool_use_id === use.id))
    if (!answered) out.push('dangling-tool-use')
  }
  // (c) 这个 session 的 <pid>.json 还在、status 是 busy,而那个 pid 已经不在
  const pf = idx.get(last.id)
  if (pf && pf.status === 'busy' && !existsSync(join(procRoot, String(pf.pid)))) out.push('busy-pidfile')
  return out
}

/** ~/.claude/sessions 里的 <pid>.json:按 sessionId 索引,拿 pid、status、procStart。 */
function sessionIndex(sessionsDir) {
  const idx = new Map()
  let names = []
  try {
    names = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))
  } catch {
    return idx
  }
  for (const f of names) {
    let j
    try {
      j = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'))
    } catch {
      continue
    }
    if (!j || !j.sessionId) continue
    idx.set(j.sessionId, { pid: j.pid ?? f.replace(/\.json$/, ''), status: j.status ?? '', procStart: j.procStart ?? null })
  }
  return idx
}

/** /proc/<pid>/stat 第 22 列(starttime):进程是不是还在。 */
function procStart(procRoot, pid) {
  try {
    const line = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
    const rest = line.slice(line.lastIndexOf(')') + 1).trim().split(/\s+/)
    return rest[19] ?? null // 第 22 列:pid(1) comm(2) state(3) … starttime(22)
  } catch {
    return null
  }
}

/** boot 区间:[[第一条, 最后一条], …],按第一条排。 */
function bootIntervals(boots) {
  const out = []
  for (const b of boots ?? []) {
    const s = bootMs(Array.isArray(b) ? b[0] : b?.first)
    const e = bootMs(Array.isArray(b) ? b[1] : b?.last)
    if (s === null || e === null) continue
    out.push([s, e])
  }
  out.sort((a, b) => a[0] - b[0])
  return out
}

const bootMs = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

/** WSL 空档(裁定 6):掐断这个会话的那次关机有多久 —— 断开时刻落在某次 boot 里,取那次 boot 后面那段空档;
 *  落在空档里,取它正待的那段;和 [断开, 恢复或 --until] 重叠的秒数。之后再有的关机不算(那是没人接的时长)。
 *  后面没有空档记 0;没有 boot 数据的 null 由调用方给。 */
function wslDown(boots, at, to) {
  for (let i = 0; i < boots.length; i++) {
    const [s, e] = boots[i]
    if (at <= e) {
      if (at >= s) return boots[i + 1] ? gapSeconds(e, boots[i + 1][0], at, to) : 0
      return i ? gapSeconds(boots[i - 1][1], s, at, to) : 0
    }
  }
  return 0
}

/** 一段 boot 空档和 [from, to] 的重叠秒数。 */
function gapSeconds(g0, g1, from, to) {
  if (g1 <= g0) return 0
  const s = Math.max(g0, from)
  const e = Math.min(g1, to)
  if (e <= s) return 0
  return Math.round((e - s) / 1000)
}

/** journalctl --list-boots -o json 的输出 → boot 区间(毫秒)。现在的 journalctl 给的是一行一个数组。 */
function parseBoots(text) {
  const out = []
  const seen = new Set()
  for (const m of String(text ?? '').matchAll(/\{[^{}]*\}/g)) {
    let j
    try {
      j = JSON.parse(m[0])
    } catch {
      continue
    }
    const s = journalMs(j.first_entry ?? j.FIRST_BOOT)
    const e = journalMs(j.last_entry ?? j.LAST_BOOT)
    if (s === null || e === null) continue
    const key = `${s}:${e}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push([s, e])
  }
  return out
}

// journalctl 的 first_entry / last_entry 是微秒;老版本给的是 "2026-10-13 18:46:46 UTC" 这样的字串。
const journalMs = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v / 1000) : null
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

// ⑤ /goal:落盘时刻取 relay 记的 handoff.log `goal` 行(会话记录里没有);/goal 命令、lead 收到激活、lead 自己 Write
// 覆盖都从会话记录读。质量:goalTemplateHints 为空且没有「(待补:」。
const GOAL_LINE = /^(\S+) (\S+) goal (fork|complete) (\d+)s prompt (\d+) chars ctx (\d+)k hints (\d+) todo (\d+) (\/\S+\.md)$/
function goalsOf(all, log, since, until) {
  const out = []
  for (const line of log.split('\n')) {
    const m = line.match(GOAL_LINE)
    if (!m || m[1] < since || m[1] > until) continue
    const [, at, sid, via, secs, chars, ctx, hints, todo, path] = m
    const s = all.find((x) => x.session === sid)
    if (!s) continue
    const cmd = s.records.filter((r) => r.type === 'system' && r.subtype === 'local_command' && r.timestamp <= at && /<command-name>\/goal<\/command-name>[\s\S]*<command-args>\s*\S/.test(r.content ?? '')).pop()
    const kick = `GOAL 已写好并激活:${path}`
    const got = s.records.find((r) => r.timestamp >= at && (r.type === 'attachment' || r.type === 'user') && JSON.stringify(r.attachment ?? r.message ?? '').includes(kick))
    const overwrites = s.records.filter(
      (r) => r.type === 'assistant' && r.timestamp > at && (r.message?.content ?? []).some((c) => c?.type === 'tool_use' && c.name === 'Write' && c.input?.file_path === path),
    ).length
    out.push({
      session: sid, at, path, via, secs: Number(secs), promptChars: Number(chars), ctxK: Number(ctx),
      writeSec: cmd ? Math.round((ms(at) - ms(cmd.timestamp)) / 1000) : null,
      deliverSec: got ? Math.round((ms(got.timestamp) - ms(at)) / 1000) : null,
      overwrites,
      clean: Number(hints) === 0 && Number(todo) === 0,
    })
  }
  return out
}

// 旁车是 <交接>.last.md;新会话第一轮要 SendUserFile 发它。之后 ≥ 3 次工具调用、没被 safeguards 拦停,算接着干下去了。
function delivered(res) {
  const side = res.path.replace(/\.md$/, '.last.md')
  const recs = res.s.records.filter((r) => r.timestamp >= res.at)
  const uses = recs.flatMap((r) => (r.type === 'assistant' && Array.isArray(r.message?.content) ? r.message.content.filter((c) => c?.type === 'tool_use') : []))
  const nextPrompt = res.s.turns[res.s.turns.indexOf(res.t) + 1]?.prompt.timestamp ?? '9999'
  const first = recs.filter((r) => r.timestamp < nextPrompt)
  const sent = first.some((r) => r.type === 'assistant' && (r.message?.content ?? []).some((c) => c?.type === 'tool_use' && c.name === 'SendUserFile' && JSON.stringify(c.input ?? '').includes(side)))
  const refused = recs.some((r) => r.type === 'system' && String(r.subtype ?? '').startsWith('model_refusal'))
  return { delivered: sent, continued: uses.length >= 3 && !refused, refused }
}

// ⑥ 全部会话里的 safeguards 拦停,按类别、仓目录计。
export function flags(files, since = '', until = '9999') {
  const by = {}
  const where = {}
  for (const f of files)
    for (const r of readRecords(f)) {
      if (r.type !== 'system' || !String(r.subtype ?? '').startsWith('model_refusal')) continue
      if (r.timestamp < since || r.timestamp > until) continue
      const c = r.apiRefusalCategory ?? 'unknown'
      by[c] = (by[c] ?? 0) + 1
      const d = f.split('/').at(-2)
      where[`${c} ${d}`] = (where[`${c} ${d}`] ?? 0) + 1
    }
  return { by, where }
}

const allProjects = () => {
  const base = join(homedir(), '.claude/projects')
  return readdirSync(base).flatMap((d) => {
    try {
      return readdirSync(join(base, d)).filter((f) => f.endsWith('.jsonl')).map((f) => join(base, d, f))
    } catch {
      return []
    }
  })
}

function defaults() {
  const base = join(homedir(), '.claude/projects')
  return readdirSync(base)
    .filter((d) => d.startsWith('-home-owner-repos-') && !d.includes('--claude-worktrees'))
    .map((d) => join(base, d))
}

const k = (n) => `${Math.round(n / 1000)}k`

/** boot 区间:--boots 给的文件,或者自己跑一次 journalctl --list-boots -o json;跑不成当没有 boot 数据。 */
function readBoots(file) {
  if (file) {
    try {
      return parseBoots(readFileSync(file, 'utf8'))
    } catch (e) {
      console.error(`handoff-audit: 读不到 boot 文件 ${file}(${e.message});wslDownS 记 null`)
      return []
    }
  }
  const p = spawnSync('journalctl', ['--list-boots', '-o', 'json'], { encoding: 'utf8' })
  if (p.status !== 0 || !p.stdout) {
    console.error(`handoff-audit: journalctl --list-boots 没给出 boot 区间(退出码 ${p.status});wslDownS 记 null`)
    return []
  }
  return parseBoots(p.stdout)
}

function main(argv) {
  const opt = { since: '', until: new Date().toISOString() }
  const paths = []
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--since') opt.since = argv[++i]
    else if (a === '--until') opt.until = argv[++i]
    else if (a === '--json') json = true
    else if (a === '--sessions') opt.only = new Set(argv[++i].split(',').filter(Boolean))
    else if (a === '--boots') opt.bootsFile = argv[++i]
    else if (a === '--owner-log') opt.ownerLog = argv[++i]
    else if (a === '--no-orphans') opt.orphans = false
    else paths.push(a)
  }
  if (!opt.boots) opt.boots = readBoots(opt.bootsFile)
  if (!opt.sessionsDir) opt.sessionsDir = join(homedir(), '.claude/sessions')
  if (!opt.procRoot) opt.procRoot = '/proc'
  // owner.log 里的 `mode` 行用来把断开的线分到 orphan / false /「停了」;文件不在当空文件,不报错
  if (!opt.ownerLog) opt.ownerLog = join(homedir(), '.claude/relay/owner.log')
  // 属主判活和 busy-pidfile 这两类证据都靠这两个目录;读不到就明说,别让判官默默少一类证据
  if (!existsSync(opt.sessionsDir)) console.error(`handoff-audit: 读不到 ${opt.sessionsDir};属主判活和 busy-pidfile 这两类证据都用不上`)
  if (!existsSync(opt.procRoot)) console.error(`handoff-audit: 读不到 ${opt.procRoot};属主判活和 busy-pidfile 这两类证据都用不上`)
  const ps = paths.length ? paths : defaults()
  const live = ps.flatMap((p) =>
    statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith('.jsonl')).map((f) => join(p, f)) : [p],
  ).filter((f) => !opt.since || statSync(f).mtime.toISOString() > opt.since)
  if (opt.log === undefined) {
    try {
      opt.log = readFileSync(join(homedir(), '.claude/handoffs/handoff.log'), 'utf8')
    } catch {
      opt.log = ''
    }
  }
  const r = audit(live, opt)
  // 拦停只看最近 24 小时:每天一跑,daily.jsonl 连着 7 行为 0 才算修好
  const day = new Date(ms(opt.until) - 86_400_000).toISOString()
  const fl = flags(allProjects().filter((f) => statSync(f).mtime.toISOString() > day), day, opt.until)
  r.flags = fl
  r.verdict.reasoningExtraction = fl.by.reasoning_extraction ?? 0
  if (r.verdict.reasoningExtraction) r.verdict.pass = false
  if (json) {
    console.log(JSON.stringify(r, null, 2))
    return r.verdict.pass ? 0 : 1
  }
  const hot = r.sessions.filter((s) => s.over400 > 0).sort((a, b) => b.peak - a.peak)
  console.log(`① 超过 400k 的请求(每会话判据 ≤ ${MAX_OVER},且无一条 > 550k):${hot.length} 个会话,合计 ${hot.reduce((n, s) => n + s.over400, 0)} 条`)
  for (const s of hot) console.log(`  ${s.session} >400k ${s.over400} 条 · >550k ${s.over550} 条 · 峰值 ${k(s.peak)}${s.compacts ? ` · compact ${s.compacts} 次` : ''}`)
  console.log(`  compact_boundary:${r.compacts} 次(判据 0)`)
  const ct = r.crossTail
  console.log(`②a 越过 400k 那一轮里 >400k 的请求(轮末交接挡不住的):${ct.sessions} 个会话,中位 ${ct.median} · p90 ${ct.p90} · 最多 ${ct.max},单这一轮就 > ${MAX_OVER} 的 ${ct.over20} 个`)
  console.log(`② 轮中冲高(< 400k 开轮、轮内 > 550k):${r.surges.length} 轮`)
  for (const x of r.surges) console.log(`  ${x.session} ${x.at.slice(5, 16)}Z ${k(x.from)} → ${k(x.peak)}(${x.requests} 次请求)`)
  const by = (o) => r.handoffs.filter((h) => h.outcome === o).length
  console.log(`③ armed ${r.handoffs.length} 次:cleared ${by('cleared')} · owner 说话取消 ${by('cancelled')} · 卡着 ${by('stuck')} · 未满 35 分 ${by('pending')}`)
  console.log(`  GOAL 期间 ${r.goal.armed} 次,35 分内 cleared ${r.goal.fast}(${(r.goal.rate * 100).toFixed(0)}%,判据 ≥ 95%),卡着 ${r.goal.stuck}(判据 0)`)
  for (const h of r.handoffs.filter((x) => x.outcome === 'stuck' || (x.outcome === 'cleared' && x.minutes > CLEAR_MIN)))
    console.log(`  ${h.session} ${h.at.slice(5, 16)}Z ${h.goal ? 'GOAL' : '平时'} ${h.outcome} ${h.minutes} 分`)
  const cl = r.handoffs.filter((h) => h.outcome === 'cleared')
  console.log(`④ clear 后第一轮把旁车发给 owner:${cl.filter((h) => h.delivered).length}/${cl.length} · 接着干下去(≥ 3 次工具调用、没被拦停):${cl.filter((h) => h.continued).length}/${cl.length}(${(r.verdict.continueRate * 100).toFixed(0)}%,判据 ≥ ${CONTINUE_BASE * 100}%)`)
  for (const h of cl.filter((x) => !x.delivered || !x.continued)) console.log(`  ${h.session} ${h.at.slice(5, 16)}Z ${h.delivered ? '' : '没发旁车 '}${h.continued ? '' : h.refused ? '被拦停' : '没接着干'}`)
  const vg = r.verdict.goal
  console.log(`⑤ /goal ${r.goals.length} 次:落盘 p90 ${vg.writeP90} 秒(判据 ≤ ${GOAL_WRITE_P90_S})· 落盘后 > ${GOAL_DELIVER_S} 秒才收到激活或没收到 ${vg.slowDeliver} 次(判据 0)· lead 自己 Write 覆盖 ${vg.overwrites} 次(判据 0)· 有模板提示或「(待补:」${vg.unclean} 份(判据 0)`)
  for (const g of r.goals) console.log(`  ${g.session} ${g.at.slice(5, 16)}Z ${g.via} 写 ${g.writeSec ?? '?'} 秒(模型 ${g.secs} 秒,prompt ${g.promptChars} 字,上下文 ${g.ctxK}k)· 收到激活 ${g.deliverSec ?? '没收到'}${g.deliverSec === null ? '' : ' 秒'} · 覆盖 ${g.overwrites} · ${g.clean ? '干净' : '有待补'}`)
  console.log(`⑥ safeguards 拦停(最近 24 小时):${Object.entries(fl.by).map(([c, n]) => `${c} ${n}`).join(' · ') || '0'}(reasoning_extraction 判据 0)`)
  for (const [w, n] of Object.entries(fl.where)) console.log(`  ${w} ${n}`)
  const maxDur = r.orphans.reduce((m, o) => Math.max(m, o.durationS), 0)
  console.log(`⑦ 孤儿 GOAL:${r.verdict.orphans} 条(判据 0)· 盲区 ${r.verdict.orphanBlind} 条 · 误报 ${r.verdict.orphanFalse} 条 · 最长 ${r.verdict.orphanMaxS} 秒(扣掉 WSL 空档)· 断开到恢复最长 ${maxDur} 秒`)
  for (const o of r.orphans) console.log(`  ${o.session.slice(0, 8)} ${o.kind} ${o.disconnectedAt.slice(5, 16)}Z 断开 ${o.durationS} 秒 · WSL 空档 ${o.wslDownS === null ? '没有 boot 数据' : `${o.wslDownS} 秒`} · ${o.evidence.join('、') || '一类证据都没有'}`)
  console.log(r.verdict.pass ? '判据全过' : '有判据没到')
  return r.verdict.pass ? 0 : 1
}

// 裁定 10:退出前要等 stdout 写完 —— 设 process.exitCode,不直接 process.exit(管道会在 65536 字节处截断)。
if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2))
