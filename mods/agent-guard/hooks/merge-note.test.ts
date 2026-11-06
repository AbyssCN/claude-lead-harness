// claude plugin test /home/user/repos/claude-mods/agent-guard
import { describe, expect, test } from 'claude-code/testing'
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { docsOnlyDrift, ffBranchesDeny, ffGateHead, ffHeadDeny, ffLogDeny, ffNotAncestorDeny, ffUnjudgedDeny, mergeMessage, mergeWordsIn, missingNoteLines, noteDeny, noteFaultToast, specGateRun, specVerdictDeny } from './merge-note'

const MAIN = '/r/myapp'
const WT = '/r/myapp-wt'
const OTHER = '/r/otherapp'
const dirs = new Set([MAIN, WT, OTHER, '/r'])
const SHA = 'ab'.repeat(20)
const NOTE = [
  'merge(agent-x): 三行齐的说明',
  `被审 SHA: ${SHA}`,
  '判词: docs/reviews/agent-x.md',
  '闸日志: /var/log/omdl/agent-x.log',
].join('\n')

// readFile 替身:`files` 里没有的路径读不到(null)。
const stub = (files: Record<string, string>) =>
  async (p: string) => files[p] ?? null

describe('S8 rules', () => {
  test('合并说明:多个 -m 用空行拼;-F / --file 读文件;读不到 → null;没给说明 → 空串;--abort → null', async () => {
    expect(await mergeMessage(['-m', 'a', '-m', 'b'], stub({}), MAIN)).toBe('a\n\nb')
    expect(await mergeMessage(['-m', 'merge'], stub({}), MAIN)).toBe('merge')
    expect(await mergeMessage(['git', 'merge', '--no-ff', '-m', NOTE], stub({}), MAIN)).toBe(NOTE)
    expect(await mergeMessage(['git', 'merge', '-F', 'note.md'], stub({ [`${MAIN}/note.md`]: 'x\ny\n' }), MAIN)).toBe('x\ny\n')
    expect(await mergeMessage(['git', 'merge', '--file=note.md'], stub({ [`${MAIN}/note.md`]: 'f' }), MAIN)).toBe('f')
    expect(await mergeMessage(['git', 'merge', '--file', 'note.md'], stub({ [`${MAIN}/note.md`]: 'f' }), MAIN)).toBe('f')
    expect(await mergeMessage(['git', 'merge', '-F', '/abs/note.md'], stub({ '/abs/note.md': 'abs' }), '/elsewhere')).toBe('abs')
    expect(await mergeMessage(['git', 'merge', '-F', 'note.md'], stub({}), MAIN)).toBe(null)
    expect(await mergeMessage(['git', 'merge', '--no-ff', 'agent/x'], stub({}), MAIN)).toBe('')
    expect(await mergeMessage(['git', 'merge', '--abort'], stub({}), MAIN)).toBe(null)
  })

  test('说明里缺哪一行', () => {
    expect(missingNoteLines(NOTE)).toEqual([])
    expect(missingNoteLines(NOTE.replace(SHA, SHA.slice(0, 39)))).toEqual(['被审 SHA'])
    expect(missingNoteLines(NOTE.replace('/var/log/omdl/agent-x.log', 'var/log/agent-x.log'))).toEqual(['闸日志'])
    expect(missingNoteLines(NOTE.replace(/^判词: .*\n/m, ''))).toEqual(['判词'])
    expect(missingNoteLines(NOTE.replace(/^判词: .*$/m, '判词: '))).toEqual(['判词'])
    expect(missingNoteLines(NOTE.replace(/^被审 SHA.*$/m, '审查对象 @ abc'))).toEqual(['被审 SHA'])
    expect(missingNoteLines('merge: x')).toEqual(['被审 SHA', '判词', '闸日志'])
  })

  test('每个 merge 各自接回自己的说明参数(控制类参数不抢;配不上 → null)', () => {
    const line = 'git merge --abort; git merge -m "one" a && git merge -F f.txt b'
    expect(mergeWordsIn(line, [{ branches: ['b'] }, { branches: ['a'] }])).toEqual([
      ['git', 'merge', '-F', 'f.txt', 'b'],
      ['git', 'merge', '-m', 'one', 'a'],
    ])
    expect(mergeWordsIn('git -C /r/myapp merge -m n b', [{ branches: ['b'] }])).toEqual([['git', '-C', '/r/myapp', 'merge', '-m', 'n', 'b']])
    expect(mergeWordsIn('git merge a', [{ branches: ['zzz'] }])).toEqual([null])
    expect(mergeWordsIn('git rebase b', [{ branches: ['b'] }])).toEqual([null])
  })

  test('闸日志里的分支头:最后一行 head_end 的 40 位值;没有 → null', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    expect(ffGateHead(`base=${a} head_start=${b} branch=land/f4\n闸跑完\nexit=0\nhead_end=${a} branch=land/f4\n`)).toBe(a)
    expect(ffGateHead(`exit=0\nhead_end=${a} branch=land/f4\nexit=0\nhead_end=${b} branch=land/f5\n`)).toBe(b)
    expect(ffGateHead(`exit=0\nhead_end=${a.slice(0, 39)} branch=land/f4\n`)).toBe(null)
    expect(ffGateHead('exit=0\nhead_end=deadbeef\n')).toBe(null)
    expect(ffGateHead('')).toBe(null)
  })

  test('拒绝与故障的文字(写死)', () => {
    expect(noteDeny('myapp', ['被审 SHA', '判词', '闸日志'])).toBe(
      'agent-guard(S8):合并说明缺「被审 SHA · 判词 · 闸日志」—— 合进 myapp 主干的说明要机械含三行:被审 SHA: <sha> / 判词: <路径 | 不需跨模型审(needs-cross-review 0)> / 闸日志: <路径>。用 scripts/dev/omdl-merge.sh 合,或 -m 里自己写全。',
    )
    expect(noteDeny('myapp', ['闸日志'])).toContain('缺「闸日志」')
    expect(noteFaultToast('读不到 note.md')).toBe('agent-guard(S8):判不了合并说明(读不到 note.md),已放行')
    // 快进那三条:说明里只有闸日志那一行,不给过的理由得说清。
    expect(ffLogDeny('myapp')).toBe(
      'agent-guard(S8):快进缺「闸日志: <路径>」—— 快进 myapp 主干要指向判过这个分支头的那份闸日志(末尾有 exit=0 与 head_end=<sha>)。',
    )
    expect(ffUnjudgedDeny('/g/l.log')).toBe('agent-guard(S8):闸日志 /g/l.log 里没有 exit=0 与 head_end 两行,判不出闸绿时的分支头。')
    expect(ffHeadDeny('agent/x', 'ab'.repeat(20), '/g/l.log', 'cd'.repeat(20))).toBe(
      `agent-guard(S8):agent/x 现在是 ${'ab'.repeat(20)},闸日志 /g/l.log 判的是 ${'cd'.repeat(20)} —— 闸判过之后分支又动过,重跑闸再快进。`,
    )
    expect(ffBranchesDeny(['agent/x', 'agent/y'])).toBe(
      'agent-guard(S8):这条快进合的是 agent/x · agent/y,闸日志末尾的 head_end 只判一个分支的头 —— 拆成一条条 merge,每条带自己那份闸日志。',
    )
    expect(ffNotAncestorDeny('land/f4', '/g/l.log', 'cd'.repeat(20))).toBe(
      `agent-guard(S8):闸日志 /g/l.log 判的 ${'cd'.repeat(20)} 不是 land/f4 的祖先 —— 这份日志判的不是这条分支,重跑闸再快进。`,
    )
  })

  // 闸判过的那个头之后,分支只许带进 docs/*.md:docs/ 下也有闸会跑的东西(测试、原型),只放 Markdown。
  test('docsOnlyDrift:只放行 docs/*.md;空数组(闸后没有文件改动)也放行', () => {
    expect(docsOnlyDrift(['docs/a.md'])).toBe(true)
    expect(docsOnlyDrift([])).toBe(true)
    expect(docsOnlyDrift(['docs/a.md', 'scripts/x.sh'])).toBe(false)
    expect(docsOnlyDrift(['docs/design/tests/shots.mjs'])).toBe(false)
    expect(docsOnlyDrift(['apps/web/a.test.ts'])).toBe(false)
  })
})

