# delegate

lead 的外部 run 驾驶舱(契约:`docs/plan/2026-10-10-lead-harness.md` 切片 4)。确定性 harness:**不切片、不写任务书、不选执行器**(D-1)。

## 做什么

- **`$.delegate.runs()`**(C-0,类型 `types/index.d.ts`):本会话起的 omd-lite run。`bin/scan.mjs` 读 `~/.omd-lite/runs/<label>/`;
  结束 = `meta.json.wall_seconds` 有值(D-8,`result.json` 会先出);没 result 且 driver 已死 = `interrupted`;
  `failureClass` 取自 result.json 与末个 pi `agent_end` / mcode `exec.completed`(429 / 529 / 2056 / 5xx / 断流 → `provider`)。
  有 run 在跑每 2 s 扫一次,否则 10 s;提到 omd-lite / omdl- 的 Bash 调用后立即再扫。
- **叫醒**(GWT-15):run 结束 → 60 s 窗口内合成**一条** `$.prompt.submit`(没有 run 还在跑就立即发):label · state · 轮数 · failureClass · diffstat · 越界 · 闸日志末 20 行;
  provider 失败不附闸日志,只说「换供应商或等窗口,不要回灌给执行方」(INV-8)。
- **launch 守卫**(Bash 的 `omd-lite run …` 或仓配置的 launch 脚本):任务书缺「原始目标原文」/「允许改动:」/「## 成功判据」、缺「lead 已重算」标记(没有期望值也要写一行「期望值:无」)、缺「对外签名」节(没有就写一行「对外签名:无」)、
  「允许改动」碰到仓配置的敏感路径清单又没写 `## 安全面` 节、命中仓配置的 `briefDeny`(整篇任务书里出现不许交给执行体的引用)、允许改动里的路径不存在又没标(新建)、
  与在跑 run 的允许改动重叠、距上次 launch 不足 `launchSpacingSeconds`、`omdl-*` 超 `diskBudgetGB` 或盘余 < `minFreeGB` → deny 并逐条说明。**不设并发上限**(D-16)。
- **闸槽**:delegate 不再改写 `--gate`,原样交给 piw。按内存排队由两仓的 `scripts/dev/gate-slice.sh` 调 factory 的 `gate-slot.sh` 做(D-11)。
- **合并后清理**(D-17 ②):`git merge … omdl/<label>` 或仓配置的 merge 脚本成功后,确认分支已进 HEAD、worktree 干净且没有非缓存的被忽略文件,再跑 `omd-lite clean <label>`(gc 不支持按 run 限定)。
- **交接闸**(owner 10.11):relay 的 `handoff.phase` 为 `armed` / `ready`(交接已开始)时,deny 新的 `Agent` / `Workflow` / `SendMessage` —— relay 只在没有子 agent 在跑时 /clear,交接后再派就一直清不掉。在跑的照常返回;deny 文案带交接路径与 HANDOFF-READY。relay 没装 / 读不到 → 不拦。
- **`/runs`**:只读表。

## S8 加的(G-1 · G-2 · G-3 · G-8,`docs/plan/2026-10-13-omd-to-mods.md` §3.5)

- **`--dry-run` 不是 launch**:`omd-lite run --dry-run …` / `piw run --dry-run …` 只打印计划(不建 worktree、不调模型),守卫整条放行:不查任务书、间隔、磁盘、重叠、执行器,不改写,不占 `launchSpacingSeconds`。
  解析里 `--dry-run` 和 `--no-context`、`--full` 一样是开关(此前被当成带值参数,吞掉后面的 `--spec`)。同一条命令里有真启动的,只判真的那个。守卫自己出错时的兜底 deny 同样不拦 dry-run。`piw` 这个名字 launch 守卫现在就认(`LAUNCH_CLIS`;S11 / G-7 再抽成选项)。
