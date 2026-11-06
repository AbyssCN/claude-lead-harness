// claude plugin test agent-guard —— agent/devbox-route 第 2 份审(只审修复段)的反例:每条在 4e2e69c 上红。
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MAIN = '/r/myapp'
const WT = '/r/myapp-wt'
const LEDGER = '/home/t/.omd-lite/readings/heavy-route.jsonl'
const dirs = new Set([MAIN, WT, '/r'])
const seen: { commands: string[]; ledger: Record<string, unknown>[] } = { commands: [], ledger: [] }

// 与 guard.test.ts 的 world 同形状,只留重命令送 build box 用得到的部分:WT 是 MyApp 的 linked worktree。
function world(on: On, cwd: string): void {
  seen.commands = []
  seen.ledger = []
  mock.env(on, { HOME: '/home/t' })
  on('session.cwd', () => ({ value: cwd }))
  on('fs.stat', (_, e) => {
    if (!dirs.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } as never
  })
  on('ui.toast', () => ({ value: { isShown: true } }) as never)
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    const dir = argv[2] as string
    const q = argv[argv.length - 1]
    const done = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'bash' && argv.includes(LEDGER)) {
      seen.ledger.push(JSON.parse(String(argv[argv.length - 1])))
      return done(0, '')
    }
    if (argv[0] === 'git' && argv.includes('--show-toplevel') && argv.includes('--git-common-dir')) {
      if (dir === WT) return done(0, `${WT}\n${MAIN}/.git\n`)
      if (dir === MAIN) return done(0, `${MAIN}\n${MAIN}/.git\n`)
      return done(128, '')
    }
    if (dir === MAIN) return done(0, `${MAIN}/.git`)
    if (dir === WT) return done(0, q === '--git-dir' ? `${MAIN}/.git/worktrees/wt` : `${MAIN}/.git`)
    return done(128, '')
  })
  on('tool.call', { tool: 'Bash' }, (_, e) => (seen.commands.push(String(e.command)), { result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
}

const sub = { agentId: 'a1' }
const run = ($: { tool: { call: (x: never) => Promise<{ deny?: string }> } }, command: string, extra: object = {}) =>
  $.tool.call({ tool: 'Bash', command, ...extra } as never)
// 这条命令最后有没有被改写成经 remote-run 送去 build box(拒 = 没送)。
const shipped = () => seen.commands.some(c => c.includes('remote-run.sh'))

describe('审 agent/devbox-route 修复段:反例', () => {
  // F1 变体:WRITE_FLAGS 只认整词 --update-snapshots;Playwright 的 --update-snapshots=<mode> 带值写法照样送 build box,快照改动留在 build box。
  test('F1 playwright --update-snapshots=all 不许送 build box', async ($, on) => {
    world(on, WT)
    for (const c of ['npx playwright test --update-snapshots=all', 'npx playwright test --update-snapshots=changed']) {
      seen.commands = []
      await run($, c, sub)
      expect({ c, shipped: shipped() }).toEqual({ c, shipped: false })
    }
  })

  // F5 变体:BROWSER_FLAGS 只给 playwright 且只认 --ui/--headed/--debug;vitest --ui、--ui-port、PWDEBUG=1 都要本机窗口,照样送 build box。
  test('F5 要本机浏览器窗口的 vitest --ui · playwright --ui-port · PWDEBUG=1 留本机', async ($, on) => {
    world(on, WT)
    for (const c of ['npx vitest --ui', 'npx playwright test --ui-port=0', 'PWDEBUG=1 npx playwright test']) {
      seen.commands = []
      await run($, c, sub)
      expect({ c, shipped: shipped() }).toEqual({ c, shipped: false })
    }
  })
})