// ---- S9:omdl/* 要有绑同一个被审提交、判官问够 3 遍、任务书没改过的规格判词 ----

// 任务书当前内容的 sha256(specShaNow 由钩子那层算好传进来;判词里的 specSha 要与它相同)。
const SPEC_SHA = 'c'.repeat(64)

// 一份 spec-verdict.json 的原文(形状见 S9a/S9c:三组条目 + head / base / spec / specSha / runs / at)。
const verdict = (over: Record<string, unknown> = {}, head = SHA): { path: string; text: string } => ({
  path: '/r/runs/x/spec-verdict.json',
  text: JSON.stringify({
    missing: [], extra: [], wrong: [], head, base: 'cd'.repeat(20), spec: '/r/docs/x.md',
    specSha: SPEC_SHA, runs: 3, at: '2026-10-19T00:00:00Z', ...over,
  }),
})

describe('S9 rules', () => {
  const denyOf = (c: { path: string; text: string; specSha?: string | null }[]): string => {
    const d = specVerdictDeny('omdl/x', SHA, c, SPEC_SHA)
    expect(d).not.toBe(null)
    return d as string
  }

  test('只管 omdl/<片名>:run 名(判词目录名)是后半截;别的前缀不管', () => {
    expect(specGateRun('omdl/x')).toBe('x')
    expect(specGateRun('land/f4')).toBe(null)
    expect(specGateRun('fix/y')).toBe(null)
    expect(specGateRun('omdl/')).toBe(null)
    expect(specGateRun('omdl/x/y')).toBe(null)
    expect(specGateRun('omdlx')).toBe(null)
    expect(specGateRun('omdl/..')).toBe(null) // 全是点的名字会把判词路径指到 <runs> 外面
  })

  test('空判词绑的就是这次要合的 sha → 放行;多份候选里有一份合格 → 也放行', () => {
    expect(specVerdictDeny('omdl/x', SHA, [verdict()], SPEC_SHA)).toBe(null)
    expect(specVerdictDeny('omdl/x', SHA, [verdict({ head: 'cd'.repeat(20) }, 'cd'.repeat(20)), verdict()], SPEC_SHA)).toBe(null)
    expect(specVerdictDeny('omdl/x', SHA, [verdict(), verdict()], SPEC_SHA)).toBe(null)
  })

  // S9c:重跑到绿的那一遍不算数 —— runs 不足 3 一律拒,不管三组是不是全空。
  test('runs 不足 3 → 拒,文字点名 runs 不足 3;runs = 3 且其余都对 → 放行', () => {
    expect(denyOf([verdict({ runs: 2 })])).toContain('runs 不足 3')
    expect(denyOf([verdict({ runs: 1, extra: ['y'] })])).toContain('runs 不足 3')
    expect(denyOf([verdict({ runs: undefined })])).toContain('runs 不足 3') // 旧格式判词:没有 runs
    expect(specVerdictDeny('omdl/x', SHA, [verdict({ runs: 3 })], SPEC_SHA)).toBe(null)
    expect(specVerdictDeny('omdl/x', SHA, [verdict({ runs: 9 })], SPEC_SHA)).toBe(null) // 问过几遍都不打紧,够就行
  })

  // S9c:判完之后任务书被改过,那份判词说的就不是这一版要求的事。两个 sha 都要露头 9 位。
  test('specSha 与任务书现在的内容对不上 → 拒,文字点名任务书改过;候选自带 specSha 时以自己的为准', () => {
    expect(denyOf([verdict({ specSha: 'd'.repeat(64) })])).toContain('任务书改过')
    expect(denyOf([verdict({ specSha: undefined })])).toContain('任务书改过') // 旧格式判词:没记 specSha
    const d = denyOf([verdict({ specSha: 'd'.repeat(64) })])
    expect(d).toContain('d'.repeat(64).slice(0, 9))
    expect(d).toContain(SPEC_SHA.slice(0, 9))
    // 钩子读不到任务书(specShaNow = null)时按不匹配处理:判不出有没有改,不能因此放行。
    expect(specVerdictDeny('omdl/x', SHA, [verdict()], null)).toContain('读不到')
    // 候选各自带 specSha(不同候选的 spec 路径可能不同)时,不比那个兜底值。
    expect(specVerdictDeny('omdl/x', SHA, [{ ...verdict(), specSha: SPEC_SHA }], 'e'.repeat(64))).toBe(null)
    expect(specVerdictDeny('omdl/x', SHA, [{ ...verdict(), specSha: 'e'.repeat(64) }], SPEC_SHA)).toContain('任务书改过')
  })

  test('有条目但带理由接受(accepted.why 非空)→ 放行;理由空串 / 没有 accepted → 拒', () => {
    expect(specVerdictDeny('omdl/x', SHA, [verdict({ extra: ['y'], accepted: { why: '防御判断', at: 't' } })], SPEC_SHA)).toBe(null)
    expect(denyOf([verdict({ extra: ['y'], accepted: { why: '  ' } })])).toContain('extra 1')
    expect(denyOf([verdict({ extra: ['y'] })])).toContain('--accept')
  })

  test('判词绑的是别的提交 → 拒,文字点两个 sha 的头 9 位与下一步跑哪条命令', () => {
    const d = denyOf([verdict({ head: 'cd'.repeat(20) }, 'cd'.repeat(20))])
    expect(d.startsWith('agent-guard(S9):')).toBe(true)
    expect(d).toContain(SHA.slice(0, 9))
    expect(d).toContain('cd'.repeat(20).slice(0, 9))
    expect(d).toContain('node <lead-harness>/factory/dev/spec-check.mjs x')
  })

  test('三组里有一条(missing · extra · wrong)→ 拒,文字说各有几条', () => {
    const d = denyOf([verdict({ extra: ['多改了 y'] })])
    expect(d).toContain('extra 1')
    expect(d).toContain('missing 0')
    expect(d).toContain('wrong 0')
    expect(denyOf([verdict({ missing: ['a.txt 没写'] })])).toContain('missing 1')
    expect(denyOf([verdict({ wrong: ['a.txt 写歪了'] })])).toContain('wrong 1')
  })

  test('解析不了(坏 JSON / 形状对不上)→ 拒,文字点名那份文件;读不到也当候选,不谎报「没有判词」', () => {
    for (const text of ['{', '', 'null', '{}', '{"head":"ab"}', `{"head":"${SHA}","missing":"x","extra":[],"wrong":[]}`]) {
      const d = denyOf([{ path: '/r/runs/x/spec-verdict.json', text }])
      expect(d.startsWith('agent-guard(S9):')).toBe(true)
      expect(d).toContain('/r/runs/x/spec-verdict.json')
      expect(d).toContain('解析不了')
    }
  })

  test('一份候选都没有 → 拒,说清没有 spec-verdict.json 与下跑哪条命令', () => {
    const d = denyOf([])
    expect(d).toContain('没有 spec-verdict.json')
    expect(d).toContain('x-r<数字>')
    expect(d).toContain('node <lead-harness>/factory/dev/spec-check.mjs x')
  })
})

