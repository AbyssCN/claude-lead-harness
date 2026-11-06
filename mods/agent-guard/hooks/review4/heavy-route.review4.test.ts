import { describe, expect, test } from 'claude-code/testing'

import { assignments, itxCommand, routeSteps, writesRedirect } from '../heavy-route'
import { shellCommands } from '../rules'

const local = (c: string): string | null => routeSteps(c).find(s => s.local)?.local ?? null
const payload = (c: string): string | undefined => shellCommands(itxCommand(c, '/r/myapp-wt', ''))[1]?.at(-1)
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

function checkLocal(c: string, reason: string | null): void {
  const steps = routeSteps(c)
  expect({ c, recognized: steps.some(s => s.kinds.length > 0), local: local(c) }).toEqual({ c, recognized: true, local: reason })
}

describe('review4: R3-F1 valued and boolean contracts', () => {
  test('R3-F1 original three counterexamples now stay local', () => {
    for (const c of [
      'npx eslint . --output-file=false',
      'npx playwright test --output=false',
      'node --test --test-reporter=spec --test-reporter-destination=false x.test.mjs',
    ]) checkLocal(c, 'writes-files')
  })

  // Keep each valued case independent: one counterexample must not hide the remaining rows.
  for (const [tool, names, reason] of [
    ['npx vitest run', ['--outputFile', '--output-file', '--attachmentsDir', '--coverage.reportsDirectory', '--cacheDirectory'], 'writes-files'],
    ['npx playwright test', ['--output', '--last-failed-file', '--update-source-method'], 'writes-files'],
    ['npx playwright test', ['--ui-port', '--ui-host'], 'local-browser'],
    ['npx eslint .', ['--output-file', '--cache-location'], 'writes-files'],
    ['npx tsc', ['--outDir', '--outFile', '--out', '--declarationDir', '--tsBuildInfoFile', '--generateTrace', '--generateCpuProfile'], 'writes-files'],
    ['node --test x.test.mjs', ['--test-reporter-destination', '--cpu-prof-dir', '--cpu-prof-name', '--heap-prof-dir', '--heap-prof-name', '--diagnostic-dir', '--redirect-warnings', '--report-directory', '--report-filename'], 'writes-files'],
    ['node --test x.test.mjs', ['--watch-path', '--inspect-port'], 'interactive'],
  ] as [string, string[], string][]) {
    for (const name of names) {
      for (const suffix of ['=false', ' false', '=', '=False', '=FALSE', '=0']) {
        const c = `${tool} ${name}${suffix}`
        test(`valued: ${c}`, () => checkLocal(c, reason))
      }
      const c = `${tool} --no-${name.slice(2)}`
      test(`valued: ${c}`, () => checkLocal(c, reason))
    }
  }

  test('short -o and stdout remain valued, including single-dash tsc', () => {
    for (const flag of ['-o false', '-o=false', '-o=', '-o false src']) checkLocal(`npx eslint . ${flag}`, 'writes-files')
    checkLocal('node --test --test-reporter-destination=stdout x.test.mjs', 'writes-files')
    checkLocal('tsc -outDir false', 'writes-files')
  })

  test('boolean false/no disable; False/FALSE/0/empty remain enabled', () => {
    for (const [tool, flag, reason] of [
      ['npx vitest run', '--update', 'writes-files'],
      ['npx vitest run', '--coverage', 'writes-files'],
      ['npx vitest run', '--ui', 'local-browser'],
      ['npx vitest run', '--watch', 'interactive'],
      ['npx playwright test', '--update-snapshots', 'writes-files'],
      ['npx playwright test', '--headed', 'local-browser'],
      ['npx eslint .', '--fix', 'writes-files'],
      ['npx tsc', '--incremental', 'writes-files'],
      ['node --test x.test.mjs', '--test-update-snapshots', 'writes-files'],
    ] as [string, string, string][]) {
      checkLocal(`${tool} ${flag}=false`, null)
      checkLocal(`${tool} --no-${flag.slice(2)}`, null)
      for (const v of ['False', 'FALSE', '0', '']) checkLocal(`${tool} ${flag}=${v}`, reason)
    }
    checkLocal('npx vitest run -u=false', null)
    checkLocal('npx vitest run -u=FALSE', 'writes-files')
  })
})

