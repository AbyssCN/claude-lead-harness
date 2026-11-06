# piw(原 omd-lite)

> S11 改名:新名字 `piw`(pi worker),入口 `bin/piw`;`bin/omd-lite` 是指向它的软链,旧名字和下文里的 `omd-lite …` 命令照常可用。改名后的目录是 `~/repos/piw`,`~/repos/omd-lite` 留作软链。见文末「改名与兼容层」。

Owner: owner。用 pi(v0.84.1)当便宜模型的执行手，跑写清楚了的编码切片;可靠性来自模型之外的确定性闸。

## 组成

- `ext/gate-loop.ts` —— pi 扩展。每次 `agent_end` 按序跑闸命令(`bash -lc`,单条 15 分钟超时，只看退出码),
  失败且有余轮 → 把失败命令与输出尾 80 行作为 user 消息回灌，再跑一轮;全过 / 轮数用完 → 写 `result.json`。
- `bin/piw`(`bin/omd-lite` 是软链)—— 驱动:建 worktree、软链 node_modules、隔离启动 pi、收集产物、出对照表;批后复盘 `retro`、清理 `gc`。
- `prompts/` —— 提示词臂(system prompt)。

## 执行器(owner 06.10:默认用 mcode)

- `--executor mcode`:内层是 MiniMax Code 的 `mcode exec`(MiniMax 官方工具链);**闸循环在本驱动里跑**(与 `ext/gate-loop.ts` 同判据:按序跑 `--gate`、首个失败即停、越界改动检查、失败输出尾 80 行用 `mcode exec --continue` 回灌,最多 `--max-rounds` 轮)。mcode 的输出同时打到终端,所以用 `vt omd-lite run … --executor mcode` 启动,就能在 VibeTunnel 里实时看。`--model default` = 用 mcode 自己的默认模型。目标仓有 `docs/process/executor-brief.md` 时,开工提示让它先读。
- `--executor pi`(缺省):原来的 pi + `ext/gate-loop.ts`。
- `--executor codex`(S6a,沙箱臂):内层是 OpenAI 的 `codex exec`,沙箱 `workspace-write` 并开网络(`-c sandbox_workspace_write.network_access=true`;唯一网络权威是 `--exec-wrapper` 里的 bwrap + pasta,不是这个 flag),`-C` 落在 worktree,`--skip-git-repo-check`(worktree 不是独立仓库)。**闸循环同 mcode**(在本驱动里跑),不续会话:每轮新起一次,把闸输出当新提示词给它。每轮的 stdout / stderr 落在 `codex-round-<n>.log`,最后一条回复由 codex 自己写进 `codex-round-<n>.last.md`;codex 不报用量,`meta.tokens` 记 0(同 agy)。`--model default` = 用 codex 自己的默认模型。
- 06.10 冒烟:单轮过(50 s);故意让第一轮闸不过 → 第二轮 `--continue` 修好(185 s)。

## 用法

```bash
omd-lite run --repo ~/repos/myapp --base main \
  --spec docs/plan/2026-10-02-g47-prh-lookup-slice.md \
  --model minimax-cp/MiniMax-M3.1-Flash-Preview \
  --prompt minimal \
  --gate "npx tsc --noEmit" --gate "scripts/dev/gate-vitest.sh" --gate "npm run lint" \
  --name g47-minimal-1
# 同一切片的另外两臂
omd-lite run ... --prompt omd-leaf --name g47-leaf-1
omd-lite run ... --prompt minimal --no-context --name g47-minnoctx-1

omd-lite report g47-minimal-1 g47-leaf-1 g47-minnoctx-1
omd-lite clean  g47-minimal-1 g47-leaf-1 g47-minnoctx-1   # 删 worktree + 分支，产物保留

omd-lite retro --since 2026-10-07          # 批后复盘:逐 run 表 + 聚合(纯读 runs 目录，不调模型)
omd-lite gc                                # 列出可清的 run worktree / 分支(只预览)
omd-lite gc --older-than 3 --apply         # 真删(run 记录保留)
```

同一道闸连红 3 轮就提前停,`result.json` 记 `"stuck": "stuck-gate"`(回灌同一段失败输出不会好转,只烧轮数;`--max-rounds` 大于 3 时才有区别)。