// ---- 钩子那层(假 MyApp:MAIN / OTHER 是主 worktree,WT 是 linked 的)----

// 闸后漂移那三条命令(merge-base --is-ancestor · diff --name-only · log --format= --name-only)的应答,
// 按分支头 SHA 给(driftAt):ancestor 是 merge-base 的结局('yes' 退 0 · 'no' 退 1 · 'boom' 命令起不来),
// net / each 是两条 --name-only 各自的输出(换行分隔)。
type Drift = { ancestor?: 'yes' | 'no' | 'boom'; net?: string; each?: string }
type World = { toasts: string[]; touch: Record<string, number>; files: Record<string, Record<string, number>>; read: Record<string, string>; objects: string[]; heads: Record<string, string>; drift: Record<string, Drift> }

// `touch` 是 needs-cross-review 对每个分支的退出码(缺省 0 = 不碰敏感路径,G-R 放行)。
function world(on: On, cwd: string, w: Partial<World> = {}): World {
  const s: World = { toasts: [], touch: {}, files: {}, read: {}, objects: [SHA], heads: {}, drift: {}, ...w }
  mock.env(on, { HOME: '/home/t' })
  on('session.cwd', () => ({ value: cwd }))
  on('fs.stat', (_, e) => {
    if (!dirs.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } as never
  })
  on('fs.read', (_, e) => {
    const t = s.read[e.path]
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: t } as never
  })
  on('ui.toast', (_, e) => (s.toasts.push(String(e.text)), { value: { isShown: true } }) as never)
  on('process.run', (_, e) => {
    const a = [...e.argv] as string[]
    const done = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'bash') {
      const code = s.touch[a[5] as string] ?? 0
      return done(code, code === 2 ? 'needs-cross-review: 需要…\n  apps/web/src/lib/x/actions.ts  ← apps/web/src/*/actions.ts\n' : 'ok')
    }
    const dir = a[2] as string
    const rest = a.slice(3)
    if (rest[0] === 'rev-parse') {
      const q = rest[rest.length - 1]
      if (q === '--show-toplevel') return dirs.has(dir) ? done(0, dir) : done(128)
      if (q.endsWith('^{commit}')) {
        const head = s.heads[q.slice(0, -'^{commit}'.length)] // rev-parse --verify <分支>^{commit}: 分支头
        return head ? done(0, head) : done(128)
      }
      if (dir === WT) return done(0, q === '--git-dir' ? `${MAIN}/.git/worktrees/wt` : `${MAIN}/.git`)
      return dirs.has(dir) ? done(0, `${dir}/.git`) : done(128)
    }
    if (rest[0] === 'cat-file') return done(s.objects.includes(String(rest[2]).replace('^{commit}', '')) ? 0 : 128)
    // 闸后漂移那三条命令都以分支头为末位参数(log 的是 `X..Y`):drift 按那个头给应答,没配就算 git 自己起不来(退 128)。
    // 只认下面这几个 argv 形状,判词那层自己的 git 调用(merge-base --is-ancestor <sha> <分支> 等)照旧往下走。
    const driftAt = () => s.drift[String(rest[rest.length - 1] as string).split('..').pop() as string]
    if (rest[0] === 'merge-base' && rest[1] === '--is-ancestor' && rest.length === 4) {
      const a = driftAt()?.ancestor
      if (a === 'yes') return done(0)
      if (a === 'no') return done(1)
      if (a === 'boom') throw new Error(`spawn git -C ${dir} merge-base ENOENT`)
      return done(128)
    }
    if (rest[0] === 'diff' && rest[1] === '--name-only' && rest.length === 4) return done(0, driftAt()?.net ?? '')
    if (rest[0] === 'log' && rest.includes('--name-only')) return done(0, driftAt()?.each ?? '')
    if (rest[0] === 'ls-tree') return done(0, Object.keys(s.files[rest[3] as string] ?? {}).join('\n'))
    if (rest[0] === 'grep') return done(1)
    return done(128)
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  return s
}

