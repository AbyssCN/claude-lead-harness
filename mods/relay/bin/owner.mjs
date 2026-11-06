#!/usr/bin/env node
// relay/bin/owner.mjs:GOAL 属主的认领、判活、fencing 和 owner.log。零模型。
//
// 属主 = 一份 GOAL 当前在推的那个进程,用 pid 加 /proc/<pid>/stat 第 22 列(starttime)认。
// sessionId 不算:relay 自己 /clear 以后进程不变、sessionId 会变(D-1)。
// 认领在一个按 cwd 分开的内核锁(flock)里做「读记录 → 判活 → 写记录」,并发认领只有一个能成(D-2)。
// 每次认领、拒绝、复活到顶、fencing、mode 变化都往 owner.log 追加一行,只追加、不读改写(D-12)。
//
// 用法:node relay/bin/owner.mjs <子命令> …
//   claim --cwd <cwd> --path <goal> --sid <sessionId> --pid <pid> --mode <mode> [--force] [--revive]
//   check --cwd <cwd>
//   set --cwd <cwd> --pid <pid> [--mode <m>] [--last-turn-at <ms>] [--sid <sessionId>]
//   mode --cwd <cwd> --path <goal> --sid <sessionId> --pid <pid> --from <旧 mode> --to <新 mode> --why <原因> [--old-sid <sessionId>]
//   scan [--sessions-dir <dir>] [--proc-root <dir>]
//   whois --sid <sessionId> [--sessions-dir <dir>] [--proc-root <dir>] [--projects-dir <dir>]
// 退出码:claim 退 0 成 / 3 属主活着 / 5 复活到顶;check 退 0 有记录 / 4 没记录;
// set 退 0 写成功 / 3 不是属主(fencing);其余错误退 1。
// 环境:RELAY_OWNER_DIR(属主记录目录,默认 ~/.claude/relay/goals)· RELAY_OWNER_LOG(默认 ~/.claude/relay/owner.log)
// · RELAY_PROC_ROOT(默认 /proc);scan/whois 的 --sessions-dir、--proc-root、--projects-dir 命令行优先于环境变量。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOUR = 3_600_000
const REVIVE_CAP = 3
const MODES = ['running', 'waiting-owner', 'idle', 'done']
const WHYS = [
  'goal',
  'continue',
  'owner-parked',
  'done-accepted',
  'done-failed',
  'no-relay-line-twice',
  'stuck',
  'max-turns',
  'goal-clear',
  'relay-stop',
  'owner-clear',
  'resume',
  'revive',
  'fence',
  'relay-clear',
]
const BOOLS = new Set(['force', 'revive'])
const SELF = fileURLToPath(import.meta.url)
const FLOCK = existsSync('/usr/bin/flock') ? '/usr/bin/flock' : 'flock'

const out = (s) => process.stdout.write(`${s}\n`)
const err = (s) => process.stderr.write(`${s}\n`)
const fail = (code, msg) => {
  err(msg)
  return code
}

/** sid8:会话 id 的前 8 位;没有就是 '-'。 */
const sid8 = (sid) => (sid === undefined || sid === null || sid === '' ? '-' : String(sid).slice(0, 8))

/** owner.log 是空格分隔的:路径里的空格写成 %20。 */
const enc = (s) => (s === undefined || s === null || s === '' ? '-' : String(s).replace(/ /g, '%20'))

const goalsDir = () => process.env.RELAY_OWNER_DIR || join(homedir(), '.claude', 'relay', 'goals')
const ownerLog = () => process.env.RELAY_OWNER_LOG || join(homedir(), '.claude', 'relay', 'owner.log')
const procRootOf = (o) => o['proc-root'] || process.env.RELAY_PROC_ROOT || '/proc'
const sessionsDirOf = (o) => o['sessions-dir'] || process.env.RELAY_SESSIONS_DIR || join(homedir(), '.claude', 'sessions')
const projectsDirOf = (o) => o['projects-dir'] || process.env.RELAY_PROJECTS_DIR || join(homedir(), '.claude', 'projects')

/** 属主记录的键:realpath(cwd) 的 sha1 前 12 位。 */
function hashOf(cwd) {
  try {
    const abs = realpathSync(cwd)
    return { abs, hash: createHash('sha1').update(abs).digest('hex').slice(0, 12) }
  } catch {
    return null
  }
}

/** /proc/<pid>/stat 第 22 列(starttime):进程启动时刻;读不到就是 null。 */
function procStart(procRoot, pid) {
  try {
    const line = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
    const rest = line.slice(line.lastIndexOf(')') + 1).trim().split(/\s+/)
    return rest[19] ?? null
  } catch {
    return null
  }
}