- **G-1 会话 id 跟随 /clear**:/clear 不触发 `session.start`,所以不再只在那里读一次 `sessionId`。每次扫描都重新取 `$.session.id()`;`classic.SessionStart`(source=clear)和 `session.end`(reason=clear)也触发同步。
  id 变了且是 clear:`wake:<旧 id>` 并入 `wake:<新 id>`(旧簿删除),旧 id 留在血缘里(最多 4 个,存在簿子的 `prior` 里,重载后读得回),`bin/scan.mjs` 接逗号分隔的 id 列表 —— clear 之前起、还在跑的 run 结束照样叫醒,clear 之后起的 run 用新 id 扫得到。
  id 变了但不是 clear(换去了另一个会话):另起血缘,不带旧 id。`$.delegate.runs()` 的字段语义不变,只是「本会话」覆盖整条 clear 血缘。
- **G-2 执行器检查**:launch 前 `command -v <executor>`(`--executor` > 仓配置 `executor` > 默认 `pi`;只查 `pi` / `mcode` / `claude`,别的值不管;`pi` 另认 `PIW_PI_BIN` 和 fnm default alias,和 piw 的解析一致)。缺失就 deny,点名执行器和出路。检查本身出错放行。
- **G-8 强制分离(D-SPAWN)**:`omd-lite run` / `piw run` 的命令里该条简单命令没有 `setsid` / `nohup` 时,改写成 `[A=1 ]setsid -f [env …]omd-lite run … </dev/null >>~/.omd-lite/launch/<name>.log 2>&1`:已有的重定向不动,只补缺的描述符;管道里的不改;`--name` 不合法的不改;改写幂等。仓配置的 launch 脚本自己负责分离,这里只包它的 gate。
  注意两点:一是前台跑的 `omd-lite run`(没 `&`)改写后立刻返回,不再阻塞到跑完 —— 靠叫醒和 `/runs` 看结果;二是日志放 `~/.omd-lite/launch/`,**不是**契约写的 `runs/<label>/launch.log`:omd-lite 开跑时拒绝已存在的 `runs/<name>` 目录,守卫没法提前建它。
- **G-3 断档续跑**:`session.start` 调 `bin/scan.mjs --orphans`,跨会话列出 7 天内「driver 已死、没有 `result.json`、没有 `wall_seconds`、worktree 还在、没被续跑过」的 run(没有 `<label>-rN` 目录,也没有别的 run 的 `resumedFrom` 指向它),放进 `PluginState` atom(`delegate.orphans`,点按钮后立刻重绘),AbovePrompt 上画一条带「续跑 <label> → <label>-r2」按钮和「忽略」。
  点续跑:`$.process.run(['sh','-c','mkdir -p "${LOG%/*}" && setsid -f "$@" </dev/null >>"$LOG" 2>&1','_', <omdLitePath>, 'run', --repo … --base <base_sha> --spec … --prompt … --gate … (--role <角色> | --model <模型>) --name <label>-r2 --reuse-worktree <原 worktree>], { env: { LOG, CLAUDE_CODE_SESSION_ID } })`。
  参数全部取自原 run 的 `meta.json`(闸原样照抄)。**契约里写的 `--label` 在 CLI 里叫 `--name`**,这里用 `--name`。`--reuse-worktree` 由 omd-lite 的 S2 分支(`s2-piw-ask-run`)提供,没合并前真实续跑会被 CLI 拒绝(未知参数被当成 `--reuse_worktree` 吞掉,会新建 worktree —— 上线顺序见下)。续跑算一次 launch,占间隔。
- **GC / merge 认 `resumedFrom`(本片只写清,不改)**:续跑的 run 用原 worktree 和原分支,但自己有新 label。需要改两处,补丁在 `deploy/`,由 S11 一并上线:
  - `~/.claude/bin/prune-agent-worktrees.sh:51`:`omdl-<label>` 只看 `runs/<label>/result.json`,原 label 永远没有 → worktree 被永久保留。改为:任何 `meta.worktree` 指向该 worktree 的 run 有 `result.json` 就算收尾(`deploy/prune-agent-worktrees.sh.patch`)。
  - `myapp/scripts/dev/omdl-merge.sh:5`:按 `omdl-$n` / `omdl/$n` 找 worktree 与分支,`omdl-merge.sh <label>-r2` 找不到。改为:`runs/$n/meta.json` 有 `resumedFrom` 时取它的 `worktree` / `branch`(`deploy/omdl-merge.sh.patch`)。
  - 另外 `meta.json` 里原 run 保持原样(没有 result);`piw clean` / `piw gc` 是否认映射属 S11 范围。

