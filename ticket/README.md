# ticket(单)

lead 开单、按单拉起独立 Claude Code 会话(单会话)的命令行。契约见 `docs/plan/2026-11-01-lead-ticket-sessions.md`(D-1…D-18,C-1…C-5)。

## 装法

全机一份,不走 `factory-install.mjs`:

```bash
ln -sfn <lead-harness>/ticket/bin/ticket.mjs ~/.local/bin/ticket
command -v ticket
```

要 Node ≥ 22 和 PATH 上的 `herdr`。lead 必须在 herdr pane 里跑(开单时取 `$HERDR_PANE_ID` 作叫醒地址)。

## 用法

```bash
# lead:开单,打印单号(如 t1101-07),在 lead 所在 workspace 新开一个 tab 起会话
ticket open --repo myapp --title "规则出口 R1" --origin "owner 原话…" --scope "只动 packages/engine" --accept "npm run typecheck"
# 按组放:--tab 前端 → 同名 tab 在就在里面分 pane,不在就以组名开 tab
ticket open --repo myapp --tab 前端 --title "…" --origin "…" --scope "…" --accept "…"

# 单会话:回报(五种状态叫醒 lead)/ 进度(不叫醒)
ticket report t1101-07 --status ready --summary "两家复核 SHIP" --artifact branch:agent/x@7edd03d51
ticket report t1101-07 --status needs-owner --summary "0451 迁移要不要先在 staging 跑" --question "先跑 staging?" --recommend "先跑"
ticket note t1101-07 "跑完第一轮闸"

# lead:看板、答复、收单
ticket board [--repo myapp] [--json]
ticket answer t1101-07 "先跑 staging"
ticket close t1101-07
```

## 退出码

| 码 | 意思 |
|---|---|
| 0 | 成功 |
| 2 | 参数错(用法错) |
| 4 | 状态转移不允许(C-3 的转移表) |
| 10 | 到并发上限 |
| 11 | 开 pane(`tab create`)失败 |
| 12 | agent 没起来 / `not_ready` |
| 13 | 投 prompt 被拒或卡住 |
| 14 | 锁忙:等不到别的进程放锁 |
| 15 | 记录读不出来(快照或事件流坏了) |

## 状态机(C-3)

`ticket report` 只许走这张表,其余(含 `ready → ready` 这种没变化的转移)退 4:

| 从 | 可以到 |
|---|---|
| `queued` | `working` |
| `working` | `ready` · `needs-lead` · `needs-owner` · `blocked` · `failed` |
| `ready` · `needs-lead` · `needs-owner` · `blocked` · `failed` | `working` |
| `closed` | (只有 `ticket answer` 能开回 `working`) |

`→ closed` 只有 `ticket close` 能走。

## 落点与环境变量

- 记录:`~/.local/share/owner-mods/tickets/<仓>/<单号>.json` + `<单号>.events.jsonl`;叫醒没投出去的进 `<仓>/outbox.jsonl`,下一次任何 `ticket` 命令先补发。
- 单会话的 pane 带 `TICKET_ID` 与 `TICKET_STORE`(该仓的记录目录)。
- `TICKET_ROOT` 换记录根目录(测试与冒烟用)· `TICKET_HERDR` 换 herdr 可执行文件(测试替身 `test/fake-herdr.mjs`)· `TICKET_MAX` 并发上限(默认 6)· `TICKET_START_TIMEOUT_MS`(默认 90000)· `TICKET_PROMPT_TIMEOUT_MS`(默认 60000)· `TICKET_CLOSE_TIMEOUT_MS`(默认 180000)。
- `TICKET_LOCK_STALE_MS` 锁残留判定(默认 90000,大于最坏一次 herdr 调用 75 秒 = prompt 超时 60 秒 + 15 秒余量)· `TICKET_LOCK_WAIT_MS` 等锁上限(默认 15000,超了退 14)· `TICKET_SENDING_STALE_MS` 补发中(.sending)多久算死进程的残留(默认 180000)。

## 与契约字面不同的地方(按 herdr 0.9.5 实测)

- 单号小写 `t<MMDD>-<NN>`:herdr agent 名只许 `[a-z][a-z0-9_-]{0,31}`。命令里写大写也认。序号全机连续(herdr 名在一台机器上唯一)。
- 开会话用 `herdr tab create --env …`(每单一个 tab,label 是单号),不 `pane split` lead 的 pane:6 张单都切 lead 的 pane 会把它切成窄条。`tab create` 同样能带 `--env`。
- 开场 prompt 用 `--wait --until working --until blocked`:默认的 `--wait` 要等到会话干完整件活才返回。
- 收尾:`close` 先等会话停下(`agent wait`),再让它用一条 `ticket note` 写收尾,取那条 note 作 `closing`;会话没写就记「会话没写收尾」照样关。
- `agent start` 返回后等 3 秒(`TICKET_SETTLE_MS`)再投开场:11.01 冒烟第一次紧跟着投,回 `agent_prompt_stalled`、会话停在 idle。
- O-7 实测(11.01):`pane close` 后同一个名字马上能给新会话用,`answer` 已收的单照原单号新开。
- 锁是 O_EXCL 锁文件(Node 没有 flock),持有者进程不在或持有超 90 秒视为残留;等锁超 15 秒退 14。
- 补发 outbox 时 herdr 不在锁里跑:锁内把 outbox 原子取走(改名成 `outbox.jsonl.sending`),锁外发,发不出去的写回 `outbox.jsonl`。记录读不出来的那条也留着(不丢),`ticket board` 会说有几条投不出去。
- 发送循环结束后 `.sending` 只留没投成功的那几条(全成功就留空文件,下次回收顺手删掉):投出去的条目留在里面,过了 `TICKET_SENDING_STALE_MS` 会被当成死进程的残留再投一遍,而且每次改名都刷新 mtime → 每 180 秒循环。每条发送前刷新 `.sending` 的 mtime,阈值量的是「距上次进展多久」。
- 快照或事件流坏了:`report` / `close` 退 15 并带单号报错,`ticket board` 出一行「记录坏了」,不当成「没这张单」。
- 测试:`node --test 'ticket/**/*.test.mjs'`(Node 24 的 `node --test <目录>` 不认目录)。真 herdr 冒烟 `TICKET_SMOKE=1 node --test ticket/bin/smoke.test.mjs`,只在 owner 的机器上手动跑。
