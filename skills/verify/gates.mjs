#!/usr/bin/env node
// /verify 与 /commit 共用的闸判定(读 <仓根>/.claude/delegate.json,不猜命令)。豁免只有一个出处:delegate.json 的 layerExempt。
//   plan [基线]           改动集合 → 命中的层闸 · 豁免 · 未覆盖(JSON)。基线:给了用给的,否则 main,没有 main 用 master
//   run [基线]            /verify 用:跑 plan 命中的层闸,首行结论 PASS / FAIL / ENV-ERROR / NO-GATE / EXEMPT / NO-CHANGE
//                         退出码 0 = PASS·EXEMPT·NO-CHANGE · 1 = FAIL · 3 = NO-GATE · 4 = ENV-ERROR(命令找不到,等就位重跑一次后仍找不到)
//   check <路径…>         /commit 用:要 stage 的路径里既没被任何 layerGate 命中、也不在 layerExempt 的 → 列出并退 1
//   coverage [--check] [--list] [--json]   全仓被跟踪文件:没被任何层闸覆盖的个数(读数 ①)
//   tests [--check] [--list] [--json]      每个被跟踪的测试文件首行插探针,跑全部层闸,数探针没出现的文件(读数 ②);跑完 git checkout 还原
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const TEST_RE = /(^|\/)[^/]+[._](test|spec)\.[cm]?[jt]sx?$|\.test\.sh$|(^|\/)test_[^/]+\.py$/
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 })
const lines = (s) => s.split('\n').filter(Boolean)
// 路径清单一律 -z:默认输出会给非 ASCII 路径加引号转义(otherapp 的 Tilinpäätös 目录)
const paths = (args) => git([...args, '-z'], root).split('\0').filter(Boolean)

const root = git(['rev-parse', '--show-toplevel']).trim()
const cfgPath = join(root, '.claude/delegate.json')
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}
const gates = (cfg.layerGates ?? []).map((g) => ({ ...g, re: new RegExp(g.pattern) }))
// 规则项二选一:{pattern, why}(JS 正则),或 {lock: "<目录>/*.json", prefix, why} —— 读这些锁文件 .files 的键,前缀拼成仓根相对路径逐个列入
// (factory 装件的清单只认锁,不另写正则:装多少件就是多少件,不会多罩)。
function lockPaths(e) {
  const dir = join(root, dirname(e.lock))
  if (!existsSync(dir)) return []
  const tail = e.lock.split('/').pop().replace('*', '')
  return readdirSync(dir).filter((f) => f.endsWith(tail)).flatMap((f) => Object.keys(JSON.parse(readFileSync(join(dir, f), 'utf8')).files ?? {}).map((k) => `${e.prefix ?? ''}${k}`))
}
const rules = (key) => (cfg[key] ?? []).map((e) => {
  if (e.lock) { const set = new Set(lockPaths(e)); return { ...e, re: { test: (p) => set.has(p) } } }
  return { ...e, re: new RegExp(e.pattern) }
})
const exempt = rules('layerExempt')
const notTests = rules('notTests')
const kind = cfg.sliceGate || cfg.gate ? 'slice' : gates.length ? 'layer-only' : 'none'
// 片闸仓:片闸每次改动都跑,它自己验得到的路径在 sliceGateCovers 里声明(带 why);读数 ② 会按组实跑片闸核对其中的测试文件
const sliceCovers = kind === 'slice' ? rules('sliceGateCovers') : []
const sliceCmd = cfg.sliceGate ?? cfg.gate

const isExempt = (p) => exempt.some((e) => e.re.test(p))
const gatesFor = (p) => gates.filter((g) => g.re.test(p))
const uncoveredOf = (paths) => paths.filter((p) => !isExempt(p) && gatesFor(p).length === 0 && !sliceCovers.some((c) => c.re.test(p)))
const tracked = () => paths(['ls-files'])
const topDir = (p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '(仓根)')

function byDir(paths) {
  const m = new Map()
  for (const p of paths) m.set(topDir(p), (m.get(topDir(p)) ?? 0) + 1)
  return [...m].sort(([a], [b]) => a.localeCompare(b))
}

