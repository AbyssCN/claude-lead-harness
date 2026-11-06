// 类表:写入类与交互 / 调试类在各工具里的每种写法,一行一条。每条在 4e2e69c 上至少有一种写法红。
import { describe, expect, test } from 'claude-code/testing'

import { itxCommand, routeSteps } from './heavy-route'
import { shellCommands } from './rules'

const W = 'writes-files'
const B = 'local-browser'
const I = 'interactive'

// 这条命令里命中白名单的那段留本机的理由;送 build box 是 null。
const local = (c: string): string | null => routeSteps(c).find(s => s.local)?.local ?? null
const kinds = (c: string): string[] => routeSteps(c).flatMap(s => s.kinds)

function row(reason: string, cases: string[]): void {
  for (const c of cases) {
    expect(kinds(c).length > 0).toBe(true)
    expect({ c, local: local(c) }).toEqual({ c, local: reason })
  }
}

describe('写入类:改本机文件的留本机', () => {
  test('vitest 快照更新:-u · -u=值 · --update · --update=值 · --update 值 · 短名簇', () => {
    row(W, [
      'npx vitest run -u', 'npx vitest run -u=all', 'npx vitest run -u=new', 'npx vitest run --update',
      'npx vitest run --update=all', 'npx vitest run --update all', 'npx vitest run -ru', 'vitest run --update-snapshot',
    ])
  })

  test('vitest 报告 / 覆盖率写到文件:--outputFile(含点号子项)· --coverage · --attachmentsDir', () => {
    row(W, [
      'npx vitest run --reporter=json --outputFile=r.json', 'npx vitest run --reporter=json --outputFile r.json',
      'npx vitest run --outputFile.junit=j.xml', 'npx vitest run --output-file=r.json', 'npx vitest run --coverage',
      'npx vitest run --coverage.enabled', 'npx vitest run --attachmentsDir=att',
    ])
  })

  test('playwright 快照更新:-u · -u=值 · --update-snapshots(=值 / 空格值 / 驼峰)· --update-source-method', () => {
    row(W, [
      'npx playwright test -u', 'npx playwright test -u=all', 'npx playwright test --update-snapshots',
      'npx playwright test --update-snapshots=all', 'npx playwright test --update-snapshots=changed',
      'npx playwright test --update-snapshots missing', 'npx playwright test --updateSnapshots=all',
      'npx playwright test -xu', 'npx playwright test --update-source-method=overwrite',
    ])
  })

  test('playwright 产物目录:--output=目录 · --output 目录', () => {
    row(W, ['npx playwright test --output=out', 'npx playwright test --output out'])
  })

  test('eslint:--fix(=值)· -o · --output-file(=值 / 空格值 / 驼峰)', () => {
    row(W, [
      'npx eslint --fix .', 'npx eslint . --fix=true', 'npx eslint -o r.txt .', 'npx eslint -o=r.txt .',
      'npx eslint --output-file=r.json .', 'npx eslint --output-file r.json .', 'npx eslint --outputFile r.json .',
    ])
  })

  test('tsc 产物:--build / -b / -build · --outDir · --outFile · -d / --declaration* · --incremental · --tsBuildInfoFile · --init · --generateTrace', () => {
    row(W, [
      'npx tsc --build', 'npx tsc -b', 'tsc -build', 'npx tsc --outDir dist', 'npx tsc --outDir=dist', 'tsc -outDir dist',
      'npx tsc --outFile out.js', 'npx tsc -d', 'npx tsc --declaration', 'npx tsc --declarationDir types',
      'npx tsc --emitDeclarationOnly', 'npx tsc --incremental', 'npx tsc --tsBuildInfoFile x.tsbuildinfo',
      'npx tsc --init', 'npx tsc --generateTrace trace', 'npx tsc --generateCpuProfile p.cpuprofile',
    ])
  })

  test('node --test:--test-update-snapshots · --test-reporter-destination 写文件 · --cpu-prof / --heap-prof / --prof', () => {
    row(W, [
      'node --test --test-update-snapshots x.test.mjs', 'node --test --test-reporter-destination=out.txt x.test.mjs',
      'node --test --test-reporter-destination out.txt x.test.mjs', 'node --cpu-prof --test x.test.mjs',
      'node --heap-prof --test x.test.mjs', 'node --prof --test x.test.mjs',
    ])
  })

  test('npm 脚本:名字以 fix / format / write 结尾 · -- 后面带写入旗标', () => {
    row(W, [
      'npm run lint:fix', 'npm run lint:write', 'npm run lint:format', 'npm run lint -- --fix', 'npm run lint -- -o r.txt',
      'npm run typecheck -- --build', 'npm -w apps/web run lint -- --fix=true',
    ])
  })

  test('环境变量:UPDATE_SNAPSHOT(前缀 / env / export)对所有会跑测试的命令都认', () => {
    row(W, [
      'UPDATE_SNAPSHOT=all npx vitest run', 'env UPDATE_SNAPSHOT=new npx vitest run', 'export UPDATE_SNAPSHOT=all; npx vitest run',
      'UPDATE_SNAPSHOT=all npm run lint', 'UPDATE_SNAPSHOT=all bash scripts/dev/gate-slice.sh main',
      'NODE_OPTIONS=--cpu-prof npx vitest run', "NODE_OPTIONS='--test-update-snapshots' node --test x.test.mjs",
    ])
  })
})