## S9 加的(G-4 provider 失败后自动重派一次)

- **判据**:读 piw 写进 `meta.json` / `result.json` 的 `failureClass`(`bin/scan.mjs` 输出为 `piwFailure`,另有 `failedCoords`、`claudeSession`;`meta.json` 没有就看 `result.json`),**不读 stderr**。只认 `quota`、`stream`;`gate` / `request` / `auth` 不重派,有 `outside` 或 `stuck` 的也不派(gate 失败:越界、卡闸)。`$.delegate.runs()` 的字段与语义不变,`piwFailure` 只在内部 `ScanRun` 上,和 C-0 的 `failureClass`(`provider` / `gate` …)并存。
- **动作**:run 刚结束(和叫醒同一判据:本次加载看着它在跑,或新出现且已结束;结束超过 2 h 的不派)→ 经 D-SPAWN 起 `<piw|omd-lite> run --repo … --base … --spec … --prompt … --gate …(原样) --role worker --skip-coord <failedCoords 每一个> [--max-rounds N] [--no-context] --name <label>-p2`。同一份任务书、新 worktree(不带 `--reuse-worktree`)、日志 `~/.omd-lite/launch/<label>-p2.log`、`CLAUDE_CODE_SESSION_ID` 用当前会话 id(`-p2` 归在同一会话下,走同一套叫醒和 `/runs`)。算一次 launch,占 `launchSpacingSeconds`。
- **每个 label 最多一次**:`-p2`(及 `-p2-rN`)结尾的 label 不再派。防重复靠文件锁 `mkdir <runDir>/.redispatch.lock`(经 `$.process.run`,mkdir 原子,成功者才派;`$.store` 没有 CAS,不当锁)。非 0 退出(锁已在)= 别人在派,本次不派。同一次加载内,试过的 label 不再试锁(轮询 2 s 一次)。`<label>-p2` 已在扫描结果里也不试锁。
- **只由 `claude_session` 匹配的会话派**:`claudeSession` 在当前会话 id 或 /clear 血缘里才派,不在就不派、不试锁。
- **chain 用完才唤醒 lead**:重派起成功(或锁已在、或 `-p2` 已在跑)时,原 label 不进叫醒;`-p2` 结束时照常叫醒。重派没起来(`setsid` 非 0、信息不够)、`redispatch:false`、或不满足判据时,原 label 照常叫醒,toast 说明原因。`-p2` 自己再因额度 / 断流失败:不再派,叫醒文本带「这是自动重派(-p2)的结果,同一 label 不再自动重派」。
- **回滚**:userConfig `redispatch:false`(默认 true),或 revert。`redispatch` 已在 `plugin.json` 的 userConfig 里声明(默认 true),设置界面里可见。
- **边角,写明不是遗漏**:① 启动失败时锁留着,不自动回收(防反复派),靠叫醒让 lead 手动处理;② 锁已在但 `-p2` 没出现(上一次加载起失败过)时本次不叫醒 lead,那次失败当时已叫醒过;③ 同时多个 run 失败会依次各自重派,不额外错峰(失败的坐标已跳过、额度类还有 piw 的冷却表兜底);④ 原失败 run 的 worktree 留着,由 `piw gc` 清;`omdl-merge.sh <label>-p2` 原样可用(worktree `omdl-<label>-p2`)。

## S10 加的(G-5 扫描器只留一份 · G-9 交接带 run 状态)

- **`$.delegate.allRuns()`**:`bin/scan.mjs --all` —— 同一套 `summarise`,去掉 `claude_session` 过滤,所以别的会话、`omdl-queue.sh` / `slot-run.sh` 起的片(meta.json 没有 `claude_session`)也在。字段与 `runs()` 一样(C-0 的 `DelegateRun`);`runs()` 的语义一个字没动(本会话 + /clear 血缘)。
  缓存 2 s(同时来的请求共用一次扫描),扫描出错 / 输出不是数组就回上一次好的结果。`allRuns` 的结果**只给调用方看**:不进叫醒、launch 守卫、重派 —— 那几样永远只认本会话。`session.start` 之前没有可用的 `$`,`allRuns()` 返回 `[]`。
  类型:`types/index.d.ts` 的 `Delegate` 加了 `allRuns`(这个文件不在 S10 字面的允许改动里,但新增方法不声明就没法用,算 `$.delegate.allRuns()` 的一部分)。