可选:`--red-check "<cmd>"`(开跑前在 base 上跑一次,**必须失败**;已经通过 = 判据是虚的,不开跑,`result.json` 记 `red-check-green-on-base`。借自 omd 的判据自证,通常填任务书里那条新测试)· `--max-rounds 3`(闸轮数)· `--wall 3600`(整次 pi 的墙钟上限，秒)· `--no-context`(不加载 CLAUDE.md / AGENTS.md)·
`--fallback-model <provider/id>`(默认 `deepseek/deepseek-v4-flash`;`none` 关掉)。
密钥:models.json 里写成 `$VAR` 的，从 `/home/user/repos/myapp/.env` 读出只把这一个交给 pi(`OMD_LITE_ENV_FILE` 可换);
`~/.pi/agent/auth.json` 已有凭证的供应商(如 deepseek)由 pi 自己读，不要求 `.env` 里有。

**稀疏检出(10.11)**:建 worktree 时默认不检出存档目录 `docs/design/reviews` · `docs/design/_shots-web` · `docs/design/_shots-mobile` · `docs/reviews` · `docs/research`(base 里没有的自动跳过)。加回规则：任务书「允许改动」· 任务书正文写到的路径 · base 上 `scripts` / `docs/design/tests` / `apps` / `packages` 里写死的路径，都按「被排除目录的下一级」加回(同目录对照图也在)。执行手往没加回的目录写了文件，收尾时自动把那一级加回 sparse 定义，合并时 `git add` 不会拒收。实测 myapp(f2 任务书):392 MB / 2 s vs 完整 1301 MB / 7 s。`--full` 关掉,`--sparse-exclude "a,b"` 或 `OMD_LITE_SPARSE_EXCLUDE` 换清单,`omd-lite sparse-plan --repo R --base B --spec S` 只看计划。meta.json 记 `sparse`(exclude / keep / widened)。

worktree 建在 `<repo>/../omdl-<name>`,分支 `omdl/<name>`;仓库里现有的 `node_modules`(根、`apps/*`、`packages/*`、`services/*`)
以绝对路径软链进去，免 `npm install`。

产物 `~/.omd-lite/runs/<name>/`:

| 文件 | 内容 |
|---|---|
| `meta.json` | 臂、模型、context、base sha、起止 epoch、墙钟秒数、pi 退出码、token 合计、结果 |
| `pi.jsonl` / `pi.stderr.log` | `--mode json` 事件流 / pi 的 stderr |
| `gate-round-<n>.log` | 第 n 轮各闸的完整输出与退出码 |
| `result.json` | `pass` / `fail`(含失败命令)/ `not-run`(闸从没判过：供应商报错到底、超时、pi 起不来);任务书有「允许改动:」时带 `outside`(闸判的越界清单，已扣豁免) |
| `fallback/` | 换模型重跑那一次的 `pi.jsonl` / 闸日志;`meta.attempts` 记两次的模型、退出码与触发的报错 |
| `diffstat.txt` · `changed-files.txt` | 相对 base 的改动;`?? ` 前缀 = 未跟踪新文件 |

## retro(批后复盘)

`omd-lite retro [--since YYYY-MM-DD] [label…]`:纯读 `~/.omd-lite/runs/*`,不改任何产物。契约:oh-my-dag
`docs/plan/2026-10-08-mcode-loop-retro-and-spec-axis.md` §3.1;分类与提案由 oh-my-dag 的 `/omd-retro` skill 接着做。

- **逐 run 表**:executor · result(pass / fail / not-run / running / 中断 = 没 result.json 且进程已不在)· 闸轮数 ·
  最终越界数 · 是否换模型重跑 · 墙钟分钟 · **每轮的首败**。
- **首败**取自 `gate-round-<n>.log` 的 `### $ <cmd>` / `### exit=<n>`;`gate-slice.sh` 这类分段闸带上最后一个 `== <段>` 名。
  mcode 执行器本身挂了的轮(`mcode-round-<n>.jsonl` 的 `exec.completed` 为 failed、日志里有 `agent_name_conflict…:lock` 锁冲突、
  spawn 失败)记成 `执行器挂了(<错误码>)`,和 `执行体没交付(没有改动)`(执行器跑完了但一个文件没改)分开 —— 前者是调度 / 限流问题,后者才是任务书或执行体的问题。
