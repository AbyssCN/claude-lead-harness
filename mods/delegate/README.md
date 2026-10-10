# delegate

> The lead's cockpit for external omd-lite runs: lists this session's runs, guards launches, queues gates by free memory, wakes the lead when runs end, and cleans merged worktrees.

lead 的外部 run 驾驶舱。确定性 harness:**不切片、不写任务书、不选执行器**(D-1)。文中 D-x / C-x / INV-x / GWT-x 是设计契约里的条目编号,代码注释沿用。

## 做什么

- **`$.delegate.runs()`**(C-0,类型 `types/index.d.ts`):本会话起的 omd-lite run。`bin/scan.mjs` 读 `~/.omd-lite/runs/<label>/`;
  结束 = `meta.json.wall_seconds` 有值(D-8,`result.json` 会先出);没 result 且 driver 已死 = `interrupted`;
  `failureClass` 取自 result.json 与末个 pi `agent_end` / mcode `exec.completed`(429 / 529 / 2056 / 5xx / 断流 → `provider`)。
  有 run 在跑每 2 s 扫一次,否则 10 s;提到 omd-lite / omdl- 的 Bash 调用后立即再扫。
- **叫醒**(GWT-15):run 结束 → 60 s 窗口内合成**一条** `$.prompt.submit`(没有 run 还在跑就立即发):label · state · 轮数 · failureClass · diffstat · 越界 · 闸日志末 20 行;
  provider 失败不附闸日志,只说「换供应商或等窗口,不要回灌给执行方」(INV-8)。
- **launch 守卫**(Bash 的 `omd-lite run …` 或仓配置的 launch 脚本):任务书缺「原始目标原文」/「允许改动:」/「## 成功判据」、允许改动里的路径不存在又没标(新建)、
  与在跑 run 的允许改动重叠、距上次 launch 不足 `launchSpacingSeconds`、`omdl-*` 超 `diskBudgetGB` 或盘余 < `minFreeGB` → deny 并逐条说明。**不设并发上限**(D-16)。
- **闸槽**(C-5):放行时把每个 `--gate <cmd>` 改写成 `--gate "<mod>/bin/gate-slot.sh '<cmd>'"`;槽数 = max(1, ⌊(MemAvailable − 8 GB) ÷ 2 GB⌋),flock 排队。
- **合并后清理**(D-17 ②):`git merge … omdl/<label>` 或仓配置的 merge 脚本成功后,确认分支已进 HEAD、worktree 干净且没有非缓存的被忽略文件,再跑 `<omdLitePath> clean <label>`(gc 不支持按 run 限定)。
- **`/runs`**:只读表。

## 仓配置 `.claude/delegate.json`(可选,放在会话 cwd)

```json
{
  "launch": "scripts/dev/omdl-launch.sh",
  "launchArgs": ["name", "base", "spec", "gate..."],
  "merge": "scripts/dev/omdl-merge.sh",
  "gate": "scripts/dev/gate-slice.sh main",
  "envFile": "/path/to/app.env",
  "executor": "pi",
  "model": "<provider>/<model>",
  "fullGates": "final",
  "sliceGate": "scripts/dev/gate-slice.sh",
  "layerGates": [
    { "pattern": "^db/migrations/", "cmd": "bash db/ci/replay-local.sh" },
    { "pattern": "(^|/)package(-lock)?\\.json$", "cmd": "npm run build" },
    { "pattern": "\\.css$|^src/components/ui/", "cmd": "npm run check:design" }
  ],
  "fullGatesSummary": "/tmp/full-gates-{sha}/summary.txt",
  "measure": ["perf-gate\\.sh"]
}
```

没有配置 = 只认 `omd-lite run`。

D-18 三级闸门(四项都写才启用,缺哪项哪部分不生效):
- **批合并后**:`merge` 命令成功后,工具结果里追加一段提醒:`<sliceGate> <批前 sha>`(这批改动合集的组合片闸)+ 合集命中的 `layerGates`。同一批的后续合并沿用第一片合并前的 sha。
- **清账**:跑 `<sliceGate> <批前 sha>` 且命令没报错 → 这批清账,下一次合并重新记批前 sha。以日志判红绿,mod 只看命令有没有出错。
- **独占量测前**:命令命中 `measure` 正则 → 读 `fullGatesSummary`(`{sha}` = `git rev-parse --short HEAD`);文件不在或有任何一行 `rc≠0` → 拦下并点名红的那道。`executor` / `model` / `gate` / `envFile` 只在 `omd-lite run` 缺对应参数时补上。

## 配置(plugin userConfig)

| 选项 | 默认 | 说明 |
|---|---|---|
| `launchSpacingSeconds` | 10 | 两次 launch 之间最少间隔;0 = 不限 |
| `diskBudgetGB` | 40 | 仓库旁 `omdl-*` worktree 总量上限 |
| `minFreeGB` | 50 | 仓库所在盘最少余量 |
| `omdLitePath` | `omd-lite` | 合并后清理用的 CLI:命令名(走 PATH)、绝对路径或 `~/` 开头 |

闸槽可用环境变量调:`DELEGATE_GATE_SLOTS`(强制槽数)· `DELEGATE_GATE_RESERVE_GB`(默认 8)· `DELEGATE_GATE_PER_GB`(默认 2)· `DELEGATE_GATE_SLOT_DIR`(默认 `/tmp/delegate-gate-slots`)。

## 校验

```bash
claude plugin validate delegate && claude plugin test delegate
node --test delegate/bin/scan.test.mjs
bash delegate/bin/gate-slot.test.sh
```

## 安装

```
/plugin marketplace add AbyssCN/claude-lead-harness
/plugin install delegate@claude-lead-harness
```