describe('交互 / 调试类:要本机窗口、调试器或常驻的留本机', () => {
  test('vitest UI:--ui · --open · --browser(含点号子项 / =值)', () => {
    row(B, [
      'npx vitest --ui', 'npx vitest run --ui', 'npx vitest --ui=true', 'npx vitest run --open', 'npx vitest run --browser',
      'npx vitest run --browser=chromium', 'npx vitest run --browser.headless=false', 'npx vitest run --browser.ui',
    ])
  })

  test('vitest 常驻:watch / dev 子命令 · --watch(=值)· -w · --standalone · --api(=值 / 点号 / 空格值)', () => {
    row(I, [
      'npx vitest watch', 'npx vitest dev', 'npx vitest --watch', 'npx vitest -w', 'npx vitest --watch=true', 'npx vitest --watch=off', 'npx vitest --watch=no',
      'npx vitest --standalone', 'npx vitest run --api', 'npx vitest run --api=51204', 'npx vitest run --api.port=51204',
      'npx vitest run --api 51204',
    ])
  })

  test('playwright 窗口:--ui · --ui-port / --ui-host(=值 / 空格值 / 驼峰)· --headed · --debug(=值 / 空格值)· --reporter=html', () => {
    row(B, [
      'npx playwright test --ui', 'npx playwright test --ui-port=0', 'npx playwright test --ui-port 0',
      'npx playwright test --uiPort=0', 'npx playwright test --ui-host=0.0.0.0', 'npx playwright test --ui-host 0.0.0.0',
      'npx playwright test --headed', 'npx playwright test --headed=true', 'npx playwright test --debug',
      'npx playwright test --debug=cli', 'npx playwright test --debug cli', 'npx playwright test --reporter=html',
      'npx playwright test --reporter html', 'npx playwright test --reporter=list,html',
    ])
  })

  test('调试器:--inspect · --inspect-brk / --inspectBrk · --inspect-wait · --inspect=端口(vitest / node / playwright)', () => {
    row(I, [
      'npx vitest run --inspect', 'npx vitest run --inspect-brk', 'npx vitest run --inspectBrk', 'npx vitest run --inspect=9230',
      'node --inspect-brk --test x.test.mjs', 'node --inspect-wait --test x.test.mjs', 'node --inspect=0 --test x.test.mjs',
      'npx playwright test --inspect',
    ])
  })

  test('node --test 常驻:--watch · --watch-path(=值)', () => {
    row(I, ['node --test --watch x.test.mjs', 'node --watch --test x.test.mjs', 'node --watch-path=src --test x.test.mjs'])
  })

  test('tsc 常驻:--watch · -w · -watch · npm 脚本 -- --watch / -w · 名字以 watch 结尾', () => {
    row(I, [
      'npx tsc --watch', 'npx tsc -w', 'tsc -watch', 'npx tsc --noEmit --watch', 'npm run typecheck -- --watch',
      'npm run typecheck -- -w', 'npm run typecheck:watch',
    ])
  })

  test('eslint:--inspect-config 起配置检查器的本机服务;--debug 也留(只是啰嗦日志,多留本机)', () => {
    row(I, ['npx eslint --inspect-config', 'npx eslint --inspectConfig'])
    row(B, ['npx eslint --debug .'])
  })

  test('环境变量:PWDEBUG(前缀 / env / export / bash -c 外)对所有会跑测试的命令都认', () => {
    row(B, [
      'PWDEBUG=1 npx playwright test', 'env PWDEBUG=console npx playwright test', 'export PWDEBUG=1; npx playwright test',
      'PWDEBUG=1 npx vitest run', 'PWDEBUG=1 node --test x.test.mjs', 'PWDEBUG=1 bash scripts/dev/gate-slice.sh main',
      "PWDEBUG=1 bash -c 'npx playwright test'", 'PWDEBUG=1 npm run build',
    ])
  })

  test('环境变量:PLAYWRIGHT_HTML_OPEN / PW_TEST_HTML_REPORT_OPEN 不是 never 就开 HTML 报告服务', () => {
    row(B, [
      'PLAYWRIGHT_HTML_OPEN=always npx playwright test', 'PLAYWRIGHT_HTML_OPEN=on-failure npx playwright test',
      'env PW_TEST_HTML_REPORT_OPEN=always npx playwright test', 'PLAYWRIGHT_HTML_OPEN=always npx vitest run',
    ])
  })

  test('环境变量:PWTEST_WATCH · NODE_OPTIONS 里的 --inspect* / --watch', () => {
    row(I, [
      'PWTEST_WATCH=1 npx playwright test', 'NODE_OPTIONS=--inspect npx vitest run',
      "NODE_OPTIONS='--max-old-space-size=4096 --inspect-brk' npx playwright test", 'env NODE_OPTIONS=--inspect node --test x.test.mjs',
      'export NODE_OPTIONS=--inspect-brk; npm run typecheck',
    ])
  })

  test('bash -c 包着的照认', () => {
    row(B, ["bash -c 'npx playwright test --ui-port=0'", "bash -c 'npx vitest --ui'"])
    row(W, ["bash -c 'npx playwright test --update-snapshots=all'"])
  })
})

