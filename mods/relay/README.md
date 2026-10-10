# relay(接力)

> Keeps a lead Claude Code session running toward a written GOAL until its acceptance commands pass, with phase-based effort, auto-handoff across /clear, and an /ops overview.

lead session 的续跑与停机:定好终点,一直跑到验收命令全过,或者碰到真正要 owner 拍板的岔口才停。文中 D-x / C-x / INV-x 是设计契约里的条目编号,代码注释沿用。

## 用法

- `/goal <一句话>`:把这句话加上仓库上下文(CLAUDE.md、_NEXT.md、docs/plan/TODO.md、上一份 GOAL)写成 `docs/plan/<MM.DD>/GOAL.md`(已存在就写 `GOAL-2.md`),写完立刻激活并发第一条开工 prompt。`/goal` 不带参数看状态,`/goal clear` 停。它替掉 Claude Code 自带的 `/goal`。
- `/relay status | stop | resume | open`:看状态 / 停 / 续跑 / 开 GOAL 面板。
- `/ops`:待拍板事项(`docs/plan/DECISIONS-PENDING.md` 未关闭行 + 最新 GOAL 的 §9)、worktree、在跑的 omd-lite run、磁盘余量。

## lead 每轮最后一行(C-2)

```
RELAY: continue phase=<plan|build|review|chore|wait>
RELAY: done
RELAY: owner <一句问题>
RELAY: replan <原因> -> <新项>
```

- continue:马上发「按 GOAL 继续」。`phase=wait` 不发,挂 `heartbeatMinutes` 心跳;如果在跑的 omd-lite run 和子 agent 都是 0 个,直接回推「wait 不成立」。
- done:relay 自己逐条跑「验收」里的命令,全过才停并通知;有一条没过,就把那条命令和输出末尾 40 行推回去。
- owner:停下通知,不替 owner 回答;owner 回一句话就接着跑。
- replan:往「改道账」追加一行,然后接着跑。
- 没写 RELAY 行,或者停在问句、选项上:第一次推回一条提醒,连续第二次就停下通知。同一 phase 同一项连续 3 轮没有新提交算卡住,也停;每个 GOAL 最多跑 `maxTurns` 轮。

## effort

`turn.step` 按 GOAL 的 effort 表给主线切 effort(默认 plan=xhigh · build=medium · review=high · chore=low),只在自动续跑时切。子 agent 按 `subagentEffort` 配置的类型映射来切。每次切换后,下一次请求的 `cache_read_input_tokens` 记进 `$.store` 的 `effortSwitches`,只记录不拦。

## 交接

上下文到 `thresholdTokens` 时让 lead 写交接(`~/.claude/handoffs/<仓>-<session>.md`),等它回 `HANDOFF-READY`,`delaySeconds` 内可以取消;子 agent 没回来不 clear。配了 `checkpointCommand` 时 clear 之前先同步补存一次 checkpoint(会去 `~/.omd/projects/*/session/<id>/checkpoint.md` 找),clear 后发续接 prompt。续接 prompt 里一定带上激活中的 GOAL 路径和 phase,新 session 里 relay 照样自动续跑。

## 状态

`$.state` 的 `relay.mode`(`idle | running | waiting-owner | done`)给 cue 读。GOAL 路径、phase 和计数器同时存进 `$.store` 的 `goal:<cwd>`:同一个 session 重启后自动接上;换了 session,用 `/relay resume` 接着跑。

## 配置(plugin userConfig)

| 选项 | 默认 | 说明 |
|---|---|---|
| `thresholdTokens` | 500000 | 上下文到这个量开始交接;0 关闭 |
| `delaySeconds` | 30 | 交接写好后多久自动 /clear,期间发消息即取消 |
| `heartbeatMinutes` | 25 | `phase=wait` 后的心跳间隔 |
| `maxTurns` | 200 | 每个 GOAL 自动续跑轮数上限 |
| `subagentEffort` | 空 | 子 agent 按类型切 effort,如 `Explore=low, Plan=high` |
| `reposDir` | 空 = `~/repos` | 放仓和 worktree 的目录;会话在其下时以 `<reposDir>/<仓名>` 为仓根,否则以 cwd 为仓根 |
| `worktreePrefixes` | `omdl-,agent-` | `reposDir` 下按前缀认出派发脚本留下的 worktree(另外还列每个仓的 `.claude/worktrees/*`) |
| `diskPath` | 空 = 仓根 | `df` 查余量的路径 |
| `diskMinGB` | 50 | 余量低于它提醒一次;0 关闭 |
| `checkpointCommand` | 空 | clear 前补存 checkpoint 的命令,`{transcript}` `{session}` 会被替换;空 = 不补存 |

## 安装

```
/plugin marketplace add AbyssCN/claude-lead-harness
/plugin install relay@claude-lead-harness
```
