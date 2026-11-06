# F2b · piw 起片 · 每轮 · 每轮闸后各写一行事件(MiniMax 任务书)

**原始目标原文(owner 18.10)**:「F2 事件流 + trace.mjs」。
证据:myapp `docs/plan/10.18/f2-events-contract.md` 切片 2(INV-1 · INV-5)。`lib/events.mjs` 是 claude-mods `factory/lib/events.mjs`(`939896b`)的逐字副本,lead 已放进基线;**不许改它**。
执行者须知:限定边界,不规定做法;收尾写 omd-report 块。

允许改动:bin/piw test/piw-events.test.mjs (新建)
阻塞于:无
借的方法:豁免 -- 加观测写点,无领域方法
对外签名:`lib/events.mjs` 的 `appendEvent({ repo, run, phase, status, actor, evidence, ...extra })`(冻结,照用)

## 设计裁定(写死)

- `bin/piw` 用 `require("../lib/events.mjs").appendEvent`,三处写点:
  - `run` 写完首份 meta.json 后:`phase:'launch'`,`status:'start'`,`actor: meta.executor`,`evidence: <run 目录>/meta.json`,另带 `model` · `spec`。
  - 每轮执行体返回后:`phase:'round'`,`status: 'exit:<code>'`(`r.err` 时 `'err'`),`round`。
  - 每轮闸判完(写 gate-round 日志之后):`phase:'gate'`,`status:'pass'|'fail'`,`round`,`evidence: gate-round-<n>.log 路径`;fail 时另带 `failed_gate` 与(若有)`stuck`。
- `repo` = meta.repo,`run` = meta.label(run 名)。
- 写事件不改任何既有落盘、不改退出码;事件写失败不影响 run(events.mjs 已保证)。
- **不做**:不改 `lib/events.mjs`;不加 backfill(F2a 做)。

## 测试(先红后绿,期望值 lead 已重算)

`test/piw-events.test.mjs`:沿用 `test/` 里现成的替身执行体 / 临时仓做法(看 `piw-exec-wrapper.test.mjs` 怎么起替身 run),`FACTORY_EVENTS` 指临时文件,跑一片「第 1 轮闸红、第 2 轮闸绿」的替身 run:
1. 该 run 恰有 1 行 `launch`、2 行 `round`、2 行 `gate`,两行 gate 的 `status` 依次 `fail` `pass`,`round` 依次 1 2。在 main 上红。
2. 每行都含 `ts repo run phase status actor evidence` 七键。
3. `FACTORY_EVENTS=/proc/none/x` 时 run 仍正常结束、result.json 照写。

## 成功判据

- `node --test test/` 全绿
- `git diff <base> --stat` 只含允许改动的文件