function resolveBase(given) {
  if (given) return given
  for (const b of ['main', 'master']) if (spawnSync('git', ['rev-parse', '--verify', '-q', b], { cwd: root }).status === 0) return b
  throw new Error('gates: 本地没有 main 也没有 master,给个基线 ref')
}

function plan(base) {
  const changed = [...new Set([
    ...paths(['diff', '--name-only', `${base}...HEAD`]),
    ...paths(['diff', '--name-only']),
    ...paths(['diff', '--name-only', '--cached']),
    ...paths(['ls-files', '--others', '--exclude-standard']),
  ])].sort()
  const hits = gates.map((g) => ({ pattern: g.pattern, cmd: g.cmd, paths: changed.filter((p) => g.re.test(p)) })).filter((h) => h.paths.length)
  const cmds = [...new Set(hits.map((h) => h.cmd))]
  const ex = changed.filter(isExempt)
  const uncovered = uncoveredOf(changed)
  let verdict = 'RUN'
  if (kind === 'layer-only') {
    if (!changed.length) verdict = 'NO-CHANGE'
    else if (!hits.length) verdict = uncovered.length ? 'NO-GATE' : 'EXEMPT'
  }
  return { root, kind, base, verdict, changed, exempt: ex, hits, cmds, uncovered }
}

// 环境错:闸命令里有命令找不到(bash 退 127 并报 command not found / No such file or directory,如 claude CLI 自动更新中途)。
// 这时闸根本没跑,既不是 PASS 也不是 FAIL:等那条命令重新就位(最多 GATES_ENV_WAIT 秒),再重跑一次。
const ENV_RE = /^(?:bash: )?(?:line \d+: )?(\S+?): (?:command not found|No such file or directory)\s*$/m
const envMissing = (r) => (r.status === 127 ? `${r.stdout}\n${r.stderr}`.match(ENV_RE)?.[1] ?? null : null)

function found(name) {
  if (name.includes('/')) return existsSync(name)
  return spawnSync('bash', ['-c', `command -v -- "${name}"`], { encoding: 'utf8' }).status === 0
}

function waitFor(name) {
  const deadline = Date.now() + Number(process.env.GATES_ENV_WAIT ?? 180) * 1000
  while (!found(name) && Date.now() < deadline) spawnSync('sleep', ['5'])
  return found(name)
}

function runGate(cmd, log) {
  const once = () => spawnSync('bash', ['-c', cmd], { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 })
  let r = once()
  let missing = envMissing(r)
  let note = ''
  if (missing) {
    const back = waitFor(missing)
    note = back ? `${missing} 找不到 → 等到它就位后重跑一次` : `${missing} 找不到,等了 ${process.env.GATES_ENV_WAIT ?? 180}s 仍不在,照样重跑一次`
    r = once()
    missing = envMissing(r)
  }
  writeFileSync(log, `${r.stdout}${r.stderr}`)
  const status = missing ? 'ENV' : r.status === 0 ? 'PASS' : 'FAIL'
  return { cmd, rc: r.status, status, missing, note, log, out: `${r.stdout}\n${r.stderr}` }
}

function run(base) {
  const p = plan(base)
  if (p.verdict !== 'RUN') {
    console.log(p.verdict === 'NO-GATE' ? 'NO-GATE 没有命中的闸' : p.verdict)
    for (const [dir, n] of byDir(p.uncovered)) console.log(`未覆盖:${dir}/ ${n} 个文件`)
    return p.verdict === 'NO-GATE' ? 3 : 0
  }
  const sha = git(['rev-parse', '--short', 'HEAD'], root).trim()
  const dir = `/tmp/verify-${root.split('/').pop()}-${sha}`
  execFileSync('mkdir', ['-p', dir])
  const results = p.cmds.map((cmd, i) => runGate(cmd, join(dir, `${i + 1}.log`)))
  const fail = results.some((r) => r.status === 'FAIL')
  const env = results.filter((r) => r.status === 'ENV')
  // 真红优先:同一次里既有环境错又有闸红,结论是 FAIL;只有环境错没有红,结论是 ENV-ERROR(不当 PASS、不当 FAIL)。
  if (fail) console.log('FAIL')
  else if (env.length) console.log(`ENV-ERROR 环境错(不是代码红):${[...new Set(env.map((r) => r.missing))].join('、')} 找不到,闸没跑成;CLI 就位后重跑 /verify`)
  else console.log('PASS')
  for (const r of results) {
    const tail = r.status === 'FAIL' ? r.out.split('\n').filter((l) => /^\s*(?:\(fail\)|✖|×|not ok\b|FAIL\b)|AssertionError|^error:/.test(l)).slice(0, 20) : []
    console.log(`${r.status} rc=${r.rc} ${r.cmd}  日志 ${r.log}${r.note ? `  (${r.note})` : ''}`)
    for (const l of tail) console.log(`    ${l}`)
  }
  for (const [d, n] of byDir(p.uncovered)) console.log(`未覆盖:${d}/ ${n} 个文件`)
  console.log(`豁免:${p.exempt.length} 个文件`)
  return fail ? 1 : env.length ? 4 : 0
}

