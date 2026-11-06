// 重命令送 build box 的纯规则:认重命令、判能不能整条送过去、拼改写后的命令。钩子那一半在 register.ts。

import { shellCommands } from './rules'

export const LOCAL_RUN_ACK = 'LOCAL_RUN_ACK'
export const ITX_RUN =
  'REMOTE_GATE_HOST=gate@build-box REMOTE_RUN_EXEC=$HOME/.local/share/remote-run/remote-run-exec.sh ' +
  'bash $HOME/.local/share/remote-run/remote-run.sh --kind dev -- '
// 远端 worktree 的路径(<gate 家目录>/wt/<仓>-<sha>-<pid>)本机拼不出来:命令里的本机仓顶先换成这个占位,
// 远端在仓顶起跑后把它换成 $PWD 再 eval —— 文字替换,不管它原来落在哪种引号里都对。
export const TOP_MARK = '__HEAVY_ROUTE_TOP__'
// 发版检查与合并前打戳本来就该在本机跑(要生产凭证 / 发布目录 / 打的是本机的戳),照旧本机。
// 只对「被跑的那条脚本」的路径匹配(见 localException),命令参数里带这些词的普通测试不算。
export const RELEASE_LOCAL = new RegExp([
  'myapp-release', 'money-gate', 'migration-gate', 'vps-web', String.raw`ota\.sh`, 'layout-gate', 'shared-stack-ab', 'release-gates',
  'scripts/release/', String.raw`(gate-stamp|merge-queue)(?=\.sh$)`,
].join('|'))
// build box 上做不了的:命令本身在操作本机开发栈 · 连本机地址 · 碰客户数据(remote-run 的快照不带 clients/)。
// 按命令的词判(见 keepLocalHit / readsEnv),不扫整行:路径里带 supabase / 过滤词里带 localhost 的测试不算。
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?([/?#]|$)/i
const LOCAL_URL = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*@)?(127\.0\.0\.1|localhost|\[::1\])(?=[:/?#]|$)/i
const STACK_PORT = /[A-Za-z0-9.\]-]:5432[12](?!\d)/
const HOST_FLAG = /^--?(host|hostname|url|base-?url|server|address|db-?host)$/i
const SUPABASE_STACK_SUBS = new Set(['db', 'start', 'stop', 'status', 'migration', 'link'])
const ENV_FILE = /(^|[=/])\.env(\.[\w.-]*)?$/

// 每条命令的词(bash -c 里的脚本拆开再认)。
function wordLists(line: string): string[][] {
  const out: string[][] = []
  for (const ws of shellCommands(line)) {
    out.push(ws)
    const w = strip(ws)
    const c = SHELLS.has(baseName(w[0] ?? '')) ? w.findIndex((t, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(t)) : -1
    if (c > 0 && w[c + 1] !== undefined) out.push(...wordLists(w[c + 1] as string))
  }
  return out
}

export function keepLocalHit(line: string): string | null {
  for (const ws of wordLists(line)) {
    const t = launched(strip(ws))
    const tool = baseName(t[0] ?? '')
    if (bin(tool) === 'supabase') {
      const sub = firstPositional(t.slice(1))
      if (sub && SUPABASE_STACK_SUBS.has(sub)) return `${tool} ${sub}`
      if (sub === 'functions' && t[t.indexOf('functions') + 1] === 'serve') return `${tool} functions serve`
    }
    for (const [i, tok] of ws.entries()) {
      if (bin(tok) === 'psql' && !tok.includes('=')) return 'psql'
      if (tok === '--db-url' || tok.startsWith('--db-url=')) return '--db-url'
      const v = tok.replace(/^(--?[\w-]+|[A-Za-z_]\w*)=/, '')
      const url = LOCAL_URL.exec(v)
      if (url) return url[2] as string
      if (LOCAL_HOST.test(v) && (v !== tok || HOST_FLAG.test(ws[i - 1] ?? ''))) return (LOCAL_HOST.exec(v) as RegExpExecArray)[1] as string
      const port = STACK_PORT.exec(v)
      if (port) return port[0].slice(port[0].indexOf(':'))
      if (/(^|[=:]|\.\/|\/myapp[^/]*\/)clients\//.test(tok)) return 'clients/'
    }
  }
  return null
}
// 读 .env* 的命令送不过去(remote-run 的快照不带它们):--env-file · 参数 / source / . 的是 .env* 文件 · dotenv 命令或 dotenv/config。
export function readsEnv(line: string): boolean {
  return wordLists(line).some(ws => {
    const head = bin(launched(strip(ws))[0] ?? '')
    if (head === 'dotenv' || head === 'dotenvx') return true
    return ws.some(t => t === '--env-file' || t.startsWith('--env-file=') || ENV_FILE.test(t) || /(^|[=/])dotenv(x)?\/config$/.test(t))
  })
}
// 送走的命令按 CI 口径跑(lead 31.10):vitest 缺快照直接失败、不在 build box 写新快照;playwright 不起 HTML 报告服务挂住。
// 命令里自己写了同名赋值的(前缀 · env · export)照用户写的。
export const ITX_ENV: [string, string][] = [['CI', '1'], ['PLAYWRIGHT_HTML_OPEN', 'never']]
// 改写后的命令要等 build box 的槽、锁文件变了还要 npm ci:Bash 默认 2 分钟超时会让会话以为失败、反复重跑。
export const ITX_TIMEOUT_MS = 600_000

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
// 与重命令同一条送过去也无害的命令(读输出、判退出码);别的命令混在里面整条就不能送(提交、写的文件会留在 build box 的临时 worktree)。
// sed 只在不带 -i 时算;tee 不算(它写文件)。
const BENIGN = new Set([
  'cd', 'pushd', 'popd', 'echo', 'printf', 'head', 'tail', 'grep', 'rg', 'wc', 'sort', 'uniq', 'cat', 'ls',
  'sed', 'awk', 'cut', 'tr', 'jq', 'test', '[', '[[', 'true', 'false', ':', 'exit', 'set', 'export', 'pwd', 'date',
  'sleep', 'for', 'case', 'wait',
])
// 只是前缀,后面才是要跑的命令。
const PREFIXES = new Set(['env', 'nice', 'command', 'time', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{'])
const CLOSERS = new Set(['fi', 'done', 'esac', '}'])

const baseName = (w: string): string => w.split('/').pop() ?? ''
const bin = (w: string): string => baseName(w).replace(/@.*$/, '')
const isAssign = (w: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)

// 提权前缀的取值旗标;sudo / doas 后面才是要跑的命令。
const PRIV_VALUE_OPTS = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t'])

// seen 不为空时,把剥掉的提权前缀(sudo / doas)记进去。
function strip(all: string[], seen?: string[]): string[] {
  let w = all
  for (;;) {
    const t = w[0]
    if (t === undefined) return w
    if (t === 'sudo' || t === 'doas') {
      seen?.push(t)
      let i = 1
      while (w[i]?.startsWith('-')) i += PRIV_VALUE_OPTS.has(w[i] as string) ? 2 : 1
      w = w.slice(i)
      continue
    }
    if (isAssign(t) || PREFIXES.has(t)) { w = w.slice(1); continue }
    if (t === 'timeout') {
      let i = 1
      while (w[i]?.startsWith('-')) i++
      w = w.slice(i + 1)
      continue
    }
    return w
  }
}

// pnpm / yarn 后面直接跟的可执行名(pnpm vitest run · yarn playwright test)。
const DIRECT_BINS = new Set(['vitest', 'tsc', 'tsgo', 'tsrs', 'eslint', 'pytest', 'semgrep', 'vite', 'next', 'expo', 'playwright'])

// npx / bunx / npm exec 后面真正跑的那个命令与它的参数。
function execTarget(w: string[]): string[] | null {
  const head = bin(w[0] ?? '')
  if ((head === 'pnpm' || head === 'yarn') && !['exec', 'x', 'dlx'].includes(w[1] ?? '')) {
    for (let i = 1; i < w.length; i++) {
      const t = w[i] as string
      if (NPM_VALUE_OPTS.has(t)) { i++; continue }
      if (t.startsWith('-')) continue
      return DIRECT_BINS.has(bin(t)) ? w.slice(i) : null
    }
    return null
  }
  const from = head === 'npx' || head === 'bunx' ? 1
    : ['npm', 'pnpm', 'yarn'].includes(head) && ['exec', 'x', 'dlx'].includes(w[1] ?? '') ? 2
    : 0
  if (!from) return null
  for (let i = from; i < w.length; i++) {
    const t = w[i] as string
    if (t === '-p' || t === '--package') { i++; continue }
    if (t === '--') continue
    if (t.startsWith('-')) continue
    return w.slice(i)
  }
  return null
}

const UV_VALUE_OPTS = new Set(['--with', '--with-requirements', '--with-editable', '--python', '-p', '--project', '--directory', '--package', '--extra', '--group', '--env-file', '--index', '--from'])

// 真正跑的那条命令:npx / npm exec · uv run · python -m 都剥掉。
function launched(w: string[]): string[] {
  let t = execTarget(w) ?? w
  if (bin(t[0] ?? '') === 'uv' && t[1] === 'run') {
    let i = 2
    while (i < t.length && (t[i] as string).startsWith('-')) i += UV_VALUE_OPTS.has(t[i] as string) ? 2 : 1
    t = t.slice(i)
  }
  if (/^python(3(\.\d+)?)?$/.test(bin(t[0] ?? ''))) {
    const m = t.indexOf('-m')
    if (m > 0 && t[m + 1] !== undefined && t.slice(1, m).every((a, k) => a.startsWith('-') || ['-X', '-W'].includes(t[k] as string))) t = t.slice(m + 1)
  }
  return t
}

const NPM_VALUE_OPTS = new Set(['-w', '--workspace', '--prefix', '-C', '--filter', '--cwd'])

// npm / pnpm / yarn / bun run <脚本> 的脚本名;npm test / npm t 算 test(bun test 是 bun 自己的测试器,另认)。
function npmScript(w: string[]): string | null {
  const pm = bin(w[0] ?? '')
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) return null
  const pos: string[] = []
  for (let i = 1; i < w.length && pos.length < 2; i++) {
    const t = w[i] as string
    if (NPM_VALUE_OPTS.has(t)) { i++; continue }
    if (t.startsWith('-')) continue
    pos.push(t)
  }
  if (pm !== 'bun' && (pos[0] === 'test' || pos[0] === 't' || pos[0] === 'tst')) return 'test'
  return pos[0] === 'run' || pos[0] === 'run-script' ? (pos[1] ?? null) : null
}

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

// 一个旗标:名字归一成小写、去掉 - 与 _、只取点号前一段(--update-snapshots / --updateSnapshots · --outputFile.json 同名);
// 短名保留原样。sub 是点号后的子项(同样归一);value 是 =值,没有就取下一个不以 - 开头的词(可能其实是位置参数);
// off 是写成关掉的样子(--no- · =false · 快照更新一族 =none),算不算关由 flagClass 按表定。
export type Flag = { name: string; sub?: string; short: boolean; value?: string; off: boolean }

// 解析器(mri / cac · commander · optionator)只把原样小写的 false 当布尔假,False / off / no 是非空字符串、照样开;none 只在快照更新一族有定义。
const OFF = /^false$/
const NONE_OFF = new Set(['u', 'update', 'updatesnapshot', 'updatesnapshots'])
const normFlag = (s: string): string => (s.split('.')[0] ?? '').toLowerCase().replace(/[-_]/g, '')

// 一串参数里的旗标,认 --名 · --名=值 · --名 值 · --no-名 · -短 · -短=值 · -短名簇(-xu);tsc 的 -watch / -outDir 这类单横线长名传 singleDashLong。
export function parseFlags(args: string[], singleDashLong = false): Flag[] {
  const out: Flag[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (!/^-[^-\d]|^--[^-=]/.test(a)) continue
    const eq = a.indexOf('=')
    const head = eq >= 0 ? a.slice(0, eq) : a
    const given = eq >= 0 ? a.slice(eq + 1) : undefined
    const next = args[i + 1]
    const value = given ?? (next !== undefined && !next.startsWith('-') ? next : undefined)
    const off = given !== undefined && (OFF.test(given) || (given === 'none' && NONE_OFF.has(normFlag(head.replace(/^-+/, '')))))
    if (head.startsWith('--') || (singleDashLong && head.length > 2)) {
      const neg = /^no-/.test(head.replace(/^--?/, ''))
      const raw = head.replace(/^--?/, '').slice(neg ? 3 : 0)
      const dot = raw.indexOf('.')
      const sub = dot >= 0 ? raw.slice(dot + 1).toLowerCase().replace(/[-_]/g, '') : undefined
      out.push({ name: normFlag(raw), ...(sub ? { sub } : {}), short: false, value, off: neg || off })
      continue
    }
    const letters = head.slice(1)
    for (const [k, ch] of [...letters].entries()) {
      const last = k === letters.length - 1
      out.push({ name: ch, short: true, ...(last ? { value, off: off || (given === 'none' && ch === 'u') } : { off: false }) })
    }
  }
  return out
}

// 两张表,拿不准的往留本机这边放。布尔类:=false 与 --no- 算关。取值类(文件 · 目录 · 端口 · 方式):出现就算,
// 值是什么都不管 —— --output-file=false 是一个叫 false 的文件,--test-reporter-destination=stdout 也不放行。
type Reason = 'local-browser' | 'interactive' | 'writes-files'
const BOOL: Record<string, Reason> = {
  ui: 'local-browser', open: 'local-browser', headed: 'local-browser', debug: 'local-browser',
  watch: 'interactive', watchall: 'interactive', standalone: 'interactive', api: 'interactive',
  inspect: 'interactive', inspectbrk: 'interactive', inspectwait: 'interactive', inspectconfig: 'interactive',
  fix: 'writes-files', autofix: 'writes-files', write: 'writes-files', update: 'writes-files', updatesnapshot: 'writes-files', updatesnapshots: 'writes-files',
  testupdatesnapshots: 'writes-files', coverage: 'writes-files', build: 'writes-files', init: 'writes-files',
  incremental: 'writes-files', declaration: 'writes-files', emitdeclarationonly: 'writes-files',
  cpuprof: 'writes-files', heapprof: 'writes-files', prof: 'writes-files',
}
const VALUED: Record<string, Reason> = {
  uiport: 'local-browser', uihost: 'local-browser', watchpath: 'interactive', inspectport: 'interactive',
  outputfile: 'writes-files', output: 'writes-files', attachmentsdir: 'writes-files', coveragedirectory: 'writes-files',
  updatesourcemethod: 'writes-files', lastfailedfile: 'writes-files', cachelocation: 'writes-files', cachedirectory: 'writes-files',
  outdir: 'writes-files', outfile: 'writes-files', out: 'writes-files', declarationdir: 'writes-files', tsbuildinfofile: 'writes-files',
  generatetrace: 'writes-files', generatecpuprofile: 'writes-files',
  testreporterdestination: 'writes-files', cpuprofdir: 'writes-files', cpuprofname: 'writes-files', heapprofdir: 'writes-files',
  heapprofname: 'writes-files', diagnosticdir: 'writes-files', redirectwarnings: 'writes-files', reportdirectory: 'writes-files',
  reportfilename: 'writes-files', junitxml: 'writes-files', outputdir: 'writes-files', jsonoutput: 'writes-files', sarifoutput: 'writes-files',
  textoutput: 'writes-files', junitxmloutput: 'writes-files', gitlabsastoutput: 'writes-files', emacsoutput: 'writes-files', vimoutput: 'writes-files',
}
const SHORT_BOOL: Record<string, Reason> = { w: 'interactive', u: 'writes-files', b: 'writes-files', d: 'writes-files' }
const SHORT_VALUED: Record<string, Reason> = { o: 'writes-files' }

function flagClass(f: Flag, kind: string): Reason | null {
  // pytest 的短名与上面的表不同义(-o 是改 ini 项、-d 是 xdist 分发),按表认会把普通用法误拒。
  if (f.short && kind === 'pytest') return null
  const valued = f.short ? SHORT_VALUED[f.name] : VALUED[f.name]
  if (valued) return valued
  const main = f.short ? SHORT_BOOL[f.name] : f.name === 'browser' && (kind === 'vitest' || kind === 'vitest-slot') ? 'local-browser' : BOOL[f.name]
  // 主名.子项:只有 .enabled 是布尔;别的子项(reportsDirectory · port · headless …)CLI 上分不清,一律当取值,--no- / =false 不算关。
  if (main && f.sub && f.sub !== 'enabled') return main
  if (f.off) return null
  if (!f.short && f.name === 'reporter' && /html/.test(f.value ?? '')) return 'local-browser'
  return main ?? null
}

const RANK: Reason[] = ['local-browser', 'interactive', 'writes-files']
export function flagsLocal(flags: Flag[], kind: string): string | null {
  const hits = new Set(flags.map(f => flagClass(f, kind)))
  return RANK.find(r => hits.has(r)) ?? null
}

// 命令行里的每个赋值 [名, 值]:前缀 · env · export,以及 bash -c / sh -c 包着的脚本里的(拆开再认,脚本整串不当赋值)。
export function assignments(line: string): [string, string][] {
  const out: [string, string][] = []
  for (const ws of shellCommands(line)) {
    const h = ws.length - strip(ws).length
    const c = SHELLS.has(baseName(ws[h] ?? '')) ? ws.findIndex((t, i) => i > h && /^-[a-z]*c[a-z]*$/.test(t)) : -1
    const script = c > 0 && ws[c + 1] !== undefined ? c + 1 : -1
    for (const [i, t] of ws.entries()) {
      if (i === script) continue
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(t)
      if (m) out.push([m[1] as string, m[2] ?? ''])
    }
    if (script > 0) out.push(...assignments(ws[script] as string))
  }
  return out
}

// 这些赋值对所有重命令都认。空值等于没设。
export function envLocal(line: string): string | null {
  const hits = new Set<string>()
  for (const [name, value] of assignments(line)) {
    if (!value) continue
    if (name === 'PWDEBUG') hits.add('local-browser')
    else if ((name === 'PLAYWRIGHT_HTML_OPEN' || name === 'PW_TEST_HTML_REPORT_OPEN') && value !== 'never') hits.add('local-browser')
    else if (name === 'PWTEST_WATCH') hits.add('interactive')
    else if (name === 'UPDATE_SNAPSHOT' && value !== 'none') hits.add('writes-files')
    else if (/^PLAYWRIGHT_[A-Z_]*(_OUTPUT_(DIR|FILE|NAME)|_REPORT)$/.test(name)) hits.add('writes-files')
    else if (name === 'NODE_OPTIONS') {
      const r = flagsLocal(parseFlags(value.trim().split(/\s+/)), 'node')
      if (r) hits.add(r)
    }
  }
  return RANK.find(r => hits.has(r)) ?? null
}

// 白名单那条命令自己的参数:启动器(npm -w · npx -y -p)的旗标不算。
function toolArgs(w: string[]): string[] {
  if (npmScript(w) === null) return launched(w).slice(1)
  const out: string[] = []
  const dd = w.indexOf('--')
  for (let i = 1; i < w.length; i++) {
    const t = w[i] as string
    if (NPM_VALUE_OPTS.has(t) && (dd < 0 || i < dd)) { i++; continue }
    out.push(t)
  }
  return out
}

const firstPositional = (args: string[]): string | undefined => args.find(a => !a.startsWith('-'))
// 子命令前面常见的取值旗标(vite --config x build):取值不当子命令。
const SUB_VALUE_OPTS = new Set(['--config', '-c', '--base', '--mode', '-m', '--logLevel', '-l', '--port', '-p', '--hostname', '-H', '--platform', '--cwd'])
function subcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const t = args[i] as string
    if (SUB_VALUE_OPTS.has(t)) { i++; continue }
    if (!t.startsWith('-')) return t
  }
  return undefined
}

// 一条简单命令(前缀已去)命中白名单的哪一项;不中是 null。
export function heavyKind(w: string[]): string | null {
  const head = w[0]
  if (head === undefined) return null
  const script0 = SHELLS.has(baseName(head)) ? firstPositional(w.slice(1)) : head
  if (script0?.endsWith('scripts/dev/gate-slice.sh')) return 'gate-slice'
  // vitest-slot.sh 是 MyApp 排队跑 vitest 的包装,本质还是本机 vitest(2.11 myapp-d2 用它在 dev box 跑了 240 条)。
  if (script0?.endsWith('scripts/dev/vitest-slot.sh')) return 'vitest-slot'
  const script = npmScript(w)
  if (script !== null) {
    if (script.startsWith('typecheck')) return 'tsc'
    if (script.startsWith('lint')) return 'eslint'
    if (script.startsWith('test')) return 'npm-test'
    if (script.startsWith('verify')) return 'verify'
    if (/^check(:|$)/.test(script)) return 'check'
    return script === 'build' ? 'build' : null
  }
  const [tool, ...args] = launched(w)
  const sub = subcommand(args)
  switch (bin(tool ?? '')) {
    case 'vitest': return 'vitest'
    case 'tsc': return 'tsc'
    case 'tsgo': return 'tsgo'
    case 'tsrs': return 'tsrs'
    case 'eslint': return 'eslint'
    case 'pytest': case 'py.test': return 'pytest'
    case 'semgrep': return ['login', 'logout', 'lsp', 'publish', 'install-semgrep-pro'].includes(sub ?? '') ? null : 'semgrep'
    case 'bun': return sub === 'test' ? 'bun-test' : null
    case 'deno': return sub === 'test' ? 'deno-test' : sub === 'check' ? 'deno-check' : null
    case 'vite': return sub === 'build' ? 'vite-build' : null
    case 'expo': return sub === 'export' ? 'expo-export' : null
    case 'next': return sub === 'build' ? 'build' : null
    case 'playwright': return sub === 'test' ? 'playwright' : null
    case 'node': {
      for (const a of args) {
        if (!a.startsWith('-')) return null
        if (a === '--test') return 'node-test'
      }
      return null
    }
    default: return null
  }
}

// remote:这一段本来就经 remote-run 跑(kinds 取它送过去的那条命令),不再包一层。
// local:这一段命中白名单但只能在本机跑的理由(writes-files · local-browser · interactive)。
export type Step = { cd?: string; kinds: string[]; foreign: string[]; remote?: true; local?: string }

function heavyLocal(kind: string, w: string[]): string | null {
  const args = toolArgs(w)
  if (kind === 'vitest' && ['watch', 'dev'].includes(firstPositional(args) ?? '')) return 'interactive'
  const script = npmScript(w) ?? ''
  if (/(^|:)(ui|debug)$/.test(script)) return 'local-browser'
  if (/(^|:)(watch|dev)$/.test(script)) return 'interactive'
  if (/(^|:)(fix|format|write)$/.test(script)) return 'writes-files'
  return flagsLocal(parseFlags(args, ['tsc', 'tsgo', 'tsrs'].includes(kind)), kind)
}

// 命令行里写到文件的重定向(> · >> · N> · &> · >(…));>&N 与写到 /dev/null 之类不算。引号里的不算。
export function writesRedirect(line: string): boolean {
  let q: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === q) q = null
      else if (c === '\\' && q === '"') i++
      continue
    }
    if (c === "'" || c === '"') { q = c; continue }
    if (c === '\\') { i++; continue }
    if (c !== '>') continue
    let j = i + 1
    if (line[j] === '>' || line[j] === '|') j++
    if (line[j] === '&') continue
    if (line[j] === '(') return true
    while (line[j] === ' ' || line[j] === '\t') j++
    const target = /^[^\s;&|()<>]*/.exec(line.slice(j))?.[0] ?? ''
    if (!/^\/dev\/(null|stdout|stderr)$/.test(target)) return true
    i = j + target.length - 1
  }
  return false
}

// 命令行顶层的每一段:cd 去哪 · 命中的白名单项 · 混在里面又不能送过去的命令名。`bash -c '…'` 拆开再认。
export function routeSteps(line: string): Step[] {
  const out: Step[] = []
  for (const all of shellCommands(line)) {
    const priv: string[] = []
    const w = strip(all, priv)
    const head = w[0]
    // `2>&1` 被拆成 `…2>` 与 `1`;`&>/dev/null` 拆出 `>/dev/null`:都是重定向的残片,不是命令。
    if (head === undefined || /^\d+$/.test(head) || /^[<>]/.test(head) || CLOSERS.has(head)) continue
    if (head === 'cd' || head === 'pushd') {
      const target = w[1] === '--' ? w[2] : w[1]
      out.push({ cd: target ?? '~', kinds: [], foreign: [] })
      continue
    }
    const rr = w.findIndex(t => t.endsWith('remote-run.sh'))
    if (rr >= 0) {
      const dd = w.indexOf('--', rr)
      const argv = dd >= 0 ? w.slice(dd + 1) : []
      // 本钩子拼出来的形状:bash -c 'eval "${1//<占位>/…}"' heavy-route '<原命令>' —— 认的是第 5 个词。
      const payload = argv[2]?.includes(TOP_MARK) ? (argv[4] ?? '') : argv.map(sq).join(' ')
      out.push({ kinds: routeSteps(payload).flatMap(s => s.kinds), foreign: [], remote: true })
      continue
    }
    if (SHELLS.has(baseName(head))) {
      const c = w.findIndex((t, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(t))
      if (c > 0 && w[c + 1] !== undefined) {
        const script = w[c + 1] as string
        const inner = routeSteps(script)
        const step: Step = { kinds: inner.flatMap(s => s.kinds), foreign: [...inner.flatMap(s => s.foreign), ...(writesRedirect(script) ? ['>'] : [])] }
        const local = inner.find(s => s.local)?.local
        out.push(local ? { ...step, local } : step)
        continue
      }
    }
    const kind = heavyKind(w)
    if (kind) {
      const local = heavyLocal(kind, w)
      // 提权跑测试 / 编译:送过去 build box 上不会有 sudo 的口令,本机也不该提权跑,拒并记账。
      const foreign = priv.length ? [priv[0] as string] : []
      out.push(local ? { kinds: [kind], foreign, local } : { kinds: [kind], foreign })
      continue
    }
    const benign = BENIGN.has(baseName(head)) && !(head === 'sed' && w.some(t => /^(-[^-]*i|--in-place)/.test(t)))
    out.push({ kinds: [], foreign: benign ? [] : [head] })
  }
  const env = envLocal(line)
  return env ? out.map(s => (s.kinds.length && !s.remote && !s.local ? { ...s, local: env } : s)) : out
}

// 命令开头 LOCAL_RUN_ACK='<理由>' 的理由;没有或为空是 null。
export function localAck(line: string): string | null {
  for (const t of shellCommands(line)[0] ?? []) {
    if (t === 'env') continue
    if (!isAssign(t)) return null
    if (t.startsWith(`${LOCAL_RUN_ACK}=`)) return t.slice(LOCAL_RUN_ACK.length + 1).trim() || null
  }
  return null
}

// 本机先 cd 到仓顶(remote-run 的快照只收 cwd 以下的改动),整条命令作为一个参数送到远端仓顶上 eval;
// 会话 cwd 在仓里的子目录时远端先 cd 过去。
export function itxCommand(line: string, top: string, rel: string): string {
  const esc = top.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = line.replace(new RegExp(`${esc}(?![A-Za-z0-9._-])`, 'g'), TOP_MARK)
  const given = new Set(assignments(line).map(([k]) => k))
  const env = ITX_ENV.filter(([k]) => !given.has(k)).map(([k, v]) => `${k}=${v}`)
  const inner = (env.length ? `export ${env.join(' ')}; ` : '') + (rel ? `cd ${TOP_MARK}/${rel} && ` : '') + body
  return `cd ${sq(top)} && ${ITX_RUN}bash -c 'eval "\${1//${TOP_MARK}/"$PWD"}"' heavy-route ${sq(inner)}`
}

// foreign 里 '>' 是写文件的重定向,'$(…)' 是命令替换(钩子不拆开判,保守拒)。
export const mixedDeny = (kinds: string, foreign: string[]): string =>
  `agent-guard:这条命令里的 ${kinds} 是重命令,要送到 build box 跑(dev box 上二十多个会话,本机要一直轻);` +
  (foreign.some(f => f === 'sudo' || f === 'doas')
    ? '可它前面带 sudo / doas:测试与编译不需要提权,去掉提权前缀再单独一条(build box 上没有口令)。'
    : `可它混着 ${[...new Set(foreign)].slice(0, 3).join(' · ')}(本机的提交 / 写文件 / 认不清的命令替换),整条送过去这部分会落在 build box 的临时 worktree 里丢掉。`) +
  '把重命令单独写一条 Bash(会自动改写成经 remote-run 在 build box 上跑,日志回传、退出码原样),别的另写一条;要留输出就读回传的日志,不要重定向或 tee 到文件。'

// 命令行里每条命令被跑的脚本(bash x.sh · node x.mjs · ./x.sh · npx 启动的另算 launched 的第一个词)与 cd 的去处;bash -c 里的脚本拆开再认。
function invokedScripts(line: string): { scripts: string[]; cds: string[] } {
  const scripts: string[] = []
  const cds: string[] = []
  for (const all of shellCommands(line)) {
    const w = strip(all)
    const head = w[0]
    if (head === undefined) continue
    if (head === 'cd' || head === 'pushd') { cds.push((w[1] === '--' ? w[2] : w[1]) ?? ''); continue }
    if (SHELLS.has(baseName(head))) {
      const c = w.findIndex((t, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(t))
      if (c > 0 && w[c + 1] !== undefined) {
        const inner = invokedScripts(w[c + 1] as string)
        scripts.push(...inner.scripts)
        cds.push(...inner.cds)
        continue
      }
    }
    const t = launched(w)
    const runner = /^(bash|sh|zsh|dash|node|bun|deno|tsx|ts-node|python3?(\.\d+)?)$/.test(bin(t[0] ?? ''))
    const script = runner ? firstPositional(t.slice(1)) : t[0]
    if (script) scripts.push(script)
  }
  return { scripts, cds }
}

const IN_RELEASE_DIR = /(^|\/)myapp-release(\/|$)/

// 发版检查 · 合并前打戳:照旧本机,记的理由。不是这类返回 null。
// 只认被跑的脚本本身(bash scripts/dev/gate-stamp.sh · node scripts/deploy/money-gate.mjs …)· cd 进发布目录 · 会话 cwd 在发布目录 ·
// DELEGATE_GATE_LANE=merge 赋值;参数里的测试文件名 / 过滤词不算(vitest -t gate-stamp · node --test scripts/dev/merge-queue.test.mjs 照送 build box)。
export function localException(line: string, cwd = ''): string | null {
  const { scripts, cds } = invokedScripts(line)
  for (const sc of scripts) {
    const m = RELEASE_LOCAL.exec(sc)
    if (m) return `keep-local:${m[0]}`
  }
  if (cds.some(d => IN_RELEASE_DIR.test(d))) return 'keep-local:myapp-release'
  if (IN_RELEASE_DIR.test(cwd)) return 'keep-local:myapp-release'
  return assignments(line).some(([k, v]) => k === 'DELEGATE_GATE_LANE' && v === 'merge') ? 'keep-local:DELEGATE_GATE_LANE=merge' : null
}

const escRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 替代命令用的整行:去掉 build box 上做不了或丢掉的那些写法 —— LOCAL_RUN_ACK · 写文件 / 开窗口 / 常驻的旗标(连同取值)· 同类的环境赋值,
// vitest watch / 无 run 的 vitest 换成 vitest run。去完仍不能送(别的段还在本机、还碰 .env / 栈)返回 null,不给替代命令。
export function itxCleanLine(line: string): { line: string; dropped: string[] } | null {
  let out = line.replace(/(^|[\s;&|])LOCAL_RUN_ACK=('[^']*'|"[^"]*"|\S+)\s*/g, '$1')
  const dropped: string[] = []
  let addRun = false
  const drop = (t: string): boolean => {
    if (/[\s'"\\$`]/.test(t)) return false
    const re = new RegExp(`(^|\\s+)${escRe(t)}(?=\\s|$)`)
    if (!re.test(out)) return false
    out = out.replace(re, '')
    dropped.push(t)
    return true
  }
  for (const all of shellCommands(line)) {
    const w = strip(all)
    const kind = heavyKind(w)
    if (!kind) continue
    const tool = launched(w)
    const dash = ['tsc', 'tsgo', 'tsrs'].includes(kind)
    const start = all.length - tool.length
    for (let i = 0; i < all.length; i++) {
      const t = all[i] as string
      if (isAssign(t)) { if (envLocal(t) && !drop(t)) return null; continue }
      if (i < start || !t.startsWith('-')) continue
      const fs = parseFlags([t, all[i + 1] ?? ''].filter(x => x !== ''), dash)
      const bad = fs.filter((f, k) => (k === 0 || !f.short) && flagClass(f, kind))
      if (!bad.length) continue
      if (fs.filter(f => f.short).length > 1 && /^-[^-]/.test(t)) return null
      const f = fs[0] as Flag
      const cls = flagClass(f, kind)
      if (!drop(t)) return null
      if (cls === 'interactive' || cls === 'local-browser') addRun = true
      const valued = f.short ? SHORT_VALUED[f.name] : VALUED[f.name] ?? (f.name === 'reporter' ? 'x' : undefined)
      const next = all[i + 1]
      if (valued && !t.includes('=') && next !== undefined && !next.startsWith('-') && !drop(next)) return null
    }
    if (kind === 'vitest') {
      const sub = firstPositional(toolArgs(w))
      if (sub === 'watch' || sub === 'dev') { out = out.replace(/(^|\s)(watch|dev)(?=\s|$)/, '$1run'); dropped.push(sub) } else if (addRun && sub !== 'run') {
        out = out.replace(/(^|[\s/])vitest(?=\s|$)/, '$1vitest run')
      }
    }
  }
  if (!dropped.length && out === line) return null
  const steps = routeSteps(out)
  if (steps.some(s => s.local) || keepLocalHit(out) || readsEnv(out)) return null
  return { line: out.trim(), dropped }
}

// 拒绝信息里给的显式送法:仓顶上用仓里那份 remote-run.sh;不是一条简单命令、或会话在子目录里的,包进 bash -c。
// 命令里的本机仓顶换成仓内相对路径(build box 上没有这个路径)。
export function remoteAlt(line: string, top: string, rel: string): string {
  const esc = top.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = line.replace(new RegExp(`${esc}/`, 'g'), '').replace(new RegExp(`${esc}(?![A-Za-z0-9._-])`, 'g'), '.')
  const single = shellCommands(body).length === 1 && !rel
  const cmd = single ? body : `bash -c ${sq((rel ? `cd ${rel} && ` : '') + body)}`
  return `cd ${sq(top)} && REMOTE_GATE_HOST=gate@build-box bash scripts/dev/remote-run.sh --kind dev -- ${cmd}`
}

// 原来放本机的理由(MyApp 仓里一律拒):为什么不能自动送 build box,改成什么写法。
// 替代命令只在去掉不能送的写法之后能送、且不碰 .env* / clients/ / 开发栈时才给。
export function localDeny(why: string, kind: string, line: string, top: string, rel: string): string {
  const head = `agent-guard:这条命令里的 ${kind} 是重命令,dev box 上不跑测试与编译(要一直轻),要送 build box;`
  if (why === 'reads-env') {
    return head + '可它要读 .env*,remote-run 的快照不带 .env*,自动送过去读不到。' +
      '去掉 source .env / --env-file / dotenv / .env 参数,要的变量写在命令前当 VAR=值 前缀(指向本机开发栈的地址在 build box 上连不到),再单独一条(会自动送 build box)。'
  }
  if (why === 'keep-local:clients/') {
    return head + '可它碰 clients/(客户数据只留本机,remote-run 的快照不带 clients/),显式送过去也读不到。' +
      '测试改用假名夹具、放到 clients/ 以外,再单独一条(会自动送 build box)。'
  }
  if (why.startsWith('keep-local:')) {
    return head + `可它要连本机开发栈(命中:${why.slice('keep-local:'.length)}),build box 的沙箱连不到这台机器的栈,显式送过去也连不上。` +
      '连库的那一段(supabase CLI · psql · --db-url · 127.0.0.1 / localhost / :5432x 的地址)与重命令分开:不连库的测试单独一条会自动送 build box。'
  }
  const clean = itxCleanLine(line)
  const alt = clean ? remoteAlt(clean.line, top, rel) : null
  const tail = (lead: string): string => alt
    ? `${lead}${clean?.dropped.length ? `(替代命令里已去掉 ${clean.dropped.join(' ')})` : ''},或显式:${alt}`
    : lead
  if (why === 'interactive') {
    return head + '可它是 watch / dev / --inspect 这类常驻进程:不起常驻进程,用一次跑完的写法(vitest run · 去掉 --watch / -w)。' +
      tail('改完单独一条会自动送 build box')
  }
  if (why === 'local-browser') {
    return head + '可它要开浏览器窗口或调试器(--ui · --headed · --debug · PWDEBUG · html 报告),build box 上没有窗口。' +
      tail('去掉这些、无头跑,单独一条会自动送 build box;要看报告加 --fetch <报告目录> 取回')
  }
  return head + '可它会写文件(--fix · 快照更新 · --outDir · --coverage · 报告写到文件 …),送过去写在 build box 的临时 worktree 里就丢了。' +
    tail('去掉写文件的旗标,单独一条会自动送 build box;确实要那份产物,在 --kind dev 后加 --fetch <路径> 取回本机')
}
