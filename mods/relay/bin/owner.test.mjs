import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('./owner.mjs', import.meta.url))

// 一个临时世界:属主目录、owner.log、假的 /proc、假的 sessions 和 projects。
// HOME 也指到临时目录:任何默认值都不会碰到宿主的真目录。
function world() {
  const root = mkdtempSync(join(tmpdir(), 'owner-'))
  const f = {
    root,
    goals: join(root, 'goals'),
    log: join(root, 'relay', 'owner.log'),
    proc: join(root, 'proc'),
    sessions: join(root, 'sessions'),
    projects: join(root, 'projects'),
  }
  mkdirSync(f.goals, { recursive: true })
  mkdirSync(f.proc, { recursive: true })
  mkdirSync(f.sessions, { recursive: true })
  mkdirSync(f.projects, { recursive: true })
  f.env = {
    PATH: process.env.PATH,
    HOME: root,
    RELAY_OWNER_DIR: f.goals,
    RELAY_OWNER_LOG: f.log,
    RELAY_PROC_ROOT: f.proc,
  }
  return f
}

/** 假的 /proc/<pid>/stat:第 22 列(starttime)在 comm 之后的第 20 列。 */
function fakeProc(procRoot, pid, procStart, comm = 'claude') {
  mkdirSync(join(procRoot, String(pid)), { recursive: true })
  const fields = new Array(50).fill('0')
  fields[0] = 'S'
  fields[19] = String(procStart)
  writeFileSync(join(procRoot, String(pid), 'stat'), `${pid} (${comm}) ${fields.join(' ')}\n`)
}

/** 假的 /proc/stat:btime(秒)。 */
function fakeBtime(procRoot, seconds) {
  writeFileSync(join(procRoot, 'stat'), `btime ${seconds}\n`)
}

/** 属主记录的文件名:realpath(cwd) 的 sha1 前 12 位。 */
function recordFile(goals, cwd) {
  const h = createHash('sha1').update(realpathSync(cwd)).digest('hex').slice(0, 12)
  return join(goals, `${h}.json`)
}

/** 造一条属主记录。 */
function putRecord(goals, cwd, rec) {
  const file = recordFile(goals, cwd)
  writeFileSync(
    file,
    JSON.stringify({
      cwd: realpathSync(cwd),
      path: join(cwd, 'GOAL.md'),
      mode: 'running',
      sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
      pid: 700,
      procStart: '2222',
      claimedAt: 0,
      lastTurnAt: 0,
      revives: [],
      ...rec,
    }),
  )
  return file
}