// 第 3 份复核 R3-F1:旗标分两张表。布尔类只有 =false(小写原样)与 --no- 算关 —— mri / cac 把 =False 当非空字符串、照样开;
// 取值类(文件 / 目录 / 端口 / 方式)出现就算,值是什么都不管:=false 是一个叫 false 的文件。
describe('布尔类:只认 =false 与 --no- 为关,大小写不同的 False / FALSE 不算关', () => {
  test('vitest 布尔:-u · --update · --coverage(写)· --ui · --open · --browser(窗口)· --watch · --standalone · --api(常驻)', () => {
    row(W, ['npx vitest run --update=False', 'npx vitest run -u=FALSE', 'npx vitest run --coverage=False'])
    row(B, ['npx vitest run --ui=False', 'npx vitest run --open=FALSE', 'npx vitest run --browser=False'])
    row(I, ['npx vitest --watch=False', 'npx vitest --standalone=FALSE', 'npx vitest run --api=False'])
  })

  test('playwright 布尔:-u · --update-snapshots(写)· --headed · --debug · --ui(窗口)', () => {
    row(W, ['npx playwright test --update-snapshots=False', 'npx playwright test -u=FALSE'])
    row(B, ['npx playwright test --headed=False', 'npx playwright test --debug=FALSE', 'npx playwright test --ui=False'])
  })

  test('eslint 布尔:--fix(写)· --inspect-config(常驻)', () => {
    row(W, ['npx eslint . --fix=False', 'npx eslint . --fix=FALSE'])
    row(I, ['npx eslint --inspect-config=False'])
  })

  test('tsc 布尔:--build · --incremental · --declaration · --emitDeclarationOnly · --init(写)· --watch(常驻)', () => {
    row(W, ['npx tsc --build=False', 'npx tsc --incremental=FALSE', 'npx tsc --declaration=False', 'npx tsc --emitDeclarationOnly=False', 'npx tsc --init=False'])
    row(I, ['npx tsc --watch=False', 'tsc -watch=FALSE'])
  })

  test('node --test 布尔:--test-update-snapshots · --cpu-prof · --heap-prof(写)· --watch · --inspect(常驻)', () => {
    row(W, ['node --test --test-update-snapshots=False x.test.mjs', 'node --cpu-prof=FALSE --test x.test.mjs', 'node --heap-prof=False --test x.test.mjs'])
    row(I, ['node --watch=False --test x.test.mjs', 'node --inspect=FALSE --test x.test.mjs'])
  })
})