- **savvy-progress**:`bin/omd-scan.mjs`(及它的 spec)删除,改读 `$.delegate.runs()`,`plugin.json` 加 `"dependencies": ["delegate"]`。面板用 C-0 字段画,C-0 里没有的三样不再画:工具调用数(`N tools`)、执行方最后一句话、`gate` 阶段(在跑的一律显示 `executing`)。失败行的 note 取 `stuck` > `failureClass` > `outside n`,断掉的是 `interrupted`。
  没装 / 没启用 delegate 时 `$.delegate` 不存在,调用抛错被吞,omd-lite 一节为空,其它功能不受影响。
- **relay**:删掉自己的 run 目录扫描(`runningRuns`、`sessionRuns`,以及两个 fresh 阈值)。`/ops` 的「在跑的 run」读 `$.delegate.allRuns()`(跨会话,标「所有 session」);`phase=wait` 的「有没有在等的」和面板的 run 摘要读 `$.delegate.runs()`(本会话)。delegate 不在时:`/ops` 写「读不到(delegate 没装或没启用)」,`phase=wait` 只算子 agent 和后台任务,面板不显示 run 行(此前会退回去扫 `~/.omd-lite/runs`,现在不退)。
  `relay/types/delegate-ref.d.ts` **没改**(曾改过,在 47c71f0 撤回,该文件不在 S10 允许范围内)。`allRuns` 的类型内联声明在 `relay/hooks/register.ts`(`$.delegate as { allRuns?: () => Promise<DelegateRunLike[]> }`);relay 仍不依赖 delegate,只在它在、且带 `allRuns` 时读。
- **G-9 交接**:relay 的 `handoffNote` 多一节「本 session 的 run 和重派状态」,数据只来自 `runs()`(本会话,别的会话的不出现):在跑的排前面,每条 `label · state · 第 r/m 轮 · failureClass · stuck`,再按 label 约定标注去向 —— `X` 有 `X-p2` →「已自动重派为 X-p2(状态)」;`…-p2` 本身失败 →「自动重派的结果,同一 label 不再自动重派」;provider 失败但没有 `-p2` →「provider 失败,没有 -p2 重派」;`X` 有 `X-rN` →「已续跑为 X-rN(状态)」。最多列 12 条。读不到 delegate 时写「读不到」让 lead 自己核对。
  重派状态是**从 label 命名推出来的**(`-p2` / `-rN`),不是读 delegate 内部的锁和账 —— `$.delegate` 契约(C-0)不暴露它们,本片不改契约字段。
- 验收对应:`test ! -e savvy-progress/bin/omd-scan.mjs`、`! grep -n "\.omd-lite/runs" relay/hooks/register.ts savvy-progress/hooks/register.tsx` 都过(见提交)。

### S10 上线步骤(待 owner 执行,本片没动任何线上位置)

1. 合并顺序:先 `s8` / `s9`(delegate 本体,S10 在其上),再合 `s10-scanner-dedupe`;三个 mod 的 `claude plugin validate` + `claude plugin test` 都过,重载会话。**savvy-progress 现在依赖 delegate**:`enabledPlugins` 里 delegate 必须保持启用,否则 savvy 的 omd-lite 一节为空(其它功能正常)。
2. 人工核对(需要真的 run,本片只在伪造的 `$.delegate` 上测过):① 另开一个会话起一个 `piw run` / `omd-lite run`,本会话 `/ops` 能看到它、`HANDOFF` 提示里没有它;② savvy 的 band / `/agents-info` 里本会话的 run 能画出来,失败行的 note 是 `provider` / `stuck-gate` 等;③ relay 触发一次自动交接,提示里有「本 session 的 run 和重派状态」。
3. `savvy-progress/README.md`(第 11、20 行)和 `savvy-progress/types/index.d.ts`(第 49 行注释)**没改**(曾改过,在 47c71f0 撤回,不在 S10 允许范围内),仍指向已删的 `bin/omd-scan.mjs` / `omd-scan.spec.mjs`。留待后续单独改。
4. 回滚:revert 本片的 `5bf7d8f`、`64eb83e`、`2784627`(`47c71f0` 是撤回提交,不用动)即可(savvy 的旧扫描器随 revert 回来)。

