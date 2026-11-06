# cue(提词)

主 session 每回答完一条(≥ 80 字),cue 让同一个模型 fork 一次,站在你的位置写好**下一条完整 prompt**:要什么 · 关键事实 · 边界 · 判据 · 停在哪回什么。默认只给一条;回答停在真岔口时才多给一条「方向 B」。终端里 cue 只往输入框写草稿,**不替你发送**;手机上(Remote)改成弹窗,**只有你按了「发送」(或在 Other 里写了改后的文字)才发送**。

## 按键

- 输入框为空时按 `1`,或点 **Enhance · 标题**:把整条 prompt 写进输入框(覆盖),改完自己回车。
- `2`:方向 B(只在真岔口出现)。
- 按数字只在输入框为空时生效;输入框里有字时,数字会被当成普通输入。
- `/enhance 粗稿`:把跟在命令后面的粗稿改写成完整结构,写回输入框,不发送;只打 `/enhance` 时改写输入框里的字,输入框为空时等于按 `1`。
- `/cue stats`:累计生成次数、各类 token 合计与平均、按 1/2/enhance 的次数、发出时原样/改写/弃用的比例、手机弹窗的发送 / 方向 B / 改写 / 放弃 / 被新消息顶掉次数。

relay 自动续跑(`relay.mode === 'running'`)期间不生成、不出按钮;没装 relay 时当作空闲。

## 手机弹窗

终端上方那排按钮画在 `AbovePrompt` 里,引擎只在终端和桌面端画它,手机上看不到。所以有手机挂着时,cue 生成完会弹引擎自己的 AskUserQuestion 对话框(每个挂着的表面都会画):

- 正文是那条 prompt;有方向 B 时两条都在。单条超过 700 字时正文截断,全文先写进对话(不发给模型),往上滑就能读到。
- 「发送」:原样发出(以你的身份发,模型读到的就是这段话;以 `/` 开头的会当 slash 命令运行)。
- 「方向 B」(只在有第二条时出现):发第二条。
- Other:在里面改写,发你改后的文字。
- 「放弃」或关掉对话框:什么都不发,记一次放弃。
- 对话框开着的时候你另发了新消息:之后不管怎么答都不再发,记一次「被新消息顶掉」。
- 同一时间只开一个对话框。开着时又生成了新 cue,新的排队(只留最新一条);你答旧的那张时按「发送 / 方向 B」不再发(已过时,记「被新消息顶掉」),接着弹最新那张。Other 里写的是你自己的话,照发。
- 不是你发起的一轮(delegate 叫醒、后台任务回执):cue 默认不给,只在回答停下等你拍板、或一个阶段到头要定下一阶段方向时给 1 条。

relay 自动续跑期间不生成,自然也不弹。终端上的按钮照旧出现(两边都挂着时,桌前也能直接按按钮)。

## 不让确认框把会话停住(t1102-07)

不是你发起的一轮(lead 消息、delegate 叫醒、后台回执、cue 自己代发的),草稿出来后先过两道检查再决定去哪:

- **核现状**:拿磁盘上的东西核一遍草稿还成不成立。核的是:该仓决策账末 80 行(`docs/plan/` 下最新的 `GOAL.md`)、`~/.omd-lite/rulings.json` 最近 40 条、`ticket board --repo <仓>`、`git log main -30`、`~/.claude/relay/待owner-<仓>.md` 末 80 行、本会话最后一条回答。由 haiku 判,判「已过时」必须原样引出证据里的一行。
- **敏感三类**:钱 · 生产数据 · 你的登录。先按关键词(`hooks/vet.ts` 的 `SENSITIVE_WORDS`),没中再让 haiku 判,判不准算敏感。

然后:

- 已过时,或者核不了(模型没回话、引的行找不到):作废,不弹也不进按钮,对话里记一行「作废 · 理由 · 证据」。
- 敏感:不开确认框。记进 `~/.claude/relay/待owner-<仓>.md`(relay 的 `- [ ] #n` 格式),经发件箱发到你手机,终端按钮照留。要发就在那个会话里打 `/cue send`;`/cue held` 看还有哪些等着。你自己敲的那一轮,草稿敏感也一样不开框。
- 其余:照旧弹框,5 分钟没人点就自动发第一条,记「自动发送」。连着自动发了 3 次、中间没有别的消息进来,第 4 条作废,会话停下等人。
- 你自己敲的那一轮(终端敲字或手机发的)且不敏感:照旧弹框,不自动发。

`/cue stats` 末尾一行是这几种去向的次数。

## 读数:有没有会话卡在确认框里

`bin/cue-stuck-scan.ts` 每 5 分钟跑一次(`systemd/cue-stuck-scan.timer`):扫 `herdr agent list`,对 blocked 的 pane 读屏,「☐ cue」和「发送吗?」同时出现就算开着一个 cue 框。每个 pane + 标题记首次看到的时刻,赫尔辛基 08:00–22:00 里开着超过 10 分钟记一次「卡住」,同一拍卡住的合成一条进发件箱。每拍一行写进 `~/.omd-lite/readings/cue-stuck.jsonl`;herdr 读不出来的那拍记 `unreadable` 并退 1,不记 0。当天的数:`node cue/bin/cue-stuck-scan.ts --summary [YYYY-MM-DD]`。

装法:

```bash
ln -sf <lead-harness>/cue/systemd/cue-stuck-scan.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now cue-stuck-scan.timer
```

测试:`claude plugin test cue`(插件)· `node --test cue/cue.test.ts`(读数与核现状的纯函数,今天 5 条草稿的夹具在 `test/fixtures/2026-11-02/`)。同一个 `cue.test.ts` 两边都跑:`cue/package.json` 把 `claude-code/testing` 指到 `test/node-kit.mjs`。

## 设置

- `engine`:`fork`(默认,主模型带完整上下文,上下文走主线缓存)· `haiku`(只看最后一条回答,便宜但浅)· `off`(回答后不自动生成,`/enhance` 仍可用)。
- `minChars`:回答短于此字符数不生成,默认 80。
- `popup`:`auto`(默认,有手机挂着才弹窗;只有终端时不弹,不抢桌前的键盘)· `always`(总是弹)· `off`(从不弹)。
- `outbox`:敏感草稿发手机用的命令(JSON 数组,stdin 每行 `{dedupKey,text,kind}`),默认 rcmux 的 `freezewatch-outbox.ts enqueue`;`[]` 不发。

## 提词方法

两段提示的结构与取舍依据见 `docs/methodology-2026-10-15.md`(对照 pstack 与 mattpocock/skills)。

## 成本

fork 每次都会重发主线最近一次请求的全部上下文,这部分走缓存读,另外加上 cue 自己那段提示和输出(不走缓存)。每次的 usage 都记在 `$.store`,用 `/cue stats` 查看。如果太贵,把 `engine` 设为 `off`,只在需要时用 `/enhance`(SDD O-5)。
