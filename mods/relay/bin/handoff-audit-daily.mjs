#!/usr/bin/env node
// 交接判官的每日一跑(systemd 用户定时器 relay-handoff-audit.timer 调它,不靠任何一个会话活着):
// 跑 handoff-audit,当天读数写 <out>/<日期>.json,一行追加进 <out>/daily.jsonl;判据没到就在 claude-mods 里起一个
// headless lead(claude -p)接着改,上一个 lead 还在跑就不起第二个。
//
// 用法:node handoff-audit-daily.mjs [--out 目录](默认 ~/.local/share/owner-mods/relay/audit)

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SINCE = '2026-10-23T02:18:00Z'
const MIN_VERSION = '0.6.4' // 0.6.4 起旁车只发文件、不进 prompt;④ 的接着干下去比例只量这些会话
// ⑦ 孤儿 GOAL 的 7 天判据从 0.8.0 起算(契约 O-3):0.8.0 起 relay 才写 owner.log 的 mode 行,更早的会话只当基线
const ORPHAN_MIN_VERSION = '0.8.0'
const JUDGE = `node relay/bin/handoff-audit.mjs --since ${SINCE} --sessions <sessions.txt 里的会话>`
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..')

export function leadPrompt(reportPath) {
  return [
    `[relay 判官每日读数] \`${JUDGE}\` 没过,读数在 ${reportPath}(verdict 里列了没到的会话和数)。`,
    '终点:任何仓、任何时候、有没有 GOAL,会话都在 400k 附近被清掉,清完第一屏是 owner 没看到的原文。判官退出码 0 才算到,你说的不算。',
    '做法:先从读数定位是哪一条没到(① >400k 请求 > 20 或有 > 550k · compact_boundary · ③ GOAL 35 分内 cleared < 95% 或卡着 · ④ clear 后逐字原文缺段 · ⑤ /goal 落盘 p90 > 90 秒、落盘后 > 30 秒才收到激活、lead 自己 Write 覆盖 GOAL.md、写出的 GOAL 有模板提示或「(待补:」),到会话记录和 ~/.claude/handoffs/handoff.log 里核对前提;',
    '再改 relay/hooks/register.ts 等:先写失败测试、看它红,再写实现;跑 `claude plugin validate relay && claude plugin test relay && node --test \'relay/**/*.test.mjs\'` 全绿后 `claude plugin update relay@owner-mods`,按 /commit 提交到 master(不 push)。',
    '已知的前提要先量后定:轮末才交接时,越过阈值那一轮结束前还会跑很多次 > 400k 请求(读数 crossTail);别直接把阈值拍低,先确认它是主因,再决定前移阈值还是在工具调用之间注入交接。④ 缺段时看是不是模型抄长原文走样。⑤ 慢时先按 handoff.log `goal` 行的路径(fork / complete)、秒数、输入大小定主因,再决定改 effort、改模型还是不再 fork 整段上下文;用「干净」这一项裁质量。',
    '⑦ 孤儿 GOAL(只量 0.8.0 起的会话)orphans / orphanBlind / orphanFalse 不是 0 时,先看每条的 evidence:blind 说明那个会话没写 owner.log 的 mode 行,是 relay 漏写;false 带 owner-alive 是属主活着却 35 分钟没有 relay 轮,查 relay 是不是卡住了。修 relay,不改判官(docs/plan/2026-10-23-relay-orphan-goal.md)。',
    '改完把结论一行追加到 ~/.local/share/owner-mods/relay/audit/lead.md(日期 · 哪条没到 · 改了什么 · 提交号)。',
  ].join('\n')
}

// handoff.log 里 `start relay <版本>` 行:开窗时加载了这个版本的会话(开着的窗口不会自己换版本)
export function newSessions(log, min) {
  const v = (x) => x.split('.').map(Number)
  const ge = (a, b) => {
    const [x, y] = [v(a), v(b)]
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
    return true
  }
  const ids = []
  for (const line of log.split('\n')) {
    const m = line.match(/^\S+ (\S+) start relay (\d+\.\d+\.\d+)$/)
    if (m && ge(m[2], min) && !ids.includes(m[1])) ids.push(m[1])
  }
  return ids
}