describe('取值类:出现就留本机,=false · --no- · stdout 都不算关', () => {
  test('vitest 取值:--outputFile(含点号)· --output-file · --attachmentsDir · --coverage.reportsDirectory', () => {
    row(W, [
      'npx vitest run --reporter=json --outputFile=false', 'npx vitest run --output-file=false', 'npx vitest run --no-outputFile',
      'npx vitest run --attachmentsDir=false', 'npx vitest run --coverage.reportsDirectory=false',
    ])
  })

  test('playwright 取值:--output · --last-failed-file · --update-source-method(写)· --ui-port · --ui-host(窗口)', () => {
    row(W, [
      'npx playwright test --output=false', 'npx playwright test --no-output', 'npx playwright test --last-failed-file=false',
      'npx playwright test --update-source-method=false',
    ])
    row(B, ['npx playwright test --ui-port=false', 'npx playwright test --ui-host=false'])
  })

  test('eslint 取值:-o · --output-file · --cache-location', () => {
    row(W, ['npx eslint . --output-file=false', 'npx eslint . -o=false', 'npx eslint . --no-output-file', 'npx eslint --cache --cache-location=false .'])
  })

  test('tsc 取值:--outDir · --outFile · --out · --declarationDir · --tsBuildInfoFile · --generateTrace · --generateCpuProfile', () => {
    row(W, [
      'npx tsc --outDir=false', 'tsc -outDir=false', 'npx tsc --outFile=false', 'npx tsc --out=false', 'npx tsc --declarationDir=false',
      'npx tsc --tsBuildInfoFile=false', 'npx tsc --generateTrace=false', 'npx tsc --generateCpuProfile=false',
    ])
  })

  test('node 取值:--test-reporter-destination(含 stdout)· --cpu-prof-dir · --heap-prof-dir · --diagnostic-dir · --redirect-warnings · --report-directory(写)· --watch-path · --inspect-port(常驻)', () => {
    row(W, [
      'node --test --test-reporter=spec --test-reporter-destination=false x.test.mjs',
      'node --test --test-reporter=spec --test-reporter-destination=stdout x.test.mjs',
      'node --cpu-prof-dir=false --test x.test.mjs', 'node --heap-prof-dir=p --test x.test.mjs', 'node --diagnostic-dir=d --test x.test.mjs',
      'node --redirect-warnings=false --test x.test.mjs', 'node --report-directory=r --test x.test.mjs',
    ])
    row(I, ['node --watch-path=false --test x.test.mjs', 'node --inspect-port=false --test x.test.mjs'])
  })

  test('环境变量取值:PLAYWRIGHT_*_OUTPUT_DIR / _OUTPUT_FILE / _OUTPUT_NAME · PLAYWRIGHT_HTML_REPORT', () => {
    row(W, [
      'PLAYWRIGHT_HTML_OUTPUT_DIR=false npx playwright test', 'env PLAYWRIGHT_JSON_OUTPUT_NAME=r.json npx playwright test',
      'PLAYWRIGHT_JUNIT_OUTPUT_FILE=j.xml npx playwright test', 'export PLAYWRIGHT_BLOB_OUTPUT_DIR=b; npx playwright test',
      'PLAYWRIGHT_HTML_REPORT=false npx playwright test', 'PLAYWRIGHT_LAST_RUN_OUTPUT_FILE=x npx playwright test',
    ])
  })
})

// 第 4 份复核 R4-F1:主名.子项。子项只有 .enabled 是布尔;别的子项(目录 · 端口 · headless · all …)CLI 上分不清布尔还是取值,
// 一律当取值:--no- 与 =false 都不算关,主名在哪张表就按哪张表的理由留本机。
describe('点号子项:只有 .enabled 能关掉主名', () => {
  test('布尔类主名 + 非 enabled 子项:--no- / =false 照样留本机(coverage · browser · api · ui)', () => {
    row(W, ['npx vitest run --no-coverage.all', 'npx vitest run --no-coverage.clean', 'npx vitest run --coverage.all=false'])
    row(B, ['npx vitest run --no-browser.headless', 'npx vitest run --no-browser.ui', 'npx vitest run --browser.headless=false'])
    row(I, ['npx vitest run --no-api.strictPort', 'npx vitest run --api.strictPort=false'])
  })

  test('取值子项挂在布尔主名下:--no-coverage.reportsDirectory · --no-api.port / .host · --no-browser.screenshotDirectory', () => {
    row(W, [
      'npx vitest run --no-coverage.reportsDirectory', 'npx vitest run --coverage.reportsDirectory=false',
      'npx vitest run --no-coverage.reporter', 'npx vitest run --no-outputFile.json', 'npx vitest run --outputFile.junit=false',
    ])
    row(I, ['npx vitest run --no-api.port', 'npx vitest run --no-api.host', 'npx vitest run --api.port=false'])
    row(B, ['npx vitest run --no-browser.screenshotDirectory'])
  })

  test('.enabled 照布尔类:--no-X.enabled / X.enabled=false 关,=False 不关', () => {
    for (const c of ['npx vitest run --no-coverage.enabled', 'npx vitest run --coverage.enabled=false', 'npx vitest run --no-browser.enabled', 'npx vitest run --browser.enabled=false']) {
      expect({ c, local: local(c) }).toEqual({ c, local: null })
    }
    row(W, ['npx vitest run --coverage.enabled', 'npx vitest run --coverage.enabled=False'])
    row(B, ['npx vitest run --browser.enabled=FALSE'])
  })
})