function coverage(args) {
  const files = tracked().filter((p) => !isExempt(p))
  const unc = uncoveredOf(files)
  if (args.includes('--json')) {
    console.log(JSON.stringify({ uncovered: unc.length, total: files.length, paths: unc }))
    return unc.length
  }
  const totals = new Map(byDir(files))
  const missing = new Map(byDir(unc))
  for (const [dir, n] of totals) {
    console.log(`${dir.padEnd(16)} 需覆盖 ${String(n).padStart(4)}  未覆盖 ${String(missing.get(dir) ?? 0).padStart(4)}`)
    if (args.includes('--list')) for (const p of unc.filter((f) => topDir(f) === dir)) console.log(`  ${p}`)
  }
  console.log(`未覆盖 ${unc.length} / 需覆盖 ${files.length}(layerGates ${gates.length} 条 · layerExempt ${exempt.length} 条)`)
  return unc.length
}

function probeLine(p, src) {
  const tag = `GATE-PROBE ${p}`
  if (p.endsWith('.sh')) return { at: src[0]?.startsWith('#!') ? 1 : 0, line: `echo '${tag}'` }
  if (p.endsWith('.py')) {
    // from __future__ 必须在最前:有就插在它后面,否则插在 shebang 后
    const fut = src.map((l, i) => (/^from __future__ import/.test(l) ? i : -1)).filter((i) => i >= 0).pop()
    return { at: fut !== undefined ? fut + 1 : src[0]?.startsWith('#!') ? 1 : 0, line: `print('${tag}', flush=True)` }
  }
  return { at: src[0]?.startsWith('#!') ? 1 : 0, line: `console.log('${tag}');` }
}

