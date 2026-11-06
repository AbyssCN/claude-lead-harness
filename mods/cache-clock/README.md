# cache-clock(缓存钟)

每次主会话回复后,在输入框上方倒数到 prompt cache 变冷。底子是 benai 的 cache-clock,并入了 cache-tax 里有用的几样;装它就停用 cache-tax。

- **倒数横条**:剩余时间、缓存时长出处(`bin/ttl.py` 从会话日志读 1h / 5m)、现在回复的读价和冷了重写的写价(按主模型牌价估,表在 `hooks/register.tsx` 的 `PRICES`,不是账单)。
- **冷了**:横条变蓝,报重写价;上下文 ≥ 150k 时给「交接到新会话」按钮,只把 `/relay go` 填进输入框,回车才交接。
- **冷发拦截**:缓存冷了、上下文 ≥ 50k 时,人在输入框或手机上发的第一条消息先拦下并报价,再发一次照付。后台续跑、定时任务、插件发的不拦。`/cacheclock guard refuse|warn|off` 切换,默认 refuse。
- **保温**:只在按「保温」按钮或输入 `/keepwarm` 时开,变冷前 45 秒发一个后台小 ping(`$.model.fork`,不写 transcript)。默认 2 小时窗口,`/keepwarm 90m` 自定(上限 8 小时),30 次 ping、连续 3 次失败、或你发消息就停。横条上写累计花费。不会自动开。
- **压缩**后旧钟作废,等下一次回复。

命令:`/cacheclock`(显示 / 隐藏,隐藏跨会话记住)· `/cacheclock status`(明细 + 本会话冷写笔数与金额)· `/cacheclock demo|auto`(60 秒演示缓存)· `/keepwarm [时长|off]`。

开关走 Switchboard(`/mods`,改 settings.json 的 enabledPlugins),本 mod 不读 `~/.claude/mods/switches.json`。日志 `~/.claude/mods-logs/cache-clock.log`。

测试:`claude plugin test cache-clock`。

## 停手提醒(缓存 v2)

「停手」是三件事同时成立：主对话没有一轮在跑(保温 ping 那轮不算)、`$.agent.list()` 没有在跑的子 agent 或后台 shell、`$.delegate.runs()` 没有 `running`。任何一项读不到都按在干活，不提醒。

- 一轮在跑：横条只画一个绿点 `●`。
- 停手满 5 分钟：出一次提醒「你 5 分钟没动」,带 [保温 2h] 和 [先不];发消息、点保温或点「先不」就收起，同一段停手不再出。
- 保温自己停了(窗口到、ping 满、连续失败):[再保温] [一键交接]。
- 缓存冷了:[一键交接 ≈$0]。

「一键交接」直接跑 `/relay coldhandoff`(也可 `/cacheclock handoff`),交接本身由 relay 做；从起跑到 continuity 的 checkpoint 写出来(最多 10 分钟),横条显示「写交接中…」。`/cacheclock skip` 等于点「先不」。`$.cacheClock.state()` 多了 `idleSince` 和 `nudge`,以及选读的 `tokens`、`coldUsd`、`maxPings`、`stopped`(保温停的短句)、`handoffSince`、`warm.usd`;board 开着时由 board 画这些按钮(点按钮跑上面这些命令)。