// 第 3 份复核 R3-F2:shell 包装里写的 CI= / PLAYWRIGHT_HTML_OPEN= 也算用户写了,不注入。
describe('CI 口径注入:shell 包装里的赋值也认', () => {
  const payload = (c: string): string | undefined => shellCommands(itxCommand(c, '/r/myapp-wt', ''))[1]?.at(-1)
  test('bash -c / sh -c / bash -lc 里的 CI= · PLAYWRIGHT_HTML_OPEN= 各自不注入', () => {
    for (const [c, inner] of [
      ["bash -c 'CI=0 npx vitest run'", "export PLAYWRIGHT_HTML_OPEN=never; bash -c 'CI=0 npx vitest run'"],
      ["sh -c 'export PLAYWRIGHT_HTML_OPEN=always; npx vitest run'", "export CI=1; sh -c 'export PLAYWRIGHT_HTML_OPEN=always; npx vitest run'"],
      ["bash -lc 'env CI= npx vitest run'", "export PLAYWRIGHT_HTML_OPEN=never; bash -lc 'env CI= npx vitest run'"],
      ["bash -c \"bash -c 'CI=0 npx vitest run'\"", "export PLAYWRIGHT_HTML_OPEN=never; bash -c \"bash -c 'CI=0 npx vitest run'\""],
    ] as [string, string][]) expect({ c, inner: payload(c) }).toEqual({ c, inner })
  })
})

describe('否定与关掉的写法照送(修前误留本机)', () => {
  test('--no-名字 · --名字=false · 快照更新一族 =none · 空值环境变量', () => {
    for (const c of [
      'npx vitest run --update=none', 'npx vitest run -u=none', 'npx vitest run --coverage.enabled=false', 'npx eslint --fix=false .', 'npx vitest run --no-watch',
      'npx vitest run --watch=false', 'npx vitest run --coverage=false', 'npx playwright test --update-snapshots=none',
      'UPDATE_SNAPSHOT=none npx vitest run', 'PWDEBUG= npx playwright test', 'npx vitest run --no-coverage',
    ]) {
      expect(kinds(c).length > 0).toBe(true)
      expect({ c, local: local(c) }).toEqual({ c, local: null })
    }
  })
})

// 以下修前就绿:守的是改成统一解析后不把常见命令误留本机。
describe('回归:照送 build box', () => {
  test('启动器自己的旗标不算工具的(npm -w · npx -y · -p)', () => {
    for (const c of [
      'npm -w apps/web run lint', 'npm run lint -w apps/web', 'npx -y vitest run', 'npx --yes vitest run',
      'npx -p typescript tsc --noEmit', 'npm run typecheck:fast', 'npm run lint:mobile',
    ]) expect({ c, local: local(c) }).toEqual({ c, local: null })
  })

  test('只读、只往 stdout 写的写法照送', () => {
    for (const c of [
      'npx vitest run', 'vitest run x', 'npx vitest run --reporter=json', 'npx vitest run -t update',
      'npx vitest run src/watch.test.ts', 'npx vitest src/watch.test.ts', 'npx eslint --fix-dry-run .', 'npx eslint --cache .',
      'npx tsc -p .', 'tsc --noEmit', 'npx tsc -p tsconfig.json --noEmit', 'npx playwright test -j 4 --reporter=list',
      'npx playwright test --browser=chromium', 'npx playwright test -g update', 'node --test x.test.mjs',
      'node --test --test-reporter=spec x.test.mjs', 'npx next build', 'npm run build',
    ]) expect({ c, local: local(c) }).toEqual({ c, local: null })
  })

  test('无关或明确关掉的环境变量照送', () => {
    for (const c of [
      'PLAYWRIGHT_HTML_OPEN=never npx playwright test', 'NODE_OPTIONS=--max-old-space-size=4096 npx vitest run',
      'CI=1 npx vitest run', 'FORCE_COLOR=0 npx vitest run', 'env CI=1 npx playwright test',
    ]) expect({ c, local: local(c) }).toEqual({ c, local: null })
  })

  test('jest / prettier 不在白名单:钩子不改写,原样本机跑', () => {
    for (const c of ['npx jest -u', 'npx jest --watch', 'npx prettier --write .', 'npx prettier -w .']) {
      expect({ c, kinds: kinds(c) }).toEqual({ c, kinds: [] })
    }
  })
})