function tests(args) {
  const files = tracked().filter((p) => TEST_RE.test(p) && !isExempt(p) && !notTests.some((e) => e.re.test(p)))
  const dirty = lines(git(['status', '--porcelain', '--', ...files], root))
  if (dirty.length) throw new Error(`gates tests: 这些测试文件有未提交改动,探针会改写它们,先提交或换干净 worktree:\n${dirty.join('\n')}`)
  const restore = () => git(['checkout', '--', ...files], root)
  const plant = (some) => {
    for (const p of some) {
      const abs = join(root, p)
      const src = readFileSync(abs, 'utf8').split('\n')
      const { at, line } = probeLine(p, src)
      src.splice(at, 0, line)
      writeFileSync(abs, src.join('\n'))
    }
  }
  const probes = (out) => new Set([...out.matchAll(/GATE-PROBE (\S+)/g)].map((m) => m[1]))
  // 每条闸的日志留在 GATES_LOG_DIR(每周读数给的),REGRESSED 时修片从这里读红在哪
  const logDir = process.env.GATES_LOG_DIR
  if (logDir) execFileSync('mkdir', ['-p', logDir])
  const logOf = (name) => (logDir ? join(logDir, `${name.replace(/[^A-Za-z0-9._-]+/g, '_')}.log`) : '/dev/null')
  process.on('SIGINT', () => { restore(); process.exit(130) })
  // 读数里闸红先原样重跑一次:第二次绿 = FLAKY(照记,不算回归;两次都红才是 FAIL)。/verify 的 run 不重跑。
  const runOnce = (cmd, log) => {
    const r = runGate(cmd, log)
    if (r.status !== 'FAIL') return r
    const again = runGate(cmd, `${log}.retry`)
    return again.status === 'PASS' ? { ...again, status: 'FLAKY', out: `${r.out}\n${again.out}`, firstRc: r.rc } : again
  }
  const seen = new Set()
  const gateRc = []
  try {
    // 层闸:每条闸只在「路径命中它 pattern」的测试文件里插探针,单独跑一次,跑完还原 —— 改了别处的文件它本来就不会跑,
    // 也不该让别的目录的探针改动影响它(otherapp 的 gate-slice.test.ts 会拿工作区改动集跑 gitleaks,全插就成了另一个场景)
    for (const cmd of [...new Set(gates.map((g) => g.cmd))]) {
      const pats = gates.filter((x) => x.cmd === cmd)
      const mine = files.filter((p) => pats.some((g) => g.re.test(p)))
      plant(mine)
      const r = runOnce(cmd, logOf(`layer-${pats[0].pattern}`))
      for (const p of probes(r.out)) if (mine.includes(p)) seen.add(p)
      gateRc.push({ ...r, patterns: pats.map((g) => g.pattern) })
      restore()
    }
    // 片闸:跑哪些测试取决于改了什么,一起插会互相带出来。层闸没跑到的文件按前两段目录分组,每组单独插探针、单独跑一次片闸(基线 HEAD = 只有探针这组改动)
    if (sliceCmd) {
      const groups = new Map()
      for (const p of files.filter((f) => !seen.has(f))) {
        const k = p.split('/').slice(0, 2).join('/')
        groups.set(k, [...(groups.get(k) ?? []), p])
      }
      for (const [k, some] of groups) {
        plant(some)
        const r = runOnce(`${sliceCmd} HEAD`, logOf(`slice-${k}`))
        for (const p of probes(r.out)) if (some.includes(p)) seen.add(p)
        gateRc.push({ ...r, patterns: [`sliceGate:${k}`] })
        restore()
      }
    }
  } finally {
    restore()
  }
  const missing = files.filter((p) => !seen.has(p))
  if (args.includes('--json')) {
    // 有环境错:那条闸没跑,它的测试文件当然没探针 —— missing 数作废(env=true),不能当读数用
    const env = gateRc.some((g) => g.status === 'ENV')
    console.log(JSON.stringify({
      env, missing: env ? null : missing.length, total: files.length, files: env ? null : missing,
      gates: gateRc.map((g) => ({ patterns: g.patterns, status: g.status, rc: g.rc, ...(g.missing ? { envMissing: g.missing } : {}), ...(g.firstRc !== undefined ? { firstRc: g.firstRc } : {}) })),
    }))
    return env ? 0 : missing.length
  }
  for (const g of gateRc.filter((g) => g.status !== 'PASS' && g.status !== 'FLAKY')) console.log(`${g.status === 'ENV' ? `环境错(${g.missing} 找不到,读数作废)` : '闸红'}(rc=${g.rc}):${g.patterns.join(',')}`)
  for (const [dir, n] of byDir(missing)) console.log(`${dir.padEnd(16)} 没被任何闸执行的测试文件 ${n}`)
  if (args.includes('--list')) for (const p of missing) console.log(`  ${p}`)
  console.log(`没被执行 ${missing.length} / 测试文件 ${files.length}(notTests ${notTests.length} 条)`)
  return missing.length
}

const [sub, ...rest] = process.argv.slice(2)
try {
  if (sub === 'run') process.exit(run(rest[0] ? resolveBase(rest[0]) : resolveBase()))
  else if (sub === 'plan') console.log(JSON.stringify(plan(resolveBase(rest[0])), null, 2))
  else if (sub === 'check') {
    const unc = uncoveredOf(rest)
    for (const p of unc) console.log(p)
    process.exit(unc.length ? 1 : 0)
  } else if (sub === 'coverage') process.exit(coverage(rest) && rest.includes('--check') ? 1 : 0)
  else if (sub === 'tests') process.exit(tests(rest) && rest.includes('--check') ? 1 : 0)
  else { console.error('用法: gates.mjs run [基线] | plan [基线] | check <路径…> | coverage [--check] [--list] [--json] | tests [--check] [--list] [--json]'); process.exit(2) }
} catch (e) {
  console.error(e.message)
  process.exit(2)
}