/** 假的会话记录:<projects>/<目录>/<sid>.jsonl */
function sessionFile(projects, dir, sid, records) {
  const d = join(projects, dir)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${sid}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function run(f, args) {
  return spawnSync(process.execPath, [BIN, ...args], { env: f.env, encoding: 'utf8' })
}

function logLines(f) {
  try {
    return readFileSync(f.log, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

const SID_A = 'aaaaaaaa-0000-0000-0000-000000000000'
const SID_B = 'bbbbbbbb-0000-0000-0000-000000000000'
const SID_C = 'cccccccc-0000-0000-0000-000000000000'
const SID_D = 'dddddddd-0000-0000-0000-000000000000'
const SID_E = 'eeeeeeee-0000-0000-0000-000000000000'
const SID_F = 'ffffffff-0000-0000-0000-000000000000'

test('GWT-7 并发:属主已死的记录,10 个进程同时 claim,恰好 1 个退 0,其余退 3', async () => {
  const f = world()
  const cwd = mkdtempSync(join(tmpdir(), 'ownercwd-'))
  const goal = join(cwd, 'GOAL.md')
  putRecord(f.goals, cwd, { pid: 9999, procStart: '111' }) // 属主已死:9999 不在 procRoot 里
  const pids = Array.from({ length: 10 }, (_, i) => 5000 + i)
  for (const pid of pids) fakeProc(f.proc, pid, 1000 + pid)

  const results = await Promise.all(
    pids.map(
      (pid) =>
        new Promise((resolve) => {
          const child = spawn(
            process.execPath,
            [BIN, 'claim', '--cwd', cwd, '--path', goal, '--sid', `sid${pid}-0000-0000-0000-000000000000`, '--pid', String(pid), '--mode', 'running'],
            { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] },
          )
          let stdout = ''
          child.stdout.on('data', (d) => {
            stdout += d
          })
          child.on('close', (code) => resolve({ pid, code, stdout }))
        }),
    ),
  )

  const won = results.filter((r) => r.code === 0)
  const refused = results.filter((r) => r.code === 3)
  assert.equal(won.length, 1, `退 0 的:${JSON.stringify(results.map((r) => [r.pid, r.code]))}`)
  assert.equal(refused.length, 9, `退 3 的:${JSON.stringify(results.map((r) => [r.pid, r.code]))}`)
  const rec = JSON.parse(readFileSync(recordFile(f.goals, cwd), 'utf8'))
  assert.equal(rec.pid, won[0].pid)
  assert.equal(rec.procStart, String(1000 + won[0].pid))
  const lines = logLines(f)
  assert.equal(lines.filter((l) => l.split(' ')[1] === 'claim').length, 1)
  assert.equal(lines.filter((l) => l.split(' ')[1] === 'refuse').length, 9)
  for (const r of refused) assert.match(r.stdout.trim(), /^owner-alive /)
})

test('属主活着:不带 --force 退 3 并打印 owner-alive,带 --force 退 0 并在 owner.log 记 force', () => {
  const f = world()
  const cwd = mkdtempSync(join(tmpdir(), 'ownercwd-'))
  const goal = join(cwd, 'GOAL.md')
  fakeProc(f.proc, 700, '2222')
  fakeProc(f.proc, 701, '2223')
  putRecord(f.goals, cwd, { pid: 700, procStart: '2222' })
  const args = ['claim', '--cwd', cwd, '--path', goal, '--sid', SID_B, '--pid', '701', '--mode', 'running']

  const refused = run(f, args)
  assert.equal(refused.status, 3)
  assert.equal(refused.stdout.trim(), 'owner-alive aaaaaaaa 700')

  const forced = run(f, [...args, '--force'])
  assert.equal(forced.status, 0)
  const force = logLines(f).find((l) => l.split(' ')[1] === 'force')
  assert.ok(force, 'owner.log 里没有 force 行')
  const cols = force.split(' ')
  assert.equal(cols[4], 'bbbbbbbb') // 第 5 列:新 sid8
  assert.equal(cols[5], '701')
  assert.equal(cols[6], 'aaaaaaaa') // 第 7 列:旧 sid8
  const rec = JSON.parse(readFileSync(recordFile(f.goals, cwd), 'utf8'))
  assert.equal(rec.pid, 701)
})

test('pid 重用:记录里的 pid 还在但第 22 列不同 → check 判死,claim 退 0', () => {
  const f = world()
  const cwd = mkdtempSync(join(tmpdir(), 'ownercwd-'))
  const goal = join(cwd, 'GOAL.md')
  fakeProc(f.proc, 900, '4444') // 记录里写的是 '3333' → pid 被别的进程重用了
  fakeProc(f.proc, 901, '5555')
  putRecord(f.goals, cwd, { pid: 900, procStart: '3333' })

  const c = run(f, ['check', '--cwd', cwd])
  assert.equal(c.status, 0)
  const got = JSON.parse(c.stdout)
  assert.equal(got.alive, false)
  assert.equal(got.record.pid, 900)

  const cl = run(f, ['claim', '--cwd', cwd, '--path', goal, '--sid', SID_B, '--pid', '901', '--mode', 'running'])
  assert.equal(cl.status, 0)
  assert.equal(JSON.parse(readFileSync(recordFile(f.goals, cwd), 'utf8')).pid, 901)
})

test('复活上限:一小时内第 4 次 claim --revive 退 5 打印 revive-capped,记录不变', () => {
  const f = world()
  const cwd = mkdtempSync(join(tmpdir(), 'ownercwd-'))
  const goal = join(cwd, 'GOAL.md')
  fakeProc(f.proc, 700, '2222')
  const args = ['claim', '--cwd', cwd, '--path', goal, '--sid', SID_A, '--pid', '700', '--mode', 'running', '--revive']

  for (let i = 0; i < 3; i++) assert.equal(run(f, args).status, 0)
  const file = recordFile(f.goals, cwd)
  const before = readFileSync(file, 'utf8')
  assert.equal(JSON.parse(before).revives.length, 3)

  const capped = run(f, args)
  assert.equal(capped.status, 5)
  assert.equal(capped.stdout.trim(), 'revive-capped')
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.ok(logLines(f).some((l) => l.split(' ')[1] === 'capped'))
})

test('认领时把一小时以前的复活时刻丢掉', () => {
  const f = world()
  const cwd = mkdtempSync(join(tmpdir(), 'ownercwd-'))
  const goal = join(cwd, 'GOAL.md')
  fakeProc(f.proc, 700, '2222')
  putRecord(f.goals, cwd, { revives: [Date.now() - 7200_000] })
  const r = run(f, ['claim', '--cwd', cwd, '--path', goal, '--sid', SID_A, '--pid', '700', '--mode', 'running', '--revive'])
  assert.equal(r.status, 0)
  const rec = JSON.parse(readFileSync(recordFile(f.goals, cwd), 'utf8'))
  assert.equal(rec.revives.length, 1)
  assert.ok(rec.revives[0] > Date.now() - 60_000)
})

test('check:没有记录退 4', () => {
  const f = world()
  const cwd = mkdtempSync(join(tmpdir(), 'ownercwd-'))
  const c = run(f, ['check', '--cwd', cwd])
  assert.equal(c.status, 4)
  assert.equal(c.stdout.trim(), '')
})

test('set 是 fencing:--pid 不是属主退 3、记录不变、owner.log 记 fence;是属主就写 mode/lastTurnAt/sessionId', () => {
  const f = world()
  const cwd = mkdtempSync(join(tmpdir(), 'ownercwd-'))
  fakeProc(f.proc, 700, '2222')
  const file = putRecord(f.goals, cwd, { pid: 700, procStart: '2222' })
  const before = readFileSync(file, 'utf8')

  const fenced = run(f, ['set', '--cwd', cwd, '--pid', '999', '--mode', 'idle'])
  assert.equal(fenced.status, 3)
  assert.equal(readFileSync(file, 'utf8'), before)
  const fence = logLines(f).find((l) => l.split(' ')[1] === 'fence')
  assert.ok(fence, 'owner.log 里没有 fence 行')

  const ok = run(f, ['set', '--cwd', cwd, '--pid', '700', '--mode', 'idle', '--last-turn-at', '1792738450766', '--sid', SID_B])
  assert.equal(ok.status, 0)
  const rec = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(rec.mode, 'idle')
  assert.equal(rec.lastTurnAt, 1792738450766)
  assert.equal(rec.sessionId, SID_B)
})

test('mode 行:9 列(带 --old-sid 10 列),第 7 列是 procStart,路径里的空格写成 %20', () => {
  const f = world()
  fakeProc(f.proc, 700, '8918298')
  const args = [
    'mode',
    '--cwd', '/r/my repo',
    '--path', '/r/my repo/docs/GOAL.md',
    '--sid', 'aaaaaaaa-1111-2222-3333-444444444444',
    '--pid', '700',
    '--from', 'running',
    '--to', 'waiting-owner',
  ]

  const r = run(f, [...args, '--why', 'continue'])
  assert.equal(r.status, 0)
  const cols = logLines(f)[0].split(' ')
  assert.equal(cols.length, 9)
  assert.equal(cols[1], 'mode')
  assert.equal(cols[2], '/r/my%20repo')
  assert.equal(cols[3], '/r/my%20repo/docs/GOAL.md')
  assert.equal(cols[4], 'aaaaaaaa')
  assert.equal(cols[5], '700')
  assert.equal(cols[6], '8918298')
  assert.equal(cols[7], 'running->waiting-owner')
  assert.equal(cols[8], 'continue')

  const r2 = run(f, [...args, '--why', 'continue', '--old-sid', 'bbbbbbbb-1111-2222-3333-444444444444'])
  assert.equal(r2.status, 0)
  const cols2 = logLines(f)[1].split(' ')
  assert.equal(cols2.length, 10)
  assert.equal(cols2[9], 'bbbbbbbb')

  const n = logLines(f).length
  const bogus = run(f, [...args, '--why', 'bogus'])
  assert.equal(bogus.status, 1)
  const noproc = run(f, [...args, '--why', 'continue', '--pid', '999999'])
  assert.equal(noproc.status, 1)
  assert.equal(logLines(f).length, n)
})

test('scan:活的判活,pid 不在的、pid 被重用的、JSON 读不出的都判死', () => {
  const f = world()
  fakeProc(f.proc, 4242, '5555')
  fakeProc(f.proc, 4244, '7777') // 记录里写的是 '6666' → pid 被重用
  writeFileSync(join(f.sessions, '4242.json'), JSON.stringify({ pid: 4242, sessionId: SID_A, cwd: '/r', procStart: '5555' }))
  writeFileSync(join(f.sessions, '4243.json'), JSON.stringify({ pid: 4243, sessionId: SID_B, cwd: '/r', procStart: '8888' }))
  writeFileSync(join(f.sessions, '4244.json'), JSON.stringify({ pid: 4244, sessionId: SID_C, cwd: '/r', procStart: '6666' }))
  writeFileSync(join(f.sessions, '4245.json'), '{ 这不是 JSON')

  const r = run(f, ['scan', '--sessions-dir', f.sessions, '--proc-root', f.proc])
  assert.equal(r.status, 0)
  const rows = JSON.parse(r.stdout)
  assert.equal(rows.length, 4)
  const live = rows.filter((x) => x.alive === true)
  assert.equal(live.length, 1)
  assert.equal(live[0].pid, 4242)
  assert.equal(rows.find((x) => x.pid === 4243).alive, false)
  assert.equal(rows.find((x) => x.pid === 4244).alive, false)
  assert.equal(rows.find((x) => x.pid === 4245).alive, false)
})

test('whois:alive / dead / unknown', () => {
  const f = world()
  fakeProc(f.proc, 4244, '900')
  writeFileSync(join(f.sessions, '4244.json'), JSON.stringify({ pid: 4244, sessionId: SID_D, cwd: '/other', procStart: '900' }))
  writeFileSync(join(f.sessions, '4245.json'), JSON.stringify({ pid: 4245, sessionId: SID_E, cwd: '/other', procStart: '901' }))

  const alive = run(f, ['whois', '--sid', SID_D, '--sessions-dir', f.sessions, '--proc-root', f.proc])
  assert.equal(alive.status, 0)
  assert.equal(alive.stdout.trim(), 'alive 4244')

  const dead = run(f, ['whois', '--sid', SID_E, '--sessions-dir', f.sessions, '--proc-root', f.proc])
  assert.equal(dead.status, 0)
  assert.equal(dead.stdout.trim(), 'dead 4245')

  const unknown = run(f, ['whois', '--sid', SID_F, '--sessions-dir', f.sessions, '--proc-root', f.proc])
  assert.equal(unknown.status, 0)
  assert.equal(unknown.stdout.trim(), 'unknown')
})

test('whois switched:同一个进程 /clear 以后接着在用 —— 照 a408cb6a 的形状', () => {
  const f = world()
  // 目标会话 A:最后一句 06:54;现在挂着的会话 B 第一条 07:13;另一个同 cwd 的活进程 C 第一条 06:00。
  sessionFile(f.projects, '-r', SID_A, [{ type: 'user', timestamp: '2026-10-23T06:54:00.000Z', cwd: '/r' }])
  sessionFile(f.projects, '-r', SID_B, [{ type: 'attachment', timestamp: '2026-10-23T07:13:00.000Z' }])
  sessionFile(f.projects, '-r', SID_C, [{ type: 'attachment', timestamp: '2026-10-23T06:00:00.000Z' }])
  // 4242 现在挂着 B,06:00 起;4243 挂着 C,05:00 起(更早,但它的会话第一条早于 A 的最后一句 → 不算)。
  writeFileSync(join(f.sessions, '4242.json'), JSON.stringify({ pid: 4242, sessionId: SID_B, cwd: '/r', procStart: '2160000' }))
  writeFileSync(join(f.sessions, '4243.json'), JSON.stringify({ pid: 4243, sessionId: SID_C, cwd: '/r', procStart: '1800000' }))
  fakeProc(f.proc, 4242, '2160000')
  fakeProc(f.proc, 4243, '1800000')
  fakeBtime(f.proc, Math.floor(Date.parse('2026-10-23T00:00:00Z') / 1000))

  const r = run(f, ['whois', '--sid', SID_A, '--sessions-dir', f.sessions, '--proc-root', f.proc, '--projects-dir', f.projects])
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim(), 'switched 4242 bbbbbbbb')
})