- **聚合**只列 ≥ 2 个 run 出现的模式(单次的只在逐 run 表里):首败闸 · 越界文件(每一轮的越界清单都算,同一文件 ≥ 2 个 run = 「允许改动」漏列候选)·
  执行器失败 · not-run / 中断原因;再给多轮 run 占比与结果分布。末行是 `gc` 预览的可清 worktree 数与大小。

## gc(清 run 留下的 worktree 与分支)

`omd-lite gc [--older-than <天>=2] [--apply]`。范围:runs 目录里 meta 记过的仓库中,`omdl/<label>` 分支、
`omdl-<label>` worktree、meta 记的 worktree 目录。**默认只打印**(路径 · 原因 · 大小),`--apply` 才
`git worktree remove --force` + `git branch -D`,最后 `git worktree prune`。`~/.omd-lite/runs/<label>` 不删(retro 要读)。

可清的条件(任一):
- 分支已在 base 里(`git merge-base --is-ancestor`,base = meta.base 与 `main`)**且 worktree 没有未提交改动** ——
  没提交过的分支天然是 base 的祖先,活儿可能全在未提交改动里;
- result 为 fail / not-run / 中断,且结束已超过 `--older-than` 天(这类 worktree 本来就脏,照清);
- run 记录已不存在的孤儿 worktree(有未提交改动的不清);meta 记的目录还在但已不是 worktree 且为空。

一律不碰:**正在跑的**(`ps` 里有进程参数带该 worktree 路径或 `omd-lite … --name <label>`;或 meta 没写结束时间且未超出
`轮数 ×(3600 s + 每道闸 15 分钟)`)· 有被 .gitignore 忽略、且不是 node_modules / .next / .venv* / 缓存之类可再生目录的文件
(myapp `docs/process/omd-workhorse.md` §17:视频素材就是这样被 `--force` 删掉的)。
大小用 `du -sb --exclude=node_modules`(node_modules 是 `cp -al` 硬链接,删了不腾空间)。

**挪开待人看**:`piw run` 起片时发现同名的空分支(上次起片被杀留下的),会先把工作区原样存到 `refs/piw-orphan/<label>-<时间>`;
证明不了没人在用(读不了某个自己进程的 cwd、`/proc` 看不全)就不删,挪到 `omdl-<label>.orphan-<时间>`,再在那里分离 HEAD。
gc 预览把这些目录单列一类、带大小和删除命令,`--apply` 不删,看过后人手删。
⚠ 在里面的 shell 跟着目录走,但用旧的绝对路径(`cd "$PWD"`、`cd ~/repos/omdl-<label>`)会进到同名的新 worktree。

## myapp 的闸写法(04.10)

- vitest 写全量，且一律经 **`scripts/dev/gate-vitest.sh`**(`flock /tmp/myapp-vitest.lock npx vitest run --maxWorkers=12`):
  全机同一时刻只跑一份全量，每份 12 worker(空闲实测 61 s)。10.4 时十几个 run 各跑 24 worker 的全量，负载 60–140,6 个 run 里 5 个墙钟超时。
  有这道闸后，并发 run 数的上限看内存(每个 worktree 的 tsc / 测试峰值约 2 GB),不看执行方个数。出处:myapp `docs/process/omd-workhorse.md` §8。
- **排队时间算在闸的 15 分钟超时里**(`ext/gate-loop.ts` 的 `GATE_TIMEOUT_MS`):N 个 run 同时等锁，最后一个约等 N × 61 s。
  同一时刻走到 vitest 闸的 run 超过约 12 个，就可能「排队超时」—— 回灌给模型的是「超时被杀」,它会误以为是自己的代码慢。并发到这个量级前先把超时放宽。

## ask / 角色表 / 备用链(S2)

`omd-lite ask --role <role> [--system <文件>] [--user <文件>|stdin] [--repo <path>] [--dry-run]`:单轮、无工具调一次 pi,文本打到 stdout。
退出码:0 成功 · 2 chain 用完(stderr 末行 `PIW_FAIL <class> <coord>`;全在冷却中时 class=`cooldown`)· 3 请求错误(2013 / 1039 / 1042 / 400,不换坐标)。

**角色表** `~/.config/piw/config.json`(`PIW_CONFIG` 可换路径;文件不存在 = 内置默认,与 SDD §3.3 一致):
`{ pi, roles: { <role>: { chain: ["provider/id[:thinking]", …] } }, cooldown: { quotaMinutes, balanceMinutes } }`。
仓库级 `<repo>/.claude/piw.json` 只能覆盖 `roles`,按角色整条替换(`ask` 用 `--repo`,缺省取 cwd;`run` 用 `--repo`)。
不设 temperature:pi 0.84.1 CLI 没有这个参数。

