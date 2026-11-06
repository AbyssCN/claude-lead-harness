---
级别: L1
允许改动: bin/piw lib/piw.js test/retro-gc.test.mjs test/piw-ask-run.test.mjs test/fixtures/pi-stub.mjs
借的方法: 豁免
期望值已重算: 是
---
# L1 · `piw gc` 只认 piw 本体在跑 · `piw ask` 空回答算失败并记用量(MiniMax 任务书)

**原始目标原文(myapp `docs/plan/10.18/GOAL.md` 清单)**:「L1 `piw gc`「正在跑」判据只认 piw / omd-lite 本体或无 `end_epoch` 的 meta」·「L1 `piw ask` 空回答退非 0(18.10 MiniMax 判官静默返回 1 字节、退 0)· `piw ask` 进 quota-status 台账(19 次 sol 调用没记上)」
证据:myapp `docs/plan/TODO.md`「`piw gc`「正在跑」判据修」一条(改道账 18.10 01:40)。

允许改动:bin/piw lib/piw.js test/retro-gc.test.mjs test/piw-ask-run.test.mjs test/fixtures/pi-stub.mjs
阻塞于:无
借的方法:豁免 -- 进程判定与退出码,无领域方法
对外签名:`piw ask` 回答全空白时 stderr `PIW_FAIL empty <坐标>`、退 2(EXIT.exhausted);用量台账每次 ask 尝试多一行 `{"at","label":"ask:<role>","model":<坐标>,"arm":"ask","tokens":…}`;`piw gc` / `retro` 的命令行不变

## 设计裁定(写死)

1. **gc 判「正在跑」**:`bin/piw` 的 `hasProcess(procs, label, wt)` 只看命令行里含 `omd-lite` 或 `piw` 的进程;按 worktree 路径和按 `--name <label>` 两种匹配都只在这些进程里做。别的进程(比如另一个会话的 `bash -c 'echo <worktree 路径>'`)命令行里出现 worktree 路径,不算在跑。`isRunning` 的其余逻辑(meta 没有 `end_epoch` 且在墙钟上限内 → 在跑)不变。
2. **ask 空回答**:`lib/piw.js` 的 `ask` 在 `end.ok` 但 `end.text.trim() === ""` 时,这个坐标按失败处理:`tried` 里记 `{ coord, class: "empty", detail: "空回答" }`,`log` 一行,接着试下一个坐标,不设冷却。全部坐标都失败时照现有逻辑返回 `EXIT.exhausted`,最后一个是空回答就是 `failClass: "empty"`。
3. **ask 记用量**:`ask` 每试一个坐标(成功、失败、空回答都算),用 `appendUsage(env, row)` 写一行,`row = { at: <秒>, label: "ask:" + role, model: coord, arm: "ask", tokens }`。`tokens` 从 agent_end 末条 assistant 消息的 `usage` 里取 `input` · `output` · `cacheRead` · `cacheWrite`,`total` 取 `usage.totalTokens`,没有就取四项之和;末条没有 `usage` 时 `tokens: null`。写台账失败不许影响 ask 的结果(try/catch 吞掉,和 `bin/piw` 里 `appendUsage` 的现有写法一样)。需要的话 `parseAgentEnd` 多返回一个 `usage` 字段。
4. **不做**:不改 `quota-status`(它已经读 `~/.omd-lite/usage/*.jsonl`,新行会自动计入);不改 `run` 的执行臂;不改冷却规则。

## 测试(先红后绿,期望值 lead 已重算)

`test/retro-gc.test.mjs`(沿用文件里现有的临时 HOME + 临时 git 仓写法):
1. 一个 run:meta 有 `end_epoch`、分支已合进 base;`procs` 里只有一条 `bash -c 'echo <它的 worktree 路径>'` → `gc` 预览把它列为可清,不写「正在跑」。在 main 上红。
2. 同一个 run,`procs` 里有一条 `node /x/piw run --name <label> …` → 仍判「正在跑」。在 main 上绿,改完后也必须绿。

`procs` 要能注入:如果 `gcPlan` 现在从 `ps` 读,加一个只给测试用的环境变量(比如 `PIW_PROCS_FILE`,一行一条命令行),没设时行为不变。

`test/piw-ask-run.test.mjs`(用 `test/fixtures/pi-stub.mjs`;stub 要加一种 `empty` 行为:吐一个 `content: [{type:"text",text:"   "}]` 的 agent_end):
3. 角色链 `[A(empty), B(ok)]` → 退 0、stdout 是 B 的正文,stderr 含 `A` 失败(empty)。在 main 上红(main 会直接把空白当答案退 0)。
4. 角色链只有 `[A(empty)]` → 退 2,stderr 含 `PIW_FAIL empty A`。在 main 上红。
5. `PIW_USAGE_DIR=<临时目录>` 下跑 3 的场景 → 当天台账正好 2 行,`arm` 都是 `"ask"`,`label` 都是 `"ask:<角色名>"`,`model` 依次是 A、B。在 main 上红。

## 成功判据

- `node --test test/*.test.mjs` 全绿
- `git diff <base> --stat` 只含允许改动的文件