describe('review4: R3-F2 shell assignments', () => {
  test('R3-F2 original three counterexamples suppress both defaults', () => {
    for (const c of [
      "bash -c 'export CI=0 PLAYWRIGHT_HTML_OPEN=never; npx vitest run'",
      "bash -c 'env CI= PLAYWRIGHT_HTML_OPEN= npx vitest run'",
      "bash -c 'CI=0 PLAYWRIGHT_HTML_OPEN=never npx playwright test'",
    ]) expect({ c, inner: payload(c) }).toEqual({ c, inner: c })
  })

  test('bash -c / bash -lc / sh -c, both quotes and env/export/direct assignment', () => {
    for (const shell of ['bash -c', 'bash -lc', 'sh -c']) {
      for (const q of ["'", '"']) {
        for (const prefix of ['CI=0 PLAYWRIGHT_HTML_OPEN=never ', 'env CI= PLAYWRIGHT_HTML_OPEN= ', 'export CI=0 PLAYWRIGHT_HTML_OPEN=never; ']) {
          const c = `${shell} ${q}${prefix}npx vitest run${q}`
          checkLocal(c, null)
          expect({ c, inner: payload(c) }).toEqual({ c, inner: c })
        }
      }
    }
  })

  test('each nested user assignment suppresses only its own default', () => {
    for (const [script, added] of [
      ['CI=0 npx vitest run', 'PLAYWRIGHT_HTML_OPEN=never'],
      ['env CI= npx vitest run', 'PLAYWRIGHT_HTML_OPEN=never'],
      ['export PLAYWRIGHT_HTML_OPEN=never; npx vitest run', 'CI=1'],
    ] as [string, string][]) {
      const c = `bash -lc ${quote(`sh -c ${quote(script)}`)}`
      expect({ c, inner: payload(c) }).toEqual({ c, inner: `export ${added}; ${c}` })
    }
  })

  test('nested scripts beginning with assignments are not one bogus assignment value', () => {
    const c = `bash -c ${quote('CI=0 PLAYWRIGHT_HTML_OPEN=never npx vitest run')}`
    expect(assignments(c)).toEqual([['CI', '0'], ['PLAYWRIGHT_HTML_OPEN', 'never']])
    for (const [script, reason] of [
      ['env PWDEBUG=1 npx playwright test', 'local-browser'],
      ['export UPDATE_SNAPSHOT=all; npx vitest run', 'writes-files'],
      ['PLAYWRIGHT_HTML_OUTPUT_DIR=false npx playwright test', 'writes-files'],
    ] as [string, string][]) checkLocal(`bash -c ${quote(script)}`, reason)
  })
})

describe('review4: ordinary commands and parser limits', () => {
  test('ordinary arguments, typecheck, node test and output pipelines remain routable', () => {
    for (const c of [
      'npx vitest run some-file', 'npx vitest run -t "output"',
      'npm run typecheck', 'node --test x.test.mjs',
      'npx vitest run 2>&1 | tail -30', 'npx eslint . 2>&1 | tail -30',
      'npx playwright test', 'npx next build',
    ]) {
      checkLocal(c, null)
      expect({ c, foreign: routeSteps(c).flatMap(s => s.foreign), redirect: writesRedirect(c) }).toEqual({ c, foreign: [], redirect: false })
      expect(payload(c)).toBe(`export CI=1 PLAYWRIGHT_HTML_OPEN=never; ${c}`)
    }
  })

  test('unmatched quotes terminate without crashing; invalid shell syntax has no success oracle', () => {
    for (const c of ["bash -c 'CI=0 npx vitest run", 'sh -c "export CI=; npx vitest run', "bash -c 'export CI=0; npx vitest run \""]) {
      expect(Array.isArray(assignments(c))).toBe(true)
      expect(Array.isArray(routeSteps(c))).toBe(true)
      expect(typeof itxCommand(c, '/r/myapp-wt', '')).toBe('string')
    }
  })

  test('100k script and 12 nested shells preserve assignments without a recursion exception', () => {
    const longScript = `export CI=0 PLAYWRIGHT_HTML_OPEN=never; npx vitest run -t ${quote('x'.repeat(100_000))}`
    const long = `bash -c ${quote(longScript)}`
    checkLocal(long, null)
    expect(payload(long)).toBe(long)
    let nested = 'env CI=0 PLAYWRIGHT_HTML_OPEN=never npx vitest run'
    for (let i = 0; i < 12; i++) nested = `bash -c ${quote(nested)}`
    checkLocal(nested, null)
    expect(assignments(nested)).toEqual([['CI', '0'], ['PLAYWRIGHT_HTML_OPEN', 'never']])
    expect(payload(nested)).toBe(nested)
  })
})
