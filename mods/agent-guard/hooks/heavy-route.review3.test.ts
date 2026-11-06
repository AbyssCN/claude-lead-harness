import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { itxCommand, routeSteps, TOP_MARK, writesRedirect } from './heavy-route'
import { shellCommands } from './rules'

const MAIN = '/r/myapp'
const WT = '/r/myapp-wt'
const LEDGER = '/home/t/.omd-lite/readings/heavy-route.jsonl'
const seen: { commands: string[]; ledger: Record<string, unknown>[] } = { commands: [], ledger: [] }

function world(on: On): void {
  seen.commands = []
  seen.ledger = []
  mock.env(on, { HOME: '/home/t' })
  on('session.cwd', () => ({ value: WT }))
  on('fs.stat', (_, e) => {
    if (![MAIN, WT, '/r'].includes(e.path)) throw new Error(`ENOENT ${e.path}`)
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
      return dir === WT ? done(0, `${WT}\n${MAIN}/.git\n`) : done(128, '')
    }
    if (dir === MAIN) return done(0, `${MAIN}/.git`)
    if (dir === WT) return done(0, argv[argv.length - 1] === '--git-dir' ? `${MAIN}/.git/worktrees/wt` : `${MAIN}/.git`)
    return done(128, '')
  })
  on('tool.call', { tool: 'Bash' }, (_, e) => (seen.commands.push(String(e.command)), { result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
}

const local = (c: string) => routeSteps(c).find(s => s.local)?.local ?? null
const payload = (c: string, rel = '') => shellCommands(itxCommand(c, WT, rel))[1]?.at(-1)

// This file value-imports the reviewed rules and also exercises the installed Bash hook.
describe('review3: previous findings and routing regressions', () => {
  test('F1 original and equals/positional variants stay local', () => {
    for (const c of [
      'npx playwright test --update-snapshots=all',
      'npx playwright test --update-snapshots=changed',
      'npx playwright test e2e/x.spec.ts -u=all',
      'npx vitest run x.test.ts --update=all',
      'npx eslint src --fix=true',
      "bash -c 'npx playwright test --update-snapshots=all'",
      "bash -c 'export UPDATE_SNAPSHOT=all; npx vitest run'",
      'UPDATE_SNAPSHOT=all npx vitest run',
      'env UPDATE_SNAPSHOT=all npx vitest run',
      'export UPDATE_SNAPSHOT=all; npx vitest run',
    ]) expect({ c, local: local(c) }).toEqual({ c, local: 'writes-files' })
  })

  test('F5 original and environment/shell variants stay local', () => {
    for (const c of [
      'npx vitest --ui', 'npx vitest run x.test.ts --ui=true',
      'npx playwright test --ui-port=0', 'npx playwright test --ui-host=0.0.0.0',
      'PWDEBUG=1 npx playwright test', 'env PWDEBUG=1 npx playwright test',
      'export PWDEBUG=1; npx playwright test',
      "bash -c 'PWDEBUG=1 npx playwright test'",
      "bash -c 'env PWDEBUG=1 npx playwright test'",
      "bash -c 'export PWDEBUG=1; npx playwright test'",
    ]) expect({ c, local: local(c) }).toEqual({ c, local: 'local-browser' })
  })

  test('ordinary arguments and heavy command pipelines still ship', async ($, on) => {
    world(on)
    for (const c of [
      'npx vitest run', 'npm run typecheck', 'npx vitest run 2>&1 | tail -30',
      'npx vitest run src/watch.test.ts -t update', 'npx vitest run --testNamePattern=-word',
      'npx -y vitest run', 'npm -w apps/web run lint',
      'npx playwright test --update-snapshots=none', 'npx eslint . --fix=false',
    ]) {
      seen.commands = []
      const result = await $.tool.call({ tool: 'Bash', command: c, agentId: 'a1' })
      expect(result.deny).toBeUndefined()
      expect({ c, shipped: seen.commands.some(x => x.includes('remote-run.sh')) }).toEqual({ c, shipped: true })
    }
    expect(writesRedirect('npx vitest run 2>&1 | tail -30')).toBe(false)
  })

  test('top-level CI and HTML assignments including empty/0 are preserved', () => {
    for (const c of [
      'CI=0 PLAYWRIGHT_HTML_OPEN=never npx vitest run',
      'CI= PLAYWRIGHT_HTML_OPEN= npx vitest run',
      'env CI=0 PLAYWRIGHT_HTML_OPEN=never npx playwright test',
      'export CI=0 PLAYWRIGHT_HTML_OPEN=; npx vitest run',
    ]) expect({ c, inner: payload(c) }).toEqual({ c, inner: c })
  })

  test('injection precedes remote subdirectory cd in the same eval payload', () => {
    const c = "cd '/r/myapp-wt/apps/web' && npx vitest run -t 'a && b' 2>&1 | tail -30"
    expect(payload(c, 'apps')).toBe(`export CI=1 PLAYWRIGHT_HTML_OPEN=never; cd ${TOP_MARK}/apps && cd '${TOP_MARK}/apps/web' && npx vitest run -t 'a && b' 2>&1 | tail -30`)
  })
})

describe('review3: counterexamples', () => {
  for (const c of [
    'npx eslint . --output-file=false',
    'npx playwright test --output=false',
    'node --test --test-reporter=spec --test-reporter-destination=false x.test.mjs',
  ]) {
    test(`R3-F1 path named false must not ship: ${c}`, async ($, on) => {
      world(on)
      const result = await $.tool.call({ tool: 'Bash', command: c, agentId: 'a1' })
      expect(result.deny).toContain('写文件')
      expect({ c, shipped: seen.commands.some(x => x.includes('remote-run.sh')) }).toEqual({ c, shipped: false })
    })
  }

  for (const c of [
    "bash -c 'export CI=0 PLAYWRIGHT_HTML_OPEN=never; npx vitest run'",
    "bash -c 'env CI= PLAYWRIGHT_HTML_OPEN= npx vitest run'",
    "bash -c 'CI=0 PLAYWRIGHT_HTML_OPEN=never npx playwright test'",
  ]) {
    test(`R3-F2 explicit nested assignments must suppress injection: ${c}`, () => {
      expect({ c, inner: payload(c) }).toEqual({ c, inner: c })
    })
  }
})