**pi 路径**(`"pi": "auto"`):env `PIW_PI_BIN` → config.pi(显式路径)→ fnm default alias → `command -v pi`。
fnm default alias 实测(本机,2026-10-13):`~/.local/share/fnm/aliases/default/bin/pi`(`aliases/default` 是指向 `node-versions/v24.15.0/installation` 的软链;`FNM_DIR` 可换根)。
不要写死 `/run/user/1000/fnm_multishells/…`,那是每个 shell 一份、会过期的路径。`run` 也走同一解析(不再依赖 PATH 里的 `pi`)。

**ask 的执行**:每个坐标一个 `mktemp -d` 空目录作 cwd,里面只放 `.pi/settings.json` = `{"retry":{"enabled":false}}`;
`pi -p --mode json --no-tools --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --approve --model <coord> [--system-prompt <文本>] <user>`。
user 超过 100 KB 时落临时目录以 `@user.md` 传(避免单个 argv 超限;实测 `@file` 单独可用)。取最后一个 `agent_end`:
`stopReason != error` → 输出;额度类 → 写冷却并换下一个;其他供应商错误(流中断 / 5xx / pi 没吐 agent_end)→ 换下一个、不写冷却;请求类 → exit 3;凭证类 → stderr 输出 `PIW_AUTH <coord>`、换下一个、不写冷却。
分类函数 `lib/piw.js: classifyError` 供 `ask` 与 `run` 共用(额度码表自 oh-my-dag `minimax-native.ts:61-89`)。冷却记在 `~/.cache/piw/cooldown.json`(`PIW_COOLDOWN_FILE` 可换),按 `provider/id` 记(不含 `:thinking`),
额度类 300 分钟、余额类(402 / insufficient balance)1440 分钟。`run` 在供应商报额度类错误时同样写冷却。

### 关掉 pi 同模型重试:要 `--approve`(实测 + 源码)

pi 0.84.1 对 429(含 2056)会先对**同一个模型**退避重试 3 次(2 / 4 / 8 秒)才失败。项目级 `<cwd>/.pi/settings.json` 的 `retry.enabled:false` 可以关掉,但**必须同时给 `--approve`**:

- 源码:`dist/core/trust-manager.js` 的 `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` 含 `settings.json`,`<cwd>/.pi/settings.json` 存在 → `hasTrustRequiringProjectResources` 为真 → 须经项目信任;
  `dist/core/project-trust.js` 的 `resolveProjectTrusted`:无 `--approve`/`--no-approve` 覆盖、无 trust.json 记录、`defaultProjectTrust` 非 always 时,`-p` 模式没有 UI → 返回 false → `SettingsManager` 不读项目设置(`loadFromStorage` 在 `!projectTrusted` 时返回 `{}`)→ `retry.enabled` 回落为默认 true。
- 实测(本地桩服务器,不调任何真模型):`PI_CODING_AGENT_DIR` 指向临时目录,`models.json` 里放一个 `baseUrl=http://127.0.0.1:…` 的假供应商,桩一律回 `429 … Token Plan … (2056)`;pi 0.84.1,`-p --mode json`:

  | 场景 | 桩收到的请求数 | 耗时 |
  |---|---|---|
  | 无 `.pi/settings.json`(基线) | 4 | 16 s |
  | `.pi/settings.json` 关 retry,**无** `--approve` | 4 | 17 s |
  | `.pi/settings.json` 关 retry,**加** `--approve` | 1 | 1 s |

  另:provider 报错时 pi 仍 exit 0,错误在 `agent_end` 的末条 assistant(`stopReason:"error"`,`errorMessage:"429: {…(2056)…}"`),所以 ask 看事件不看退出码。
- `--approve` 的代价:信任的是那个只含 `settings.json` 的临时空目录,没有 extensions / skills 可执行;无副作用。

### run 的新增(S2)