export function daily({ out, now, sessions, audit, leadAlive, launch, orphanSessions = null, orphanAudit = null }) {
  mkdirSync(out, { recursive: true })
  const only = sessions()
  if (!only.length) {
    appendFileSync(join(out, 'daily.jsonl'), `${JSON.stringify({ at: now(), pass: null, note: 'handoff.log 里还没有新版会话' })}\n`)
    return 'no-data'
  }
  const r = audit(only)
  // ⑦ 另跑一遍,只量 0.8.0 起的会话;还没有这种会话就记 0,不跑
  const seven = orphanSessions && orphanAudit ? orphanSessions() : null
  const o = seven && seven.length ? orphanAudit(seven) : null
  const ov = seven ? (o?.verdict ?? {}) : r.verdict
  const counts = { orphans: ov.orphans ?? 0, orphanBlind: ov.orphanBlind ?? 0, orphanFalse: ov.orphanFalse ?? 0, orphanMaxS: ov.orphanMaxS ?? 0 }
  const pass = seven ? r.verdict.pass && !counts.orphans && !counts.orphanBlind && !counts.orphanFalse : r.verdict.pass
  const day = now().slice(0, 10)
  const reportPath = join(out, `${day}.json`)
  writeFileSync(reportPath, JSON.stringify(seven ? { ...r, orphanReport: o } : r, null, 2))
  appendFileSync(join(out, 'daily.jsonl'), `${JSON.stringify({ at: now(), pass, verdict: r.verdict, crossTail: r.crossTail, ...counts, ...(seven ? { orphanSessions: seven.length } : {}) })}\n`)
  if (pass) return 'pass'
  if (leadAlive()) return 'lead-busy'
  launch(leadPrompt(reportPath))
  return 'woke'
}

function alive(pidFile) {
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 0)
    return true
  } catch {
    return false
  }
}

function main(argv) {
  const i = argv.indexOf('--out')
  const out = i >= 0 ? argv[i + 1] : join(homedir(), '.local/share/owner-mods/relay/audit')
  const pidFile = join(out, 'lead.pid')
  const r = daily({
    out,
    now: () => new Date().toISOString(),
    sessions: () => {
      // handoff.log 只留 400 行:见过的会话另存一份,并集
      const known = join(out, 'sessions.txt')
      const log = (() => { try { return readFileSync(join(homedir(), '.claude/handoffs/handoff.log'), 'utf8') } catch { return '' } })()
      const old = (() => { try { return readFileSync(known, 'utf8').split('\n').filter(Boolean) } catch { return [] } })()
      const ids = [...new Set([...old, ...newSessions(log, MIN_VERSION)])]
      mkdirSync(out, { recursive: true })
      writeFileSync(known, `${ids.join('\n')}\n`)
      return ids
    },
    audit: (only) => {
      const p = spawnSync('node', ['relay/bin/handoff-audit.mjs', '--since', SINCE, '--sessions', only.join(','), '--no-orphans', '--json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 })
      return JSON.parse(p.stdout)
    },
    orphanSessions: () => {
      const known = join(out, 'sessions-orphan.txt')
      const log = (() => { try { return readFileSync(join(homedir(), '.claude/handoffs/handoff.log'), 'utf8') } catch { return '' } })()
      const old = (() => { try { return readFileSync(known, 'utf8').split('\n').filter(Boolean) } catch { return [] } })()
      const ids = [...new Set([...old, ...newSessions(log, ORPHAN_MIN_VERSION)])]
      writeFileSync(known, `${ids.join('\n')}\n`)
      return ids
    },
    orphanAudit: (only) => {
      const p = spawnSync('node', ['relay/bin/handoff-audit.mjs', '--since', SINCE, '--sessions', only.join(','), '--json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 })
      return JSON.parse(p.stdout)
    },
    leadAlive: () => alive(pidFile),
    launch: (prompt) => {
      const log = openSync(join(out, `lead-${new Date().toISOString().slice(0, 10)}.log`), 'a')
      // 无人值守不走 claude -p:piw-p(pi on MiniMax,台账 agent:relay-audit-lead,每日上限超了退 1 写 PIW_CAP)
      const c = spawn(join(homedir(), '.local/bin/piw-p'), ['-p', '--permission-mode', 'bypassPermissions', '-n', 'relay-audit-lead', prompt], { cwd: REPO, detached: true, stdio: ['ignore', log, log], env: { ...process.env, PIW_CALLER: 'relay-audit-lead' } })
      writeFileSync(pidFile, String(c.pid))
      c.unref()
    },
  })
  console.log(`relay handoff-audit daily: ${r}`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
