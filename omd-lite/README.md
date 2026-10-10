# omd-lite

用 pi(v0.84.1)当便宜模型的执行手，跑写清楚了的编码切片;可靠性来自模型之外的确定性闸。

## 组成

- `ext/gate-loop.ts` —— pi 扩展。每次 `agent_end` 按序跑闸命令(`bash -lc`,单条 15 分钟超时，只看退出码),
  失败且有余轮 → 把失败命令与输出尾 80 行作为 user 消息回灌，再跑一轮;全过 / 轮数用完 → 写 `result.json`。
- `bin/omd-lite` —— 驱动:建 worktree、软链 node_modules、隔离启动 pi、收集产物、出对照表;批后复盘 `retro`、清理 `gc`。
- `prompts/` —— 提示词臂(system prompt)。

## 执行器

- `--executor mcode`:内层是 MiniMax Code 的 `mcode exec`(MiniMax 官方工具链);**闸循环在本驱动里跑**(与 `ext/gate-loop.ts` 同判据:按序跑 `--gate`、首个失败即停、越界改动检查、失败输出尾 80 行用 `mcode exec --continue` 回灌,最多 `--max-rounds` 轮)。mcode 的输出同时打到终端,所以用 `vt omd-lite run … --executor mcode` 启动,就能在 VibeTunnel 里实时看。`--model default` = 用 mcode 自己的默认模型。目标仓有执行者须知(`OMD_LITE_BRIEF`,默认 `docs/process/executor-brief.md`)时,开工提示让它先读。
- `--executor pi`(缺省):原来的 pi + `ext/gate-loop.ts`。

## 用法

```bash
omd-lite run --repo ~/repos/<your-app> --base main \
  --spec docs/plan/g47-some-slice.md \
  --model <provider>/<model-id> \
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
密钥:models.json 里写成 `$VAR` 的，先从 `OMD_LITE_ENV_FILE` 指向的 `.env` 读(没设就跳过),再退回当前环境变量,只把这一个交给 pi;
`~/.pi/agent/auth.json` 已有凭证的供应商(如 deepseek)由 pi 自己读，不要求 `.env` 里有。

环境变量:

| 变量 | 默认 | 作用 |
|---|---|---|
| `OMD_LITE_ENV_FILE` | 无 | 供应商密钥所在的 `.env`;不设则只从环境变量取 |
| `OMD_LITE_FALLBACK_MODEL` | `deepseek/deepseek-v4-flash` | `--fallback-model` 的缺省值 |
| `OMD_LITE_GUARD_BIN` | `scripts/dev/agent-guard/bin` | 目标仓内的执行体闸目录(拦 pkill / killall 等);存在才放到 PATH 最前 |
| `OMD_LITE_BRIEF` | `docs/process/executor-brief.md` | 目标仓内的执行者须知;存在才让 mcode 先读 |

mcode 执行器的环境里固定带 `UNTRUSTED_AGENT=1`,供目标仓的 git hook / 闸识别「这是不受信的执行体」;仓里没有对应 hook 时无害。

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

`omd-lite retro [--since YYYY-MM-DD] [label…]`:纯读 `~/.omd-lite/runs/*`,不改任何产物。分类与提案可交给上层 lead 模型(例如一个 `/retro` skill)接着做。

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
(实测:未跟踪的素材文件曾这样被 `--force` 一并删掉)。
大小用 `du -sb --exclude=node_modules`(node_modules 是 `cp -al` 硬链接,删了不腾空间)。

## 闸写法建议

- 全量测试一律经一个加锁的包装脚本(例:`scripts/dev/gate-vitest.sh` = `flock /tmp/<your-app>-vitest.lock npx vitest run --maxWorkers=12`):
  全机同一时刻只跑一份全量、限定 worker 数。不加锁时十几个 run 同时各跑满 worker 的全量，负载飙升，大部分 run 墙钟超时。
  有这道闸后，并发 run 数的上限看内存(每个 worktree 的 tsc / 测试峰值约 2 GB),不看执行方个数。
- **排队时间算在闸的 15 分钟超时里**(`ext/gate-loop.ts` 的 `GATE_TIMEOUT_MS`):N 个 run 同时等锁，最后一个约等 N × 单次全量耗时。
  同一时刻走到 vitest 闸的 run 超过约 12 个，就可能「排队超时」—— 回灌给模型的是「超时被杀」,它会误以为是自己的代码慢。并发到这个量级前先把超时放宽。

## 越界闸

任务书里有一行以 `允许改动:` 开头(逗号 / 顿号 / 空白分隔，目录按前缀)时，命令闸全过后再判一道「越界改动」:
相对 base 的改动(含未跟踪新文件)不在允许表里 → 这一轮算失败，越界清单回灌，让模型还原或停下说明理由。
豁免(首批约百个 slice 实测的越界全是这两类，验收判为正当):测试文件(`*.test.*` / `*.spec.*` / `test_*.py`)的新增与修改
(删除不豁免)· `index.*` 只新增 `export` 行。规则在 `ext/gate-loop.ts` 的 `outsideFiles()`。
测试:`node --test ext/outside.test.ts test/retro-gc.test.mjs`(retro / gc 用临时 HOME + 临时 git 仓跑真 CLI)。
没有该行 = 不判。`report` 的 `outside` 列读闸判的结果;老 run 没有就按允许表现算(不扣豁免)。

## 换模型重跑

主模型的最后一个 `agent_end` 以供应商报错收尾(pi 自己的重试用完)且闸一轮没判 → 用 `--fallback-model` 在**同一 worktree** 再跑一次，
提示它先看已有的部分改动。只换一次。实测触发过的两种:供应商 429 用量上限 · 流中途断开(`Stream ended without finish_reason`)。
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

- 软链的 node_modules 指向主仓库：工作区包(`node_modules/@x/pkg → packages/pkg`)解析到**主仓库**的源码，不是 worktree 的。
  切片若改 `packages/*` 而测试从别的包导入它，闸会测到旧代码。
- 模型的 bash 工具继承 pi 的环境，看得到 `.env` 里的密钥;产物只在本机 `~/.omd-lite`。
- `cost` 取自 pi 的 usage;models.json 没配价格的供应商(如 minimax-cp)显示 0。
- 闸在第一个失败处停，同一轮后面的闸不跑。

## 稀疏检出(可选)

大仓库里常有执行手用不到的存档目录(旧评审截图、调研资料)。`--sparse-exclude "docs/design/reviews,docs/reviews,docs/research"`(或环境变量 `OMD_LITE_SPARSE_EXCLUDE`)让 worktree 不检出它们:
- 被任务书「允许改动」、任务书正文、base 上 `scripts` / `docs/design/tests` / `apps` / `packages` 里写死的路径点名的子目录，按「被排除目录的下一级」自动加回;
- 执行手往没加回的目录写了文件，收尾时把那一级加回 sparse 定义，合并时 `git add` 不会拒收;
- `--full` 关掉;`omd-lite sparse-plan --repo R --base B --spec S` 只打印计划不建 worktree。

一个中型 monorepo 实测：每个 worktree 1301 MB → 392 MB,建 worktree 7 s → 2 s。