- `--role <r>`:chain[0] → `--model`,chain[1] → `--fallback-model`(只有一个坐标则 fallback=none);冷却中的坐标跳过;显式给的 `--model` / `--fallback-model` 优先。不带 `--role` 时行为与以前完全一致(含 `DEFAULT_FALLBACK`)。
- `--skip-coord <coord>`(可重复,需要 `--role`):从展开后的 chain 剔除,按 `provider/id` 比(带不带 `:thinking` 都认)。
- `--dry-run`:打印 chain、pi 路径、两次尝试的 pi argv、密钥注入情况(只报变量名与来源文件,不读值;不查 `auth.json`),exit 0;不建 worktree、不建 runs 目录、不调模型。
- `--reuse-worktree <path>`:不 `git worktree add`、不稀疏检出,在已有 worktree 里续跑,首个任务提示带「先 git status / git diff 看清」;`meta.json` 记 `resumedFrom`(按 `meta.worktree` 在 runs 里反查原 label,查不到取 `omdl-<label>` 目录名)与 `reused_worktree:true`;`result.json` 仍写到本次 `--name` 的 runs 目录。
- 失败分类:`meta.json` 与 `result.json`(闸已写过它时;没有时只写 meta.json,`not-run` 占位不带)新增 `failureClass: quota|auth|stream|request|gate|null` 与 `failedCoords: [...]`。
  闸判过的以闸为准(`fail` → `gate`,`pass` → null);闸没判过看末个供应商报错的类别。`failedCoords` 记所有以供应商报错收尾的坐标(主跑失败但 fallback 成功时,仍含主跑那个)。`PIW_FAIL` 仍只属于 `ask`。

测试:`node --test test/`(`test/index.js` 把目录里的 `*.test.mjs` 载入同一进程——Node ≥ 22 的 `node --test test/` 会把目录当模块而报错;也可 `node --test test/*.test.mjs`)。
`test/piw-ask-run.test.mjs` 用 `PIW_PI_BIN=test/fixtures/pi-stub.mjs` 替身 + 临时 HOME,替身按 `--model` 吐成功 / 2056 / 402 / 流中断 / 2013 / 凭证错,并把 argv、cwd 记到 `STUB_LOG`。

## 越界闸

任务书里有一行以 `允许改动:` 开头(逗号 / 顿号 / 空白分隔，目录按前缀)时，命令闸全过后再判一道「越界改动」:
相对 base 的改动(含未跟踪新文件)不在允许表里 → 这一轮算失败，越界清单回灌，让模型还原或停下说明理由。
豁免(03.10 myapp 首批 104 slice 的越界全是这两类，验收判为正当):测试文件(`*.test.*` / `*.spec.*` / `test_*.py`)的新增与修改
(删除不豁免)· `index.*` 只新增 `export` 行。规则在 `ext/gate-loop.ts` 的 `outsideFiles()`。
测试:`node --test ext/outside.test.ts test/retro-gc.test.mjs`(retro / gc 用临时 HOME + 临时 git 仓跑真 CLI)。
没有该行 = 不判。`report` 的 `outside` 列读闸判的结果;老 run 没有就按允许表现算(不扣豁免)。

## 换模型重跑

主模型的最后一个 `agent_end` 以供应商报错收尾(pi 自己的重试用完)且闸一轮没判 → 用 `--fallback-model` 在**同一 worktree** 再跑一次，
提示它先看已有的部分改动。只换一次。03.10 实测触发过的两种:MiniMax 429 Token Plan 用量上限(2056)· 流中途断开(`Stream ended without finish_reason`)。
超时(墙钟)不触发 —— 那多半是模型自己慢或空转，换模型不对症。

## 隔离开关与理由

pi 的参数固定为
`--no-extensions -e ext/gate-loop.ts --no-skills --no-prompt-templates --no-themes --no-session --mode json -p --system-prompt <臂>`。

- `--no-extensions`:全局 `settings.json` 的 `packages`(pi-lens、web-access 等十几个)会往工具面和上下文里加东西，各臂之间就不再只差提示词。
  实测：加了它之后工具面只剩内置 `read,bash,edit,write,grep,find,ls`;`-e` 显式给的扩展照常加载。
