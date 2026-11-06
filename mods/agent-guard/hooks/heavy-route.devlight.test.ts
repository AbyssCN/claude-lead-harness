// owner 2.11:开发机要一直是轻的。认的命令补全;MyApp 仓里放本机的结论改成拒,只留发版 · 合并打戳 · 执行体沙箱 · 非 MyApp 仓 · 主会话 ack。
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MAIN = '/r/myapp'
const WT = '/r/myapp-wt'
const WT_WEB = `${WT}/apps/web`
const CM = '/r/claude-mods-wt'
const PIW = '/r/piw'
const RELEASE = '/r/myapp-release'
const NOREPO = '/r'
const LEDGER = '/home/t/.omd-lite/readings/heavy-route.jsonl'
const seen: { commands: string[]; ledger: Record<string, unknown>[] } = { commands: [], ledger: [] }

function world(on: On, cwd: string, env: Record<string, string> = {}): void {
  seen.commands = []
  seen.ledger = []
  mock.env(on, { HOME: '/home/t', ...env })
  on('session.cwd', () => ({ value: cwd }))
  on('fs.stat', (_, e) => {
    if (![MAIN, WT, WT_WEB, CM, PIW, NOREPO, RELEASE].includes(e.path)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } as never
  })
  on('ui.toast', () => ({ value: { isShown: true } }) as never)
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    const dir = argv[2] as string
    const done = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'bash' && argv.includes(LEDGER)) {
      seen.ledger.push(JSON.parse(String(argv[argv.length - 1])))
      return done(0, '')
    }
    if (argv[0] === 'git' && argv.includes('--show-toplevel') && argv.includes('--git-common-dir')) {
      if (dir === WT || dir === WT_WEB) return done(0, `${WT}\n${MAIN}/.git\n`)
      if (dir === RELEASE) return done(0, `${RELEASE}\n${MAIN}/.git\n`)
      if (dir === CM) return done(0, `${CM}\n/r/claude-mods/.git\n`)
      if (dir === PIW) return done(0, `${PIW}\n${PIW}/.git\n`)
      return done(128, '')
    }
    if (dir === WT) return done(0, argv[argv.length - 1] === '--git-dir' ? `${MAIN}/.git/worktrees/wt` : `${MAIN}/.git`)
    if (dir === CM) return done(0, argv[argv.length - 1] === '--git-dir' ? '/r/claude-mods/.git/worktrees/wt' : '/r/claude-mods/.git')
    if (dir === PIW) return done(0, `${PIW}/.git`)
    return done(128, '')
  })
  on('tool.call', { tool: 'Bash' }, (_, e) => (seen.commands.push(String(e.command)), { result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
}

type Out = { deny?: string }
const sub = { agentId: 'a1' }
const run = async ($: { tool: { call: (x: never) => Promise<Out> } }, command: string, extra: object = {}): Promise<Out> => {
  seen.commands = []
  seen.ledger = []
  return $.tool.call({ tool: 'Bash', command, ...extra } as never)
}
const shipped = (): boolean => seen.commands.some(x => x.includes('remote-run.sh'))
const ALT = `cd '${WT}' && REMOTE_GATE_HOST=gate@build-box bash scripts/dev/remote-run.sh --kind dev -- `

describe('devlight: 认的命令补全,在 MyApp 仓里改写送 build box', () => {
  for (const [c, kind] of [
    ['npx tsgo --noEmit', 'tsgo'], ['tsgo -p apps/web', 'tsgo'], ['npx tsrs --noEmit', 'tsrs'],
    ['bun test', 'bun-test'], ['bun test apps/x.test.ts', 'bun-test'],
    ['deno test supabase/functions', 'deno-test'], ['deno test --allow-all supabase/functions/x_test.ts', 'deno-test'],
    ['deno check supabase/functions/x/index.ts', 'deno-check'],
    ['pytest scripts/metrics', 'pytest'], ['python -m pytest -q', 'pytest'], ['python3 -m pytest scripts', 'pytest'],
    ['uv run pytest -q', 'pytest'], ['uv run --with pytest pytest scripts', 'pytest'], ['uv run python3 -m pytest', 'pytest'],
    ['npx vite build', 'vite-build'], ['vite build', 'vite-build'],
    ['npx expo export --platform web', 'expo-export'],
    ['semgrep scan --config p/ci', 'semgrep'], ['semgrep --config auto .', 'semgrep'],
    ['npm test', 'npm-test'], ['npm t', 'npm-test'], ['npm -w apps/web test', 'npm-test'], ['pnpm test', 'npm-test'],
    ['npm run test', 'npm-test'], ['npm run test:functions', 'npm-test'],
    ['bash scripts/dev/vitest-slot.sh apps/web/src/x.test.ts', 'vitest-slot'], ['scripts/dev/vitest-slot.sh a.test.ts b.test.ts -t name', 'vitest-slot'],
    ['./scripts/dev/vitest-slot.sh apps/web/src/x.test.ts', 'vitest-slot'], ['sh scripts/dev/vitest-slot.sh x.test.ts --reporter=dot', 'vitest-slot'],
    ['npm run verify:mobile', 'verify'], ['npm run check:design', 'check'], ['npm run check:functions', 'check'],
  ] as [string, string][]) {
    test(`${c} → buildbox · ${kind}`, async ($, on) => {
      world(on, WT)
      const out = await run($, c, sub)
      expect({ c, deny: out.deny, shipped: shipped(), ledger: seen.ledger[0] && { route: seen.ledger[0].route, kind: seen.ledger[0].kind } })
        .toEqual({ c, deny: undefined, shipped: true, ledger: { route: 'buildbox', kind } })
    })
  }

  test('不是重命令的照原样跑、不记账', async ($, on) => {
    world(on, WT)
    for (const c of ['npm run dev', 'bun run dev', 'deno fmt --check', 'python3 scripts/x.py', 'uv run ruff check', 'npx vite', 'npx expo start', 'npm run checkout']) {
      const out = await run($, c, sub)
      expect({ c, deny: out.deny, commands: seen.commands, ledger: seen.ledger }).toEqual({ c, deny: undefined, commands: [c], ledger: [] })
    }
  })
})

describe('devlight: MyApp 仓里原来放本机的结论改成拒', () => {
  for (const [c, reason, says, hasAlt] of [
    ['source .env.local && npx vitest run', 'deny-local:reads-env', '.env', false],
    ['node --env-file=.env.local --test scripts/x.test.mjs', 'deny-local:reads-env', '.env', false],
    ['DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run', 'deny-local:keep-local:127.0.0.1', '开发栈', false],
    ['npx supabase status && npx vitest run', 'deny-local:keep-local:supabase status', '开发栈', false],
    ["psql -c 'select 1' && npx vitest run", 'deny-local:keep-local:psql', '开发栈', false],
    ['SUPABASE_URL=http://localhost:54321 npx playwright test', 'deny-local:keep-local:localhost', '开发栈', false],
    ['npx vitest run clients/x.test.ts', 'deny-local:keep-local:clients/', 'clients/', false],
    ['npx playwright test --headed', 'deny-local:local-browser', '浏览器', true],
    ['npx vitest --ui', 'deny-local:local-browser', '浏览器', true],
    ['npx vitest watch', 'deny-local:interactive', 'vitest run', true],
    ['npx tsgo --watch', 'deny-local:interactive', '常驻', true],
    ['npm run test:watch', 'deny-local:interactive', '常驻', false],
    ['npx eslint --fix .', 'deny-local:writes-files', '--fetch', true],
    ['npx vitest run -u', 'deny-local:writes-files', '--fetch', true],
    ['bash scripts/dev/vitest-slot.sh x.test.ts -u', 'deny-local:writes-files', '--fetch', true],
    ['npx tsc --outDir dist', 'deny-local:writes-files', '--fetch', true],
    ['semgrep --config p/ci --autofix .', 'deny-local:writes-files', '--fetch', true],
  ] as [string, string, string, boolean][]) {
    for (const [who, ctx] of [['子 agent', sub], ['主会话', {}]] as const) test(`${c}(${who})→ deny · ${reason}`, async ($, on) => {
      world(on, WT)
      const out = await run($, c, ctx)
      expect({ c, commands: seen.commands, ledger: seen.ledger[0] && { route: seen.ledger[0].route, reason: seen.ledger[0].reason } })
        .toEqual({ c, commands: [], ledger: { route: 'deny', reason } })
      expect(out.deny ?? '').toContain(says)
      if (hasAlt) expect(out.deny ?? '').toContain(ALT)
      else expect(out.deny ?? '').not.toContain('remote-run.sh')
      expect(out.deny ?? '').not.toContain('LOCAL_RUN_ACK')
    })
  }

  test('拒绝信息里的替代命令再进钩子,照 explicit 放行', async ($, on) => {
    world(on, WT)
    const out = await run($, 'npx eslint --fix .', sub)
    const alt = (out.deny ?? '').slice((out.deny ?? '').indexOf(ALT))
    expect(alt).toContain('npx eslint')
    expect(alt).not.toContain('--fix')
    const again = await run($, alt, sub)
    expect({ deny: again.deny, ledger: seen.ledger[0]?.reason }).toEqual({ deny: undefined, ledger: 'explicit' })
  })

  test('会话在子目录:替代命令回仓顶、包进 bash -c 先 cd 回子目录;再进钩子照 explicit 放行', async ($, on) => {
    world(on, WT_WEB)
    const out = await run($, 'npx eslint --fix .', sub)
    const alt = `${ALT}bash -c 'cd apps/web && npx eslint .'`
    expect(out.deny ?? '').toContain(alt)
    const again = await run($, alt, sub)
    expect({ deny: again.deny, ledger: seen.ledger[0] && { route: seen.ledger[0].route, reason: seen.ledger[0].reason, kind: seen.ledger[0].kind } })
      .toEqual({ deny: undefined, ledger: { route: 'buildbox', reason: 'explicit', kind: 'eslint' } })
  })

  test('子 agent 带 LOCAL_RUN_ACK 不认,写文件的照拒', async ($, on) => {
    world(on, WT)
    const out = await run($, "LOCAL_RUN_ACK='想本机' npx eslint --fix .", sub)
    expect(out.deny ?? '').toContain('--fetch')
    expect(seen.ledger[0]).toMatchObject({ route: 'deny', reason: 'deny-local:writes-files' })
  })
})

describe('devlight: 例外照旧放本机', () => {
  for (const [c, reason] of [
    ['cd ~/repos/myapp-release && npm run build', 'keep-local:myapp-release'],
    ['node --test scripts/deploy/money-gate.test.mjs', 'keep-local:money-gate'],
    ['node --test scripts/deploy/migration-gate.test.mjs', 'keep-local:migration-gate'],
    ['node --test scripts/deploy/vps-web.test.mjs', 'keep-local:vps-web'],
    ['node --test scripts/deploy/ota.sh.test.mjs', 'keep-local:ota.sh'],
    ['node --test scripts/deploy/layout-gate.test.mjs', 'keep-local:layout-gate'],
    ['node --test scripts/ops/shared-stack-ab.test.mjs', 'keep-local:shared-stack-ab'],
    ['node --test scripts/deploy/release-gates.test.mjs', 'keep-local:release-gates'],
    ['node --test scripts/release/x.test.mjs', 'keep-local:scripts/release/'],
    ['node --test --test-reporter-destination=out.txt scripts/deploy/money-gate.test.mjs', 'keep-local:money-gate'],
    ['DATABASE_URL=postgres://127.0.0.1:54322/x node --test scripts/deploy/migration-gate.test.mjs', 'keep-local:migration-gate'],
    ["bash -c 'bash scripts/dev/gate-stamp.sh agent/x && npm run typecheck'", 'keep-local:gate-stamp'],
    ['./scripts/dev/merge-queue.sh agent/x "t" && npm run typecheck', 'keep-local:merge-queue'],
    ['cd ~/repos/myapp-release/apps/web && npx tsc --noEmit', 'keep-local:myapp-release'],
    ['bash scripts/dev/gate-stamp.sh agent/x && npm run typecheck', 'keep-local:gate-stamp'],
    ['DELEGATE_GATE_LANE=merge bash scripts/dev/gate-slice.sh main', 'keep-local:DELEGATE_GATE_LANE=merge'],
    ['env DELEGATE_GATE_LANE=merge npm run typecheck', 'keep-local:DELEGATE_GATE_LANE=merge'],
    ['npx vitest run && bash scripts/dev/merge-queue.sh agent/x "t"', 'keep-local:merge-queue'],
  ] as [string, string][]) {
    test(`${c} → local · ${reason}`, async ($, on) => {
      world(on, WT)
      const out = await run($, c, sub)
      expect({ c, deny: out.deny, commands: seen.commands, ledger: seen.ledger[0] && { route: seen.ledger[0].route, reason: seen.ledger[0].reason } })
        .toEqual({ c, deny: undefined, commands: [c], ledger: { route: 'local', reason } })
    })
  }

  test('打戳 lane 不是 merge 的不算例外', async ($, on) => {
    world(on, WT)
    await run($, 'DELEGATE_GATE_LANE=slice npm run typecheck', sub)
    expect(shipped()).toBe(true)
  })

  for (const c of ['npx vitest run', 'npx eslint --fix .', 'source .env.local && npx vitest run', 'npx vitest watch']) {
    test(`执行体沙箱:${c} → local · executor-sandbox`, async ($, on) => {
      world(on, WT, { SANDBOX_ARM: 'pi' })
      const out = await run($, c, sub)
      expect({ deny: out.deny, commands: seen.commands, reason: seen.ledger[0]?.reason }).toEqual({ deny: undefined, commands: [c], reason: 'executor-sandbox' })
    })
  }

  for (const [cwd, c, reason] of [
    [CM, 'npx vitest run', 'claude-mods-not-on-buildbox'],
    [CM, 'npx eslint --fix .', 'writes-files'],
    [CM, 'source .env && npx vitest run', 'reads-env'],
    [CM, 'npx vitest watch', 'interactive'],
    [CM, "psql -c 'select 1' && npx vitest run", 'keep-local:psql'],
    [PIW, 'node --test test/x.test.mjs', 'piw-not-on-buildbox'],
    [NOREPO, 'npx tsc --noEmit', 'no-repo'],
    [NOREPO, 'npx eslint --fix .', 'writes-files'],
  ] as [string, string, string][]) {
    test(`非 MyApp 仓只记不停:${cwd} ${c} → local · ${reason}`, async ($, on) => {
      world(on, cwd)
      const out = await run($, c, sub)
      expect({ deny: out.deny, commands: seen.commands, ledger: seen.ledger[0] && { route: seen.ledger[0].route, reason: seen.ledger[0].reason } })
        .toEqual({ deny: undefined, commands: [c], ledger: { route: 'local', reason } })
    })
  }

  for (const c of ["LOCAL_RUN_ACK='发版' npx eslint --fix .", "LOCAL_RUN_ACK='连本机栈' DATABASE_URL=postgres://127.0.0.1:54322/x npx vitest run", "LOCAL_RUN_ACK='看界面' npx playwright test --headed"]) {
    test(`主会话 ack:${c} → ack`, async ($, on) => {
      world(on, WT)
      const out = await run($, c)
      expect({ deny: out.deny, commands: seen.commands, route: seen.ledger[0]?.route }).toEqual({ deny: undefined, commands: [c], route: 'ack' })
    })
  }
})

// 2.11 heavy-route.jsonl 的每类(route · reason)各取一条代表命令:改后不变的都不变。
describe('devlight: 今天账本的分布', () => {
  for (const [cwd, c, ctx, route, reason] of [
    [WT, 'node --test scripts/x.test.mjs', sub, 'buildbox', 'rewrite'],
    [WT, 'npx eslint apps/web', sub, 'buildbox', 'rewrite'],
    [WT, 'npm run typecheck', sub, 'buildbox', 'rewrite'],
    [WT, 'bash scripts/dev/gate-slice.sh main', sub, 'buildbox', 'rewrite'],
    [WT, 'npx vitest run x.test.ts', sub, 'buildbox', 'rewrite'],
    [WT, `${ALT}bash scripts/dev/gate-slice.sh main`, sub, 'buildbox', 'explicit'],
    [WT, "LOCAL_RUN_ACK='x' node --test scripts/x.test.mjs", sub, 'buildbox', 'rewrite-subagent-ack-ignored'],
    [WT, "LOCAL_RUN_ACK='本机 docker 与定时器锁' node --test scripts/x.test.mjs", {}, 'ack', '本机 docker 与定时器锁'],
    [WT, 'cd ~/repos/myapp-release && node --test scripts/x.test.mjs', sub, 'local', 'keep-local:myapp-release'],
    [PIW, 'node --test test/x.test.mjs', sub, 'local', 'piw-not-on-buildbox'],
    [CM, 'node --test factory/x.test.mjs', sub, 'local', 'claude-mods-not-on-buildbox'],
    [NOREPO, 'node --test x.test.mjs', sub, 'local', 'no-repo'],
    [NOREPO, 'npx eslint .', sub, 'local', 'no-repo'],
    [WT, 'node --test $(ls scripts/*.test.mjs)', sub, 'deny', 'mixed:$(…)'],
    [WT, 'node --test scripts/x.test.mjs > out.txt', sub, 'deny', 'mixed:>'],
    [WT, 'npx eslint . && git commit -am x', sub, 'deny', 'mixed:git'],
  ] as [string, string, object, string, string][]) {
    test(`${route} · ${reason}:${c}`, async ($, on) => {
      world(on, cwd)
      await run($, c, ctx)
      expect({ c, route: seen.ledger[0]?.route, reason: seen.ledger[0]?.reason }).toEqual({ c, route, reason })
    })
  }
})

// DeepSeek 审 e08522d P1:拒绝信息里的替代命令不能是原命令原样包进 remote-run。
describe('devlight P1: 替代命令能用', () => {
  const altOf = (deny: string | undefined): string => (deny ?? '').slice((deny ?? '').indexOf(ALT) + ALT.length)
  for (const [c, want, notWant] of [
    ['npx vitest watch', 'npx vitest run', /vitest watch/],
    ['npx vitest --watch', 'npx vitest run', /--watch/],
    ['npx vitest --ui', 'npx vitest run', /--ui/],
    ['npx tsgo --watch', 'npx tsgo', /--watch/],
    ['npx eslint --fix .', 'npx eslint .', /--fix/],
    ['npx vitest run -u', 'npx vitest run', /-u\b/],
    ['npx vitest run --update=true x.test.ts', 'npx vitest run x.test.ts', /--update/],
    ['npx tsc --outDir dist -p apps/web', 'npx tsc -p apps/web', /outDir|dist/],
    ['npx playwright test --headed', 'npx playwright test', /--headed/],
    ['PWDEBUG=1 npx playwright test', 'npx playwright test', /PWDEBUG/],
    ["LOCAL_RUN_ACK='想本机' npx eslint --fix .", 'npx eslint .', /--fix|LOCAL_RUN_ACK/],
  ] as [string, string, RegExp][]) {
    test(`替代命令:${c}`, async ($, on) => {
      world(on, WT)
      const out = await run($, c, sub)
      const alt = altOf(out.deny)
      expect({ c, alt: alt.includes(want) }).toEqual({ c, alt: true })
      expect({ c, bad: notWant.test(alt) }).toEqual({ c, bad: false })
      const again = await run($, ALT + alt, sub)
      expect({ c, deny: again.deny, reason: seen.ledger[0]?.reason }).toEqual({ c, deny: undefined, reason: 'explicit' })
    })
  }

  for (const c of ['npx vitest run clients/x.test.ts', 'source .env.local && npx vitest run', 'node --env-file=.env.local --test scripts/x.test.mjs', 'npx vitest run --reporter=json .env.test']) {
    test(`不给替代命令:${c}`, async ($, on) => {
      world(on, WT)
      const out = await run($, c, sub)
      expect({ c, deny: out.deny !== undefined, hasAlt: (out.deny ?? '').includes('remote-run.sh') }).toEqual({ c, deny: true, hasAlt: false })
    })
  }
})

// DeepSeek 审 e08522d P2:发版 / 打戳例外只认被跑的那条脚本本身,不扫整行。
describe('devlight P2: 例外不按整行子串认', () => {
  for (const [c, kind] of [
    ['node --test scripts/dev/merge-queue.test.mjs', 'node-test'],
    ['npx vitest run -t gate-stamp', 'vitest'],
    ['npx vitest run apps/web/src/deploy/layout-gate-utils.test.ts', 'vitest'],
    ['npx vitest run --reporter=dot scripts/deploy/vps-web.test.ts', 'vitest'],
  ] as [string, string][]) {
    test(`${c} → buildbox · ${kind}`, async ($, on) => {
      world(on, WT)
      const out = await run($, c, sub)
      expect({ c, deny: out.deny, shipped: shipped(), ledger: seen.ledger[0] && { route: seen.ledger[0].route, reason: seen.ledger[0].reason, kind: seen.ledger[0].kind } })
        .toEqual({ c, deny: undefined, shipped: true, ledger: { route: 'buildbox', reason: 'rewrite', kind } })
    })
  }
})

// DeepSeek 审 e08522d P3:会话 cwd 已经在发布目录,命令里不必写 myapp-release。
describe('devlight P3: 发布目录按 cwd 认', () => {
  for (const c of ['npm run build', 'npm run test:money-gate', 'npx vitest run']) {
    test(`cwd 在 myapp-release:${c} → local · keep-local:myapp-release`, async ($, on) => {
      world(on, RELEASE)
      const out = await run($, c, sub)
      expect({ c, deny: out.deny, shipped: shipped(), commands: seen.commands, reason: String(seen.ledger[0]?.reason).slice(0, 24) })
        .toEqual({ c, deny: undefined, shipped: false, commands: [c], reason: 'keep-local:myapp-release' })
    })
  }
})

// DeepSeek 审 e08522d P2:READS_ENV / KEEP_LOCAL 只认真正读 .env / 连栈的写法,参数里的词不算。
describe('devlight P2: 读 .env / 连栈的判法收窄', () => {
  for (const c of [
    'npx vitest run apps/web/src/lib/dotenv.test.ts', 'npx vitest run -t localhost', 'npx vitest run --reporter=verbose src/host.test.ts',
    'npx vitest run -t 127.0.0.1', 'npx vitest run src/psql-format.test.ts', 'npx vitest run src/lib/clients-list.test.ts',
    'npx vitest run -t "supabase status"', 'npx vitest run packages/domain/src/envelope.test.ts',
  ]) {
    test(`送 build box 不拒:${c}`, async ($, on) => {
      world(on, WT)
      const out = await run($, c, sub)
      expect({ c, deny: out.deny, shipped: shipped(), ledger: seen.ledger[0] && { route: seen.ledger[0].route, kind: seen.ledger[0].kind } })
        .toEqual({ c, deny: undefined, shipped: true, ledger: { route: 'buildbox', kind: 'vitest' } })
    })
  }

  for (const [c, reason] of [
    ['npx vitest run --setupFiles dotenv/config', 'deny-local:reads-env'],
    ['dotenv -e x -- true; npx vitest run', 'deny-local:reads-env'],
    ['cat apps/web/.env.local | head -1; npx vitest run', 'deny-local:reads-env'],
    ['set -a; . ./.env.local; set +a; npx vitest run', 'deny-local:reads-env'],
    ["bash -c 'source .env && npx vitest run'", 'deny-local:reads-env'],
    ['BASE_URL=localhost:3000 npx playwright test', 'deny-local:keep-local:localhost'],
    ['npx playwright test --base-url http://127.0.0.1:3000', 'deny-local:keep-local:127.0.0.1'],
    ['npx playwright test --base-url=http://localhost:3000', 'deny-local:keep-local:localhost'],
    ['PGURL=postgres://db:54322/x npx vitest run', 'deny-local:keep-local::54322'],
    ['npx supabase@2.119.0 functions serve & npx vitest run', 'deny-local:keep-local:supabase@2.119.0 functions serve'],
    ['docker exec db psql -c x && npx vitest run', 'deny-local:keep-local:psql'],
    ['npx vitest run ./clients/x/roster.test.ts', 'deny-local:keep-local:clients/'],
  ] as [string, string][]) {
    test(`仍拒:${c}`, async ($, on) => {
      world(on, WT)
      await run($, c, sub)
      expect({ c, commands: seen.commands, ledger: seen.ledger[0] && { route: seen.ledger[0].route, reason: seen.ledger[0].reason } })
        .toEqual({ c, commands: [], ledger: { route: 'deny', reason } })
    })
  }

  test('文案回显命中串(P3)', async ($, on) => {
    world(on, WT)
    const out = await run($, 'API=http://host:54321 npx vitest run', sub)
    expect(out.deny ?? '').toContain(':54321')
  })
})

// DeepSeek 审 e08522d P2:认不出的包装 —— bun run · pnpm/yarn <bin> · sudo/doas。P3:旗标的取值当子命令。
describe('devlight P2: 包装与前缀', () => {
  for (const [c, kind] of [
    ['bun run typecheck', 'tsc'], ['bun run test', 'npm-test'], ['bun run lint', 'eslint'], ['bun run test:functions', 'npm-test'],
    ['bun --cwd apps/web run typecheck', 'tsc'], ['bun run verify:mobile', 'verify'],
    ['pnpm vitest run', 'vitest'], ['yarn vitest run', 'vitest'], ['pnpm tsc --noEmit', 'tsc'], ['yarn playwright test', 'playwright'],
    ['vite --config vite.prod.ts build', 'vite-build'], ['npx vite -c vite.prod.ts build', 'vite-build'], ['python -X dev -m pytest -q', 'pytest'],
    ['python3 -W ignore -m pytest scripts', 'pytest'], ['next --turbo build', 'build'],
  ] as [string, string][]) {
    test(`${c} → buildbox · ${kind}`, async ($, on) => {
      world(on, WT)
      const out = await run($, c, sub)
      expect({ c, deny: out.deny, shipped: shipped(), ledger: seen.ledger[0] && { route: seen.ledger[0].route, kind: seen.ledger[0].kind } })
        .toEqual({ c, deny: undefined, shipped: true, ledger: { route: 'buildbox', kind } })
    })
  }

  for (const c of ['sudo npx vitest run', 'sudo -u owner npm run typecheck', 'doas npx tsc --noEmit', 'sudo -E bun test']) {
    test(`提权前缀:${c} → deny · mixed:sudo/doas,写一行账`, async ($, on) => {
      world(on, WT)
      const out = await run($, c, sub)
      expect({ c, commands: seen.commands, ledger: seen.ledger[0] && { route: seen.ledger[0].route, reason: String(seen.ledger[0].reason).slice(0, 6) } })
        .toEqual({ c, commands: [], ledger: { route: 'deny', reason: 'mixed:' } })
      expect(out.deny ?? '').toMatch(/sudo|doas/)
    })
  }

  test('不是重命令的包装照原样跑、不记账', async ($, on) => {
    world(on, WT)
    for (const c of ['bun run dev', 'bun install', 'bun add vitest', 'pnpm install', 'pnpm dev', 'yarn add vitest', 'sudo apt-get update', 'bun --version']) {
      const out = await run($, c, sub)
      expect({ c, deny: out.deny, commands: seen.commands, ledger: seen.ledger }).toEqual({ c, deny: undefined, commands: [c], ledger: [] })
    }
  })
})

// DeepSeek 审 e08522d P3:替代命令里本机仓顶换成仓内相对路径。
describe('devlight P3: 替代命令不带本机仓顶', () => {
  test('cd <仓顶>/apps/web && …:替代命令里只剩 cd apps/web', async ($, on) => {
    world(on, WT)
    const out = await run($, `cd ${WT}/apps/web && npx eslint --fix .`, sub)
    const alt = (out.deny ?? '').slice((out.deny ?? '').indexOf(' -- ') + 4)
    expect(alt).not.toContain(WT)
    expect(alt).toContain('cd apps/web')
    const again = await run($, (out.deny ?? '').slice((out.deny ?? '').indexOf(ALT)), sub)
    expect({ deny: again.deny, reason: seen.ledger[0]?.reason }).toEqual({ deny: undefined, reason: 'explicit' })
  })
})