### S11 改名兼容(G-7):omd-lite → piw

- **常量表**(`hooks/logic.ts` 的 `RUN_NAMES`,`bin/scan.mjs` 的 `NAMES` 是它在扫描器里的副本):`{ cliNames: ['piw','omd-lite'], runsDir: '.omd-lite/runs', branchPrefix: 'omdl/', wtPrefix: 'omdl-' }`。launch 识别、合并识别(`git merge omdl/<label>`)、磁盘预算(`du …/<wtPrefix>*`)、run 记录目录、launch 日志目录(`runsDir` 旁的 `launch/`)都从这张表取。`resolveNames(options)` 让 options 覆盖:`cliNames`(逗号串或数组)、`runsDir`(相对 `$HOME`,绝对路径原样)、`branchPrefix`、`wtPrefix`;没有对应的 userConfig 声明,只是代码读 options(同 `redispatch` 的做法)。给 `scan.mjs` 的覆盖:`runsDir` 作为末位参数,`cliNames` 走环境变量 `DELEGATE_CLI_NAMES`,默认值时一个都不传。
- **`isAlive`**(`bin/scan.mjs`):`/proc/<pid>/cmdline` 里某个词**就是**或以 `/` 结尾于 `piw` / `omd-lite` 才算(`node /home/user/repos/piw/bin/piw run …`、`node …/omd-lite run …` 都活;`…/repos/piw/lib/x.js`、`sleep` 不算)。此前是 `includes('omd-lite')`,目录改名后 `piw run` 会被误判成 interrupted。新增 `procRoot` 参数给 `/proc` 夹具用。
- **`piwPath`**:`plugin.json` 的 `omdLitePath` 改名 `piwPath`,**默认空 = 自动**:`~/repos/piw/bin/piw` 存在就用它(改名之后),否则 `~/repos/omd-lite/bin/omd-lite`(改名之前)。配了 `piwPath` 用它;没有就读旧键 `omdLitePath`。用在合并后 `clean`、续跑、重派。
- `OMD_LITE_ENV_FILE=` 的改写(仓配置 `envFile`)**不改名**:CLI 两个名字都读,而线上还没合并的 omd-lite 只认旧名;命令里已经写了 `PIW_ENV_FILE=` 的也算「已给」。
- 测试:`bin/scan.test.mjs` 加 `isAlive` 的 `/proc` 夹具用例(两个名字都活、被占用的 pid 不算)——插件测试沙箱不让 import `node:fs`(`cannot import "node:fs"`),所以这几条不在 `hooks/delegate.test.ts` 里;`hooks/delegate.test.ts` 加了名字表、`piwPath` 选择、options 透传到 `scan.mjs` / meta / `du` 的用例。
- **GC / merge 的 `resumedFrom` 映射**:`deploy/prune-agent-worktrees.sh.patch`(线上 `~/.claude/bin/`)由 omd-lite 仓的 `deploy/s11-rename.sh` 一并上线(幂等,先备份);myapp 的 `omdl-merge.sh` 映射已直接改在 myapp 的 `s11-piw-rename` 分支里(`deploy/omdl-merge.sh.patch` 对该分支已无意义,不要再应用)。

## 上线步骤(待 owner 执行,本片没动任何线上位置)

1. 先合并 omd-lite 的 `s2-piw-ask-run`(提供 `--reuse-worktree` / `--role` / `--skip-coord` / `--dry-run`,以及 run 结束时写入 `failureClass` / `failedCoords`)。没合并前,不要点「续跑」;自动重派也不会触发(`meta.json` 里没有 `failureClass`)。
2. 合并本片分支 `s9-delegate-redispatch`(已含 `s8-delegate-g1238`),`claude plugin validate delegate && claude plugin test delegate`,在 `enabledPlugins` 里保持 delegate 启用,重载会话。版本已升 0.2.0。
3. 应用 `deploy/prune-agent-worktrees.sh.patch`、`deploy/omdl-merge.sh.patch` 到 `~/.claude/bin/prune-agent-worktrees.sh` 与 `myapp/scripts/dev/omdl-merge.sh`(`patch -p1 <文件> < deploy/<文件>.patch`,先 `--dry-run`),或留给 S11。
4. 人工核对:`/clear` 之后 `/runs` 仍列出 clear 之前起的 run;`omd-lite run --dry-run …` 不被拦;带 `&` 不带 nohup 的 launch 被改写、`~/.omd-lite/launch/<name>.log` 有输出;故意把 `--executor` 写成不存在的 mcode 路径时被拒。