- `--system-prompt`:替换掉 `~/.pi/agent/SYSTEM.md`(实测替换后 system 只剩臂文本 + cwd 行 + 项目上下文)。
- `--no-skills` / `--no-prompt-templates` / `--no-themes`:同理，去掉全局技能与模板。
- `--no-session`:不往 `~/.pi/agent/sessions` 写会话，产物只在 runs 目录。
- 项目上下文(CLAUDE.md / AGENTS.md)默认开，各臂一致;`--no-context` 加 `--no-context-files` 关掉，meta 记 `context:false`。
- stdin 必须关(runner 用 `ignore`):pi 在 stdin 不是 TTY 时先读到 EOF(`dist/main.js` 的 `readPipedStdin`),
  stdin 若是一直不关的 socket / 管道就永远挂在启动前(实测)。

仍会读的全局件:`~/.pi/agent/models.json` / `auth.json`(供应商定义，必需)与 `settings.json` 的非包设置
(`defaultThinkingLevel`、compaction、`followUpMode` 等)。

## agent_end → sendUserMessage 在 `-p` 下的行为(pi 0.84.1 实测)

- `agent_end` 处理器里会话仍算「处理中」(`ctx.isIdle()` 为 false)。不带 `deliverAs` 调 `pi.sendUserMessage` 会报
  `Agent is already processing`,消息丢失。
- 带 `{ deliverAs: "followUp" }`:`AgentSession._runAgentPrompt` 在 `agent_end` 之后查队列(`_handlePostAgentRun` →
  `agent.hasQueuedMessages()`),非空就 `continue()`,同一个 `prompt()` 里再跑一轮，进程等它结束才退出。
  `--mode json -p` 下实测连续三轮 agent_start/agent_end 后才 `agent_settled` 并退出。所以闸循环直接放在扩展里，不需要 rpc 模式或自写 SDK 驱动。
- 供应商报错(`stopReason` 为 error / aborted)的 `agent_end` 不判闸，交给 pi 自己的重试。

## 加一个臂

在 `prompts/` 放 `<臂名>.md`,`--prompt <臂名>` 即可(也可直接给文件路径)。文件开头的 `<!-- … -->` 是出处说明，运行时剥掉，不进模型。

- `minimal` —— 7 行中文最小提示。
- `omd-leaf` —— oh-my-dag 执行叶子的最终提示词，逐字抽取，出处行号与已知失真写在文件头注释里。

## 已知限制

- node_modules 用 `cp -al` 硬链接复制进 worktree(`linkNodeModules`),工作区包的相对软链(`node_modules/@x/pkg → ../../packages/pkg`)落在 worktree 内。
  只有 `cp` 失败时才退回整目录软链(meta 记 `(symlink 兜底)`),那时工作区包会解析回**主仓库**的旧源码;myapp 的片闸
  `scripts/dev/check-workspace-links.sh` 会因此判红(15.10 M4)。
- 模型的 bash 工具继承 pi 的环境:驱动起 run 时先过 `workerEnv`(Q2,15.10)—— 名字像密钥的(`*_KEY` / `*_TOKEN` / `*_SECRET` / `*PASSWORD` / `DATABASE_URL`、`SUPABASE_` / `STRIPE_` / `RESEND_` 等前缀)与值里有生产域名的变量一律不带,`PIW_ENV_KEEP=<名,名>` 点名放行;模型供应商那一个 key 从 `ENV_FILE` 单独注入。产物只在本机 `~/.omd-lite`。
- `cost` 取自 pi 的 usage;models.json 没配价格的供应商(如 minimax-cp)显示 0。
- **备用模型的每日 token 上限**(15.10 M8a):备用模型按量计费,今天累计 ≥ 上限就不再换 —— 上限取 `$PIW_DAILY_FALLBACK_TOKEN_CAP`,
  没给则读 config.json 的 `dailyFallbackTokenCap`,再缺省 3 亿(只管 fallback;主跑的包月模型不设限,`mcode` / `claude` 执行器也不管)。
  「已用」由用量台账算:`$PIW_USAGE_DIR/<YYYY-MM-DD>.jsonl`(缺省 `~/.omd-lite/usage`,本机本地日期),每次 pi 尝试一行
  `{"at":<秒>,"label":…,"model":…,"arm":"primary"|"fallback","tokens":{input,output,cacheRead,cacheWrite,total}}`。
- 超限的样子:主跑供应商报错时 stderr 打 `[piw] <name>: 今日备用模型已用 <已用> token ≥ 上限 <上限>,不换 <fallback>,本片停下`,
  不建 `out/fallback/`、`meta.attempts` 末项记 `{ model, skipped: "budget" }`,`meta.json` 与 `result.json` 的 `failureClass` 都是 `budget`;
  台账写不进去(目录只读等)只报一行 `[piw] 用量台账写不进 <路径>:<原因>`,不影响 run(那一笔用量也就没记上)。
