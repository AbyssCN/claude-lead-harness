# S6a-1 · piw `--executor codex` + 非 pi 臂的闸经 wrapper 起(MiniMax 任务书)

**原始目标原文(owner 18.10 02:30,lead 转录于 myapp GOAL 改道账)**:「S6a codex 命令沙箱开网络(`-c sandbox_workspace_write.network_access=true`,bwrap + pasta 做唯一网络权威)」;bwrap-audit F9:「`runGate` 也走 `wrapped(wt, "bash", ["-lc", cmd])`,与 pi 臂的闸同在沙箱内」。
证据:myapp `docs/plan/10.17/s6a-codex-contract.md` 切片 1;myapp `docs/plan/10.17/bwrap-audit.md:55`(F9)。
执行者须知:myapp `docs/process/executor-brief.md`(收尾报告格式照它)。
依赖:无
期望值:无(GWT 里是命令行参数形状,不是算出来的数)
借的方法:豁免 -- 照既有 agy 执行器的形状加一条臂,无领域方法

允许改动:bin/piw test/piw-codex.test.mjs(新建) test/piw-exec-wrapper.test.mjs README.md

不许碰:pi 臂(`runPi` 与 pi 的 argv)· mcode / claude / agy 执行器函数体 · `ext/` · `prompts/` · `lib/`。不装依赖。测试不调真 codex、不打网络(执行体用替身,沿用 `test/fixtures/wrapper-stub.sh` 与现有 fixtures 的写法)。

## 对外签名

对外签名:CLI `--executor pi|mcode|claude|agy|codex`;meta 字段 `executor: "codex"`;run 目录文件 `codex-round-<n>.log` · `codex-round-<n>.last.md`。

## 设计裁定(写死)

1. `--executor` 多认一个值 `codex`;用法文案同步。
2. 新增 `codexExecutor()`,形状照 `agyExecutor()`:每轮 spawn 一次 `wrapped(wt, "codex", args)`,`cwd: wt`,stdin 为 `ignore`(等价 `</dev/null`)。`args` 依次为:
   `exec` `-s` `workspace-write` `-c` `sandbox_workspace_write.network_access=true` `-C` `<wt>` `--skip-git-repo-check` 〔有 model 时 `-m` `<model>`〕 `-o` `<dir>/codex-round-<n>.last.md` `<text>`。
   输出同时写终端和 `<dir>/codex-round-<n>.log`。不续会话:每轮新起一次，闸输出作为新提示词交给它(同 agy)。
3. 执行器分派:`["mcode", "claude", "agy", "codex"]` 都走 `runMcode` 闸循环;`meta.executor = "codex"`;用量记 0(同 agy)。
4. `--dry-run` 对 codex 打出 `executor: codex` 与第 1 轮 argv(同 claude / agy 的 dry-run 行)。
5. **F9**:`runGate(cmd, cwd)` 改为 spawn `wrapped(cwd, "bash", ["-lc", cmd])`。不给 `--exec-wrapper` 时 `wrapped` 原样返回，行为不变。只有非 pi 臂走 `runGate`;pi 臂的闸在 `ext/gate-loop.ts` 里，本来就在沙箱内，不碰。
6. README 里列执行器的地方加 codex 一行。

## 测试(先红后绿)

新文件 `test/piw-codex.test.mjs`(每条在 main 上红):
- codex 臂真跑一轮(执行体替身):wrapper 日志有一行，`--` 后依次是上面第 2 条的参数(`-m` 的值等于 `--model` 给的值);`meta.executor === "codex"`;run 目录里有 `codex-round-1.log`。
- `--dry-run --executor codex`:stdout 含 `executor: codex` 与 `network_access=true`。
- `--executor agy --exec-wrapper <stub> --gate "echo G1"` 跑一轮:wrapper 日志里有一行，`--` 后为 `bash` `-lc` `echo G1`。
- 不给 `--exec-wrapper`、`--executor agy --gate "exit 3"`:闸照常执行,run 判闸红(裸起行为不变)。

既有测试的断言不改。

## 成功判据

- `cd ~/repos/piw && node --test test/` 全绿。
- `git diff <base> --stat` 只含允许改动的文件。