7. 人工核对(需要真的额度 / 断流失败,本片没有做):一个 pi run 因 429 失败后 `~/.omd-lite/runs/<label>/.redispatch.lock` 出现、`<label>-p2` 起来且 `--skip-coord` 带上了失败的坐标;`-p2` 再失败时 lead 被叫醒且不再派。

## 仓配置 `.claude/delegate.json`(可选,放在会话 cwd)

```json
{
  "launch": "scripts/dev/omdl-launch.sh",
  "launchArgs": ["name", "base", "spec", "gate..."],
  "merge": "scripts/dev/omdl-merge.sh",
  "gate": "scripts/dev/gate-slice.sh main",
  "envFile": "/home/user/repos/myapp/.env",
  "executor": "pi",
  "model": "minimax-cp/MiniMax-M3.1-Flash-Preview",
  "fullGates": "final",
  "sliceGate": "scripts/dev/gate-slice.sh",
  "layerGates": [
    { "pattern": "^supabase/migrations/|^supabase/ci/", "cmd": "bash supabase/ci/replay-local.sh" },
    { "pattern": "(^|/)package(-lock)?\\.json$|next\\.config", "cmd": "npm run build --workspace apps/web" },
    { "pattern": "^apps/mobile/", "cmd": "npm run verify:mobile" },
    { "pattern": "^supabase/functions/", "cmd": "npm run check:functions && npm run test:functions" },
    { "pattern": "\\.css$|^docs/design/tokens/|^apps/web/src/components/ui/", "cmd": "npm run check:design && npm run check:design:app" }
  ],
  "fullGatesSummary": "/tmp/full-gates-{sha}/summary.txt",
  "measure": ["perf-gate\\.sh", "web-vitals\\.mjs"]
}
```

没有配置 = 只认 `omd-lite run` / `piw run`。

M2 G-B 的两项(不写 = 不查):
- **`sensitivePaths`**:`--repo` 相对路径,指向敏感路径清单(每行一个 bash 模式,`*` 可跨目录,`#` 开头与空行忽略,同 myapp `scripts/dev/sensitive-paths.txt`)。「允许改动」碰到清单里任一路径、又没有 `## 安全面` 标题行 → 拒派并点名那些路径;清单文件读不到 = 不查(不报错)。
- **`briefDeny`**:`{ "re": "正则", "why": "为什么不许交" }` 列表,`re` 在**整篇**任务书上匹配(普通 JS 正则,别带 `g`)。命中 → 拒派,并把 `why` 原样念出来:任务书整篇发给执行体,个人数据 / 生产凭证 / 生产引用不能进去。正则编不出来也拒派(点名那条),不让它等于没拦。

D-18 三级闸门(四项都写才启用,缺哪项哪部分不生效):
- **批合并后**:`merge` 命令成功后,工具结果里追加一段提醒:`<sliceGate> <批前 sha>`(这批改动合集的组合片闸)+ 合集命中的 `layerGates`。同一批的后续合并沿用第一片合并前的 sha。
- **清账**:跑 `<sliceGate> <批前 sha>` 且命令没报错 → 这批清账,下一次合并重新记批前 sha。以日志判红绿,mod 只看命令有没有出错。
- **独占量测前**:命令命中 `measure` 正则 → 读 `fullGatesSummary`(`{sha}` = `git rev-parse --short HEAD`);文件不在或有任何一行 `rc≠0` → 拦下并点名红的那道。`executor` / `model` / `gate` / `envFile` 只在 `omd-lite run` 缺对应参数时补上。

## 校验

```bash
claude plugin validate delegate && claude plugin test delegate
node --test delegate/bin/scan.test.mjs     # 含 --orphans、--all(scanAll)、血缘 id 列表、piwFailure / failedCoords
```