- 闸在第一个失败处停，同一轮后面的闸不跑。

## 改名与兼容层(S11)

- **入口**:`bin/piw` 是真文件,`bin/omd-lite` 是指向它的软链(git 里存的就是软链)。两个名字行为一样;进程命令行里出现哪个名字取决于调用方怎么写路径,所以凡是「数在跑的 run」「判 driver 还活着」的匹配都同时认两个名字(delegate 的 `isAlive`、myapp 的 `omdl-queue.sh` / `gate-combo.sh`、`~/.omd-lite/bin/slot-run.sh` 的 pgrep 锚统一成 `(omd-lite|piw) run`;`gc` 里按名字判活同理)。
- **环境变量双读**:`PIW_X ?? OMD_LITE_X`,新名优先。覆盖 `ENV_FILE`、`SPARSE_EXCLUDE`(驱动),`GATES`、`MAX_ROUNDS`、`BASE`、`ALLOWED`、`OUT`(`ext/gate-loop.ts` 读)。驱动传给 pi 的环境里**两套都写**;**`OMD_LITE_OUT` 必须继续写出**——myapp 的 `scripts/dev/git-hooks/_untrusted.sh` 靠它判断「这是不受信的执行体」。测试里有断言(`test/piw-rename.test.mjs`)。
- **不改**:`~/.omd-lite/runs`、`omdl/` 分支前缀、`omdl-` worktree 前缀(myapp 48 条分支、24 个 worktree,otherapp 6 条)。等 `piw gc` 把旧资产清完,另开一轮再改。run 日志里的 `[omd-lite]` 前缀也没动(有人 grep)。
- **`claude` 执行器**:保留代码,不推荐使用(SDD Q7)。

### 上线步骤(待 owner 执行;本分支只写了脚本,没有执行过,线上目录、软链、脚本、settings.json 一样都没动)

前置:本分支(`s11-piw-rename`)已合进 omd-lite 的 main,且 `pgrep -fc '^node [^ ]*/(omd-lite|piw) run'` 为 0(不要在批量 run 跑着的时候做)。

```
deploy/s11-rename.sh --dry-run   # 先看会做什么(不改任何东西)
deploy/s11-rename.sh             # 执行;幂等,每处改线上文件前先备份 <文件>.bak-S11,已完成的步骤跳过
```

脚本依次做:A 目录 `~/repos/omd-lite` → `~/repos/piw` + 原路径软链 + `git worktree repair`;B 确认 `bin/omd-lite` → `piw`;C `~/.local/bin/piw` → `~/repos/piw/bin/piw`;D `~/.omd-lite/bin/slot-run.sh` 的 pgrep 锚;E `~/.claude/bin/prune-agent-worktrees.sh` 认 `resumedFrom` 映射(`deploy/prune-agent-worktrees.sh.patch`,与 delegate 仓 S8 写的补丁同一份);F `~/.claude/settings.json` 的 `pluginConfigs["agent-guard@owner-mods"].options.requireWorktreeRepos` 加 `piw`(保留 `omd-lite`)。有 run 在跑就整个退出(退出码 3);`bin/piw` 不在(分支没合并)退出 4;线上文件和预期版本不符退出 5,不硬改。

上线后核对(这些依赖目录改名,本分支无法验):
```
readlink -f ~/repos/omd-lite/bin/omd-lite | grep -q repos/piw/bin/piw && echo ok
command -v piw
cd ~/repos/piw && node --test test/
```
然后:**另起一个会话**(agent-guard 的 `requireWorktreeRepos` 在会话启动时读);delegate 合并后重载,`piwPath` 留空会自动选 `~/repos/piw/bin/piw`。回滚:把 `.bak-S11` 放回原处,`rm ~/.local/bin/piw`,`rm ~/repos/omd-lite && mv ~/repos/piw ~/repos/omd-lite && git -C ~/repos/omd-lite worktree repair`,revert 各仓的 S11 提交。

不在这个脚本里、需要另外合并的:myapp 与 otherapp 的 `s11-piw-rename` 分支(`scripts/dev/omdl-*.sh`、`gate-combo.sh`),claude-mods 的 `s11-piw-rename` 分支(delegate、agent-guard)。