/** D-1:属主活着 = /proc/<pid>/stat 读得到,而且第 22 列等于记下的那个。 */
function alive(procRoot, pid, start) {
  if (pid === undefined || pid === null || start === undefined || start === null) return false
  const s = procStart(procRoot, pid)
  return s !== null && String(s) === String(start)
}

/** 读属主记录;读不出来当成没有记录,但留一句证据在 stderr(不猜内容)。 */
function readRecord(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const j = JSON.parse(text)
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null
  } catch (e) {
    err(`属主记录读不出来:${file}(${e.message})`)
    return null
  }
}

/** 写属主记录:同目录临时文件再 rename,读的人永远看到完整的一份。 */
function writeRecord(file, rec) {
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}`)
  try {
    writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`)
    renameSync(tmp, file)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件删不掉就留着:它不是记录,rename 没发生就不算数。
    }
    throw e
  }
}

/** owner.log 只追加:一次 write 写完一整行(O_APPEND),不读改写、不截断。 */
function appendLog(cols) {
  const file = ownerLog()
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${cols.join(' ')}\n`)
}

/** owner.log 的一行:<ISO> <event> <cwd> <goalPath> <sid8> <pid> <from-sid8|-> */
function logLine(event, cwd, goal, sid, pid, fromSid) {
  appendLog([
    new Date().toISOString(),
    event,
    enc(cwd),
    enc(goal),
    sid8(sid),
    pid === undefined || pid === null ? '-' : String(pid),
    sid8(fromSid),
  ])
}

/** 认领这一段在 <h>.lock 的内核排他锁里做:flock(1) 拉着本进程重跑一遍,锁挂在那个进程的 fd 上。
 * 已经在锁里(RELAY_OWNER_FLOCKED)就直接做,不重跑。 */
function withLock(lockFile, fn) {
  if (process.env.RELAY_OWNER_FLOCKED === '1') return fn()
  mkdirSync(dirname(lockFile), { recursive: true })
  const r = spawnSync(FLOCK, ['-x', lockFile, process.execPath, SELF, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, RELAY_OWNER_FLOCKED: '1' },
  })
  if (r.error) return fail(1, `flock 起不来:${r.error.message}`)
  if (r.status === null) return fail(1, `锁里那一段被信号打断:${r.signal}`)
  return r.status
}

function cmdClaim(o) {
  const cwd = o.cwd
  const goal = o.path
  const sid = o.sid
  const pid = Number(o.pid)
  const mode = o.mode
  if (!cwd) return fail(1, 'claim 缺 --cwd')
  if (!goal) return fail(1, 'claim 缺 --path')
  if (!sid) return fail(1, 'claim 缺 --sid')
  if (!Number.isInteger(pid) || pid <= 0) return fail(1, 'claim 缺 --pid')
  if (!MODES.includes(mode)) return fail(1, `claim 的 --mode 不认:${mode}`)
  const key = hashOf(cwd)
  if (!key) return fail(1, `cwd 读不出来:${cwd}`)
  const dir = goalsDir()
  mkdirSync(dir, { recursive: true })
  const recFile = join(dir, `${key.hash}.json`)
  const lockFile = join(dir, `${key.hash}.lock`)

  return withLock(lockFile, () => {
    const procRoot = procRootOf(o)
    const prev = readRecord(recFile)
    const prevAlive = prev ? alive(procRoot, prev.pid, prev.procStart) : false
    // 属主活着、又不是本进程、又没有 --force:拒绝,记录不动。
    if (prevAlive && prev.pid !== pid && !o.force) {
      out(`owner-alive ${sid8(prev.sessionId)} ${prev.pid}`)
      logLine('refuse', cwd, goal, sid, pid, prev.sessionId)
      return 3
    }
    const now = Date.now()
    // revives 只留最近一小时的时刻(D-7)。
    const revives = (Array.isArray(prev?.revives) ? prev.revives : []).filter((t) => typeof t === 'number' && now - t < HOUR)
    if (o.revive && revives.length >= REVIVE_CAP) {
      out('revive-capped')
      logLine('capped', cwd, goal, sid, pid, prev?.sessionId)
      return 5
    }
    const start = procStart(procRoot, pid)
    if (start === null) return fail(1, `读不到 ${procRoot}/${pid}/stat`)
    const same = prev && prev.pid === pid && prev.sessionId === sid
    writeRecord(recFile, {
      cwd: key.abs,
      path: goal,
      mode,
      sessionId: sid,
      pid,
      procStart: start,
      claimedAt: now,
      // 还是同一个属主重新认领:上一轮的时刻留着;换了属主就归零。
      lastTurnAt: same && typeof prev.lastTurnAt === 'number' ? prev.lastTurnAt : 0,
      revives: o.revive ? [...revives, now] : revives,
    })
    const event = prevAlive && prev.pid !== pid ? 'force' : o.revive ? 'revive' : 'claim'
    logLine(event, cwd, goal, sid, pid, prev?.sessionId)
    return 0
  })
}

function cmdCheck(o) {
  if (!o.cwd) return fail(1, 'check 缺 --cwd')
  const key = hashOf(o.cwd)
  if (!key) return fail(1, `cwd 读不出来:${o.cwd}`)
  // 记录是 rename 换上去的,读它不用加锁。
  const rec = readRecord(join(goalsDir(), `${key.hash}.json`))
  if (!rec) return 4
  out(JSON.stringify({ record: rec, alive: alive(procRootOf(o), rec.pid, rec.procStart) }, null, 2))
  return 0
}

function cmdSet(o) {
  const cwd = o.cwd
  const pid = Number(o.pid)
  if (!cwd) return fail(1, 'set 缺 --cwd')
  if (!Number.isInteger(pid) || pid <= 0) return fail(1, 'set 缺 --pid')
  if (o.mode !== undefined && !MODES.includes(o.mode)) return fail(1, `set 的 --mode 不认:${o.mode}`)
  const turnAt = o['last-turn-at'] === undefined ? undefined : Number(o['last-turn-at'])
  if (turnAt !== undefined && !Number.isFinite(turnAt)) return fail(1, `set 的 --last-turn-at 不是数:${o['last-turn-at']}`)
  const key = hashOf(cwd)
  if (!key) return fail(1, `cwd 读不出来:${cwd}`)
  const dir = goalsDir()
  mkdirSync(dir, { recursive: true })
  const recFile = join(dir, `${key.hash}.json`)
  const lockFile = join(dir, `${key.hash}.lock`)

  return withLock(lockFile, () => {
    const rec = readRecord(recFile)
    // 不是属主:记录不动,owner.log 记一行 fence(D-4)。
    if (!rec || rec.pid !== pid) {
      logLine('fence', cwd, rec?.path ?? o.path, o.sid, pid, rec?.sessionId)
      return 3
    }
    const next = { ...rec }
    if (o.mode !== undefined) next.mode = o.mode
    if (turnAt !== undefined) next.lastTurnAt = turnAt
    if (o.sid !== undefined) next.sessionId = o.sid
    writeRecord(recFile, next)
    return 0
  })
}

function cmdMode(o) {
  const pid = Number(o.pid)
  if (!o.cwd) return fail(1, 'mode 缺 --cwd')
  if (!o.path) return fail(1, 'mode 缺 --path')
  if (!o.sid) return fail(1, 'mode 缺 --sid')
  if (!Number.isInteger(pid) || pid <= 0) return fail(1, 'mode 缺 --pid')
  if (!MODES.includes(o.from) || !MODES.includes(o.to)) return fail(1, `mode 的 --from/--to 不认:${o.from}->${o.to}`)
  if (!WHYS.includes(o.why)) return fail(1, `mode 的 --why 不认:${o.why}`)
  const procRoot = procRootOf(o)
  const start = procStart(procRoot, pid)
  if (start === null) return fail(1, `读不到 ${procRoot}/${pid}/stat`)
  // mode 行:<ISO> mode <cwd> <goalPath> <sid8> <pid> <procStart> <from>-><to> <why>[ <旧 sid8>]
  const cols = [new Date().toISOString(), 'mode', enc(o.cwd), enc(o.path), sid8(o.sid), String(pid), start, `${o.from}->${o.to}`, o.why]
  if (o['old-sid']) cols.push(sid8(o['old-sid']))
  appendLog(cols)
  return 0
}

/** sessions 目录里的 <pid>.json:JSON 读不出的也留着(判死)。 */
function pidFiles(dir) {
  let names = []
  try {
    names = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
  } catch {
    return []
  }
  const rows = []
  for (const f of names) {
    const pid = Number(f.replace(/\.json$/, ''))
    let j = null
    try {
      j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      j = null
    }
    rows.push({ pid: j && Number.isFinite(Number(j.pid)) ? Number(j.pid) : pid, json: j && typeof j === 'object' ? j : null })
  }
  rows.sort((a, b) => a.pid - b.pid)
  return rows
}

function cmdScan(o) {
  const dir = sessionsDirOf(o)
  const procRoot = procRootOf(o)
  const rows = pidFiles(dir).map((f) => {
    const j = f.json
    const start = j?.procStart ?? null
    return {
      pid: f.pid,
      sessionId: j?.sessionId ?? null,
      cwd: j?.cwd ?? null,
      procStart: start,
      alive: alive(procRoot, f.pid, start),
    }
  })
  rows.sort((a, b) => a.pid - b.pid)
  out(JSON.stringify(rows, null, 2))
  return 0
}

/** 会话记录:<projects-dir> 下一层目录里的 <sid>.jsonl */
function sessionRecord(projectsDir, sid) {
  let dirs = []
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(projectsDir, d.name))
  } catch {
    return null
  }
  for (const d of dirs) {
    let text
    try {
      text = readFileSync(join(d, `${sid}.jsonl`), 'utf8')
    } catch {
      continue
    }
    const records = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        // 坏行跳过,不猜。
      }
    }
    return { file: join(d, `${sid}.jsonl`), records }
  }
  return null
}

/** 这个会话最后一条 user/assistant 记录的时刻(ms)。 */
function lastTalk(records) {
  let t = null
  for (const r of records) {
    if (!r || (r.type !== 'user' && r.type !== 'assistant') || !r.timestamp) continue
    const ms = Date.parse(r.timestamp)
    if (Number.isNaN(ms)) continue
    if (t === null || ms > t) t = ms
  }
  return t
}

/** 这个会话第一条带 timestamp 的记录的时刻(ms)。 */
function firstStamp(records) {
  let t = null
  for (const r of records) {
    if (!r || !r.timestamp) continue
    const ms = Date.parse(r.timestamp)
    if (Number.isNaN(ms)) continue
    if (t === null || ms < t) t = ms
  }
  return t
}

/** 会话记录里的 cwd。 */
const cwdOf = (records) => {
  for (const r of records) if (r && r.cwd) return r.cwd
  return null
}

/** /proc/stat 的 btime(毫秒)。 */
function btimeOf(procRoot) {
  try {
    const m = readFileSync(join(procRoot, 'stat'), 'utf8').match(/^btime (\d+)/m)
    return m ? Number(m[1]) * 1000 : null
  } catch {
    return null
  }
}

function cmdWhois(o) {
  const sid = o.sid
  if (!sid) return fail(1, 'whois 缺 --sid')
  const sdir = sessionsDirOf(o)
  const procRoot = procRootOf(o)
  const pdir = projectsDirOf(o)
  const files = pidFiles(sdir)

  // 有它的 pid 文件:进程活着就是 alive,进程不在或者 pid 被重用就是 dead。
  const mine = files.filter((f) => f.json?.sessionId === sid)
  if (mine.length) {
    const live = mine.find((f) => alive(procRoot, f.pid, f.json.procStart))
    if (live) {
      out(`alive ${live.pid}`)
      return 0
    }
    out(`dead ${mine[0].pid}`)
    return 0
  }

  // 没有它的 pid 文件:同一个进程 /clear 以后接着在用 —— cwd 相同、起得比它最后一句早、
  // 现在挂着的会话第一条比它最后一句晚。几个候选取起得最早的那个。
  const target = sessionRecord(pdir, sid)
  const last = target ? lastTalk(target.records) : null
  const btime = btimeOf(procRoot)
  if (target && last !== null && btime !== null) {
    const cwd = cwdOf(target.records)
    const cands = []
    for (const f of files) {
      const j = f.json
      if (!j || !j.sessionId || !j.cwd) continue
      if (!alive(procRoot, f.pid, j.procStart)) continue
      if (cwd === null || j.cwd !== cwd) continue
      const start = btime + Number(j.procStart) * 10 // starttime 是时钟滴答(每秒 100 滴)
      if (!(start < last)) continue
      const cur = sessionRecord(pdir, j.sessionId)
      if (!cur) continue
      const first = firstStamp(cur.records)
      if (first === null || !(first > last)) continue
      cands.push({ pid: f.pid, sid: j.sessionId, start })
    }
    cands.sort((a, b) => a.start - b.start)
    if (cands.length) {
      out(`switched ${cands[0].pid} ${sid8(cands[0].sid)}`)
      return 0
    }
  }
  out('unknown')
  return 0
}

/** 命令行:<子命令> [--键 值 | --开关] … */
function parseArgs(argv) {
  const cmd = argv[0]
  const o = {}
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) return { cmd, o, bad: `多出来的参数:${a}` }
    const key = a.slice(2)
    if (BOOLS.has(key)) {
      o[key] = true
      continue
    }
    const v = argv[i + 1]
    if (v === undefined) return { cmd, o, bad: `--${key} 缺值` }
    o[key] = v
    i++
  }
  return { cmd, o, bad: null }
}

const { cmd, o, bad } = parseArgs(process.argv.slice(2))
let code = 1
if (bad) {
  code = fail(1, bad)
} else if (cmd === 'claim') {
  code = cmdClaim(o)
} else if (cmd === 'check') {
  code = cmdCheck(o)
} else if (cmd === 'set') {
  code = cmdSet(o)
} else if (cmd === 'mode') {
  code = cmdMode(o)
} else if (cmd === 'scan') {
  code = cmdScan(o)
} else if (cmd === 'whois') {
  code = cmdWhois(o)
} else {
  code = fail(1, `不认这个子命令:${cmd}`)
}
process.exitCode = code
