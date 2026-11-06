// claude plugin test agent-guard —— agent/devbox-route 跨模型审(claude)的反例:每条在 33de0d1 上红。
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

describe('审 agent/devbox-route:反例', () => {
  // D2:改文件的重命令(--fix / 快照更新)送去 build box,改动留在 build box 的临时 worktree,本机拿不回来,会话以为已改好。
  test('D2 写回本机的重命令(eslint --fix · lint:fix · vitest -u)不许送 build box', async ($, on) => {
    world(on, WT)
    for (const c of ['npx eslint --fix .', 'npm run lint:fix', 'npm run lint -- --fix', 'npx vitest run -u', 'npx vitest run --update']) {
      seen.commands = []
      await run($, c, sub)
      expect({ c, shipped: shipped() }).toEqual({ c, shipped: false })
    }
  })

  // D2/D3:BENIGN 里的 tee / sed 与重定向会在 build box 上落文件;下一条 Bash 在本机读到的是旧文件或没有文件。
  test('D3 混着本机落文件的 tee / sed -i / 重定向不许整条送 build box', async ($, on) => {
    world(on, WT)
    for (const c of [
      'npx vitest run 2>&1 | tee /tmp/vt.log',
      'npx vitest run --reporter=json > /tmp/vt.json',
      "npx tsc --noEmit && sed -i 's/a/b/' apps/web/src/x.ts",
    ]) {
      seen.commands = []
      await run($, c, sub)
      expect({ c, shipped: shipped() }).toEqual({ c, shipped: false })
    }
  })

  // D3:双引号里的 $(…) 不被拆开,里面的 git commit 认不出来,整条送走,提交落在 build box 的临时 worktree。
  test('D3 双引号里 $(git commit) 混重命令要拒', async ($, on) => {
    world(on, WT)
    const c = 'echo "$(git commit -qam wip)" && npx vitest run'
    await run($, c, sub)
    expect({ c, shipped: shipped() }).toEqual({ c, shipped: false })
  })

  // D4:子 agent 自己加 LOCAL_RUN_ACK 就在本机跑重命令;同仓 DEVSTACK_RESET_ACK 只认主会话。
  test('D4 子 agent 自带 LOCAL_RUN_ACK 不许放本机', async ($, on) => {
    world(on, WT)
    const c = "LOCAL_RUN_ACK='想本机跑' npx vitest run"
    const out = await run($, c, sub)
    expect({ ranLocal: out.deny === undefined && seen.commands[0] === c }).toEqual({ ranLocal: false })
  })

  // D1:读 .env*(remote-run 不送)与要本机浏览器窗口的命令,KEEP_LOCAL 不认,照样送走。
  test('D1 读 .env* / 要本机浏览器的重命令留本机', async ($, on) => {
    world(on, WT)
    for (const c of ['node --env-file=.env.local --test scripts/x.test.mjs', 'npx playwright test --ui', 'npx playwright test --headed']) {
      seen.commands = []
      await run($, c, sub)
      expect({ c, shipped: shipped() }).toEqual({ c, shipped: false })
    }
  })
})