// Each line as its own quoted -m (shellCommands keeps quotes inert).
const noteArgs = (...lines: string[]) => lines.map(l => `-m "${l}"`).join(' ')
const FULL_NOTE = noteArgs('merge(agent-x): 合', `被审 SHA: ${SHA}`, '判词: docs/reviews/agent-x.md', '闸日志: /var/log/omdl/agent-x.log')

// 一份闸日志:首行 base=…,末尾 exit=<码> 与 head_end=<sha> branch=<名> 两行。
const gateLog = (head: string, code = 0): string =>
  `base=${SHA} head_start=${'ba'.repeat(20)} branch=land/f4\n闸跑完了\nexit=${code}\nhead_end=${head} branch=land/f4\n`

const run = ($: { tool: { call: (x: never) => Promise<{ deny?: string }> } }, command: string) =>
  $.tool.call({ tool: 'Bash', command } as never)

describe('S8 hook: git merge in MyApp main checkout', () => {
  test('说明没三行 → 拒,文字说缺哪几行;三行齐 → 放行', async ($, on) => {
    world(on, MAIN)
    const d = (await run($, 'git merge --no-ff -m "merge(x): y" agent/x')).deny
    expect(d).toContain('agent-guard(S8)')
    expect(d).toContain('被审 SHA · 判词 · 闸日志')
    expect(d).toContain('合进 myapp 主干')
    expect((await run($, `git merge --no-ff ${FULL_NOTE} agent/x`)).deny).toBeUndefined()
  })

  test('被审 SHA 形状对、仓里没有这个提交(伪造 / 补零)→ 拒,文字点名那个 SHA', async ($, on) => {
    world(on, MAIN)
    const fake = '2449221920000000000000000000000000000000'
    const note = noteArgs('merge(agent-x): 合', `被审 SHA: ${fake}`, '判词: docs/reviews/agent-x.md', '闸日志: /var/log/omdl/agent-x.log')
    const d = (await run($, `git merge --no-ff ${note} agent/x`)).deny
    expect(d).toContain('agent-guard(S8)')
    expect(d).toContain(`被审 SHA ${fake} 在仓里不是一个提交`)
    expect((await run($, `git merge --no-ff ${FULL_NOTE} agent/x`)).deny).toBeUndefined()
  })

  test('只缺一行时只说那一行;git 默认说明(--no-edit / 不给 -m)也拒', async ($, on) => {
    world(on, MAIN)
    expect((await run($, `git merge --no-ff ${noteArgs('merge(agent-x): 合', `被审 SHA: ${SHA}`)} agent/x`)).deny).toContain('缺「判词 · 闸日志」')
    expect((await run($, 'git merge --no-ff --no-edit agent/x')).deny).toContain('被审 SHA · 判词 · 闸日志')
    expect((await run($, 'git merge --no-ff agent/x')).deny).toContain('被审 SHA · 判词 · 闸日志')
  })

  test('-F 说明:读得到 → 按内容判;读不到 → 放行并 toast 一行', async ($, on) => {
    const w = world(on, MAIN, { read: { [`${MAIN}/note.md`]: NOTE } })
    expect((await run($, 'git merge --no-ff -F note.md agent/x')).deny).toBeUndefined()
    expect(w.toasts.join('\n')).toBe('')
    expect((await run($, 'git merge --no-ff -F missing.md agent/x')).deny).toBeUndefined()
    expect(w.toasts.join('\n')).toContain('判不了合并说明')
  })

  test('G-R 在前:它拒的时候文字是 G-R 的;它只是 fault 放行时 S8 照样查', async ($, on) => {
    world(on, MAIN, { touch: { 'agent/x': 2 }, files: { 'agent/x': {}, main: {} } })
    const d = (await run($, 'git merge --no-ff -m "merge(x): y" agent/x')).deny
    expect(d).toContain('G-R')
    expect(d).not.toContain('S8')
  })

  test('只管配置仓的主 worktree:linked worktree / 别的仓 / merge --abort 都不查', async ($, on) => {
    const w = world(on, WT)
    expect((await run($, 'git merge --no-ff -m "merge(x): y" agent/x')).deny).toBeUndefined()
    expect((await run($, `cd ${WT} && git merge --no-ff -m "merge(x): y" agent/x`)).deny).toBeUndefined()
    expect((await run($, `git -C ${OTHER} merge --no-ff -m "merge(x): y" agent/x`)).deny).toBeUndefined()
    expect((await run($, 'git merge --abort')).deny).toBeUndefined()
    expect((await run($, `git -C ${MAIN} merge --no-ff -m "merge(x): y" agent/x`)).deny).toContain('S8')
    expect(w.toasts.join('\n')).toBe('')
  })

  test('快进 --ff-only:分支头 = 闸日志的 head_end → 放行(不用被审 SHA 与判词);闸日志读不到 → 放行并 toast 一行', async ($, on) => {
    const head = 'cd'.repeat(20)
    const w = world(on, MAIN, { heads: { 'agent/x': head }, read: { '/g/ok.txt': gateLog(head) } })
    expect((await run($, 'git merge --ff-only -m "merge(x): y" -m "闸日志: /g/ok.txt" agent/x')).deny).toBeUndefined()
    expect(w.toasts.join('\n')).toBe('')
    expect((await run($, 'git merge --ff-only -m "闸日志: /g/gone.txt" agent/x')).deny).toBeUndefined()
    expect(w.toasts.join('\n')).toContain('读不到闸日志 /g/gone.txt')
  })

  test('快进:分支头 ≠ head_end,闸后带进来的不全是 docs/*.md → 拒,文字说闸判过之后分支又动过', async ($, on) => {
    const head = 'ef'.repeat(20)
    world(on, MAIN, {
      heads: { 'agent/x': head },
      read: { '/g/ok.txt': gateLog('cd'.repeat(20)) },
      drift: { [head]: { ancestor: 'yes', net: 'scripts/x.sh', each: 'scripts/x.sh\n' } },
    })
    const d = (await run($, 'git merge --ff-only -m "闸日志: /g/ok.txt" agent/x')).deny
    expect(d).toContain('agent-guard(S8)')
    expect(d).toContain('闸判过之后分支又动过')
  })

  test('快进:闸后分支只推进了 docs/*.md → 放行(闸不审文档,不 deny 不 toast)', async ($, on) => {
    const head = 'ef'.repeat(20)
    const w = world(on, MAIN, {
      heads: { 'agent/x': head },
      read: { '/g/ok.txt': gateLog('cd'.repeat(20)) },
      drift: { [head]: { ancestor: 'yes', net: 'docs/plan/a.md\ndocs/plan/b.md', each: 'docs/plan/a.md\n\ndocs/plan/b.md\n' } },
    })
    expect((await run($, 'git merge --ff-only -m "闸日志: /g/ok.txt" agent/x')).deny).toBeUndefined()
    expect(w.toasts.join('\n')).toBe('')
  })

  test('快进:闸后有一个提交改了 scripts/dev/x.sh → 仍拒;两条 --name-only 取并集(并集里 merge 提交带的文件只有净差异看得到)', async ($, on) => {
    const head = 'ef'.repeat(20)
    // gate/from-merge.ts 是区间里一个 merge 提交带进来的:净差异看得到它,log --name-only 不给 merge 提交的差异。
    world(on, MAIN, {
      heads: { 'agent/x': head },
      read: { '/g/ok.txt': gateLog('cd'.repeat(20)) },
      drift: {
        [head]: {
          ancestor: 'yes',
          net: 'docs/plan/a.md\nscripts/dev/x.sh\ngate/from-merge.ts\napps/web/z.ts\ngate/run.sh',
          each: 'docs/plan/a.md\n\nscripts/dev/x.sh\napps/web/z.ts\ngate/run.sh\n',
        },
      },
    })
    const d = (await run($, 'git merge --ff-only -m "闸日志: /g/ok.txt" agent/x')).deny
    expect(d).toContain('闸判过之后分支又动过')
    expect(d).toContain('scripts/dev/x.sh')
    expect(d).toBe(
      `agent-guard(S8):agent/x 现在是 ${head},闸日志 /g/ok.txt 判的是 ${'cd'.repeat(20)} —— 闸判过之后分支又动过,重跑闸再快进。` +
      '(闸后进来的不全是 docs/*.md:scripts/dev/x.sh · gate/from-merge.ts · apps/web/z.ts)',
    )
  })

  test('快进:闸后改的是 docs/ 下的测试(docs/design/tests/a.test.mjs)→ 仍拒(docs/ 下不只放 Markdown)', async ($, on) => {
    const head = 'ef'.repeat(20)
    world(on, MAIN, {
      heads: { 'agent/x': head },
      read: { '/g/ok.txt': gateLog('cd'.repeat(20)) },
      drift: { [head]: { ancestor: 'yes', net: '', each: 'docs/plan/a.md\ndocs/design/tests/a.test.mjs\n' } },
    })
    const d = (await run($, 'git merge --ff-only -m "闸日志: /g/ok.txt" agent/x')).deny
    expect(d).toContain('闸判过之后分支又动过')
    expect(d).toContain('docs/design/tests/a.test.mjs')
  })

  test('快进:head_end 不是分支头的祖先(merge-base 退 1)→ 拒,文字说这份日志判的不是这条分支', async ($, on) => {
    const head = 'ef'.repeat(20)
    world(on, MAIN, {
      heads: { 'land/f4': head },
      read: { '/g/ok.txt': gateLog('cd'.repeat(20)) },
      drift: { [head]: { ancestor: 'no' } },
    })
    const d = (await run($, 'git merge --ff-only -m "闸日志: /g/ok.txt" land/f4')).deny
    expect(d).toContain('agent-guard(S8)')
    expect(d).toContain('不是 land/f4 的祖先')
  })

  test('快进:merge-base 起不来 → 放行并 toast 一行(点不出是不是祖先就别默默放过)', async ($, on) => {
    const head = 'ef'.repeat(20)
    const w = world(on, MAIN, {
      heads: { 'agent/x': head },
      read: { '/g/ok.txt': gateLog('cd'.repeat(20)) },
      drift: { [head]: { ancestor: 'boom' } },
    })
    expect((await run($, 'git merge --ff-only -m "闸日志: /g/ok.txt" agent/x')).deny).toBeUndefined()
    expect(w.toasts.join('\n')).toContain('merge-base')
  })

  test('快进:说明里没有「闸日志:」→ 拒;一条 merge 合两个分支 → 也拒', async ($, on) => {
    world(on, MAIN, { heads: { 'agent/x': 'cd'.repeat(20) } })
    expect((await run($, 'git merge --ff-only -m "merge(x): y" agent/x')).deny).toContain('快进缺「闸日志')
    expect((await run($, 'git merge --ff-only -m "闸日志: /g/ok.txt" agent/x agent/y')).deny).toContain('这条快进合的是 agent/x · agent/y')
  })

  test('快进:闸日志是 exit=1 → 拒,判不出闸绿时的分支头', async ($, on) => {
    world(on, MAIN, { heads: { 'agent/x': 'cd'.repeat(20) }, read: { '/g/ok.txt': gateLog('cd'.repeat(20), 1) } })
    expect((await run($, 'git merge --ff-only -m "闸日志: /g/ok.txt" agent/x')).deny).toContain('判不出闸绿时的分支头')
  })

  test('非快进的 merge 判法没变:那份闸日志本该放行快进,但三行说明里的补零 SHA 仍按 cat-file 拒', async ($, on) => {
    const fake = '2449221920000000000000000000000000000000'
    world(on, MAIN, { heads: { 'agent/x': fake }, read: { '/g/ok.txt': gateLog(fake) } })
    const note = noteArgs('merge(agent-x): 合', `被审 SHA: ${fake}`, '判词: docs/reviews/agent-x.md', '闸日志: /g/ok.txt')
    const d = (await run($, `git merge --no-ff ${note} agent/x`)).deny
    expect(d).toContain('agent-guard(S8)')
    expect(d).toContain(`被审 SHA ${fake} 在仓里不是一个提交`)
  })
})
