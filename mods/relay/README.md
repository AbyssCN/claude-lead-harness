# relay(接力)

取代 auto-handoff。lead session 的续跑与停机:定好终点,一直跑到验收命令全过,或者碰到真正要 owner 拍板的岔口才停。契约见 `docs/plan/2026-10-10-lead-harness.md`(D-3/D-10…D-24,C-1/C-2/C-4)。

## 用法

- `/goal <一句话>`:把这句话加上仓库上下文(CLAUDE.md、_NEXT.md、docs/plan/TODO.md、上一份 GOAL)写成 `docs/plan/<MM.DD>/GOAL.md`(已存在就写 `GOAL-2.md`),写完立刻激活并发第一条开工 prompt;写好时正有一轮在跑(插件的 prompt 只能等空闲),激活 note 改为跟在这一轮下一次工具调用的结果后面,并告诉 lead 别自己再写 GOAL.md,这一轮到结束都没再调工具才另发开工 prompt。`/goal` 不带参数看状态,`/goal clear` 停。它替掉 Claude Code 自带的 `/goal`。
- `/relay status | stop | resume | open | go`:看状态 / 停 / 续跑 / 开 GOAL 面板 / 交接并清空(见「交接」)。`/relay resume force`:属主还活着也接管(见「属主与复活」)。
- `/handoff`:写一份可分享的交接 prompt,不清空会话(见「可分享的交接」)。
- `/ops`:待拍板事项、worktree、在跑的 MiniMax 片、D 盘余量(沿用 auto-handoff)。

## lead 每轮最后一行(C-2)

```
RELAY: continue phase=<plan|build|review|chore|wait>
RELAY: done
RELAY: owner <一句问题> | 推荐: <推荐>
RELAY: replan <原因> -> <新项>
```

- continue:马上发「按 GOAL 继续」。`phase=wait` 不发,挂 25 分钟心跳;如果在跑的 omd-lite run 和子 agent 都是 0 个,直接回推「wait 不成立」。
- done:relay 自己逐条跑「验收」里的命令,全过才停并通知;有一条没过,就把那条命令和输出末尾 40 行推回去。
- owner:不停。问题连推荐挂进 GOAL 文末的「待 owner」节,它挡住的清单项打 `⏸#n`,接着做下一项;清单里没挂起的项都做完了才停,通知里是「待 owner」汇总,每件带推荐。验收全过时的通知也带上没答的那些。
- replan:往「改道账」追加一行,然后接着跑。
- 没写 RELAY 行,或者停在问句、选项上:第一次推回一条提醒;提醒后还停在同一类真问题上,当 owner 挂单(「要不要继续」不挂);连续第二次没有 RELAY 行就停下通知。同一个已挂单的问题再问,照样挡住当前项、做下一项;只有挡不住(「清单」里找不到这一行)才停。owner 回复时 relay 提醒 lead 把答了的「待 owner」项勾成 [x],被挡的项自动回到清单。同一 phase 同一项连续 3 轮没有新提交算卡住,跳过它挂单、做下一项,没有下一项才停;每个 GOAL 最多跑 `maxTurns` 轮。

## 属主与复活(0.8.0)

契约 `docs/plan/2026-10-23-relay-orphan-goal.md`。一份 GOAL 同一时刻只有一个属主进程在推,认领、判活、fencing 都经 `bin/owner.mjs`(按 cwd 的 flock),relay 只调它的子命令、看退出码。

- **属主 pid**:relay 用 `$.process.run(['sh', '-c', 'echo $PPID'])` 拿,也就是起这个子进程的 Claude Code 进程;10.23 在 2.1.309 上实测,它就是 `~/.claude/sessions/<pid>.json` 里 sessionId 对得上的那个 pid,relay 自己 /clear 以后不变。
- **认领**:`/goal` 激活、`/relay resume` 都 `claim`。属主是另一个活着的进程就不发 prompt,回一句提示;`/relay resume force` 带 `--force` 接管。新写的 GOAL 被拒时只留在本 session,`/relay resume force` 接管的就是它。
- **resume 拒 done**:GOAL 已验收通过(done),`/relay resume` 不续,提示用 `/goal` 开新的。
- **fencing**:有 GOAL 在跑或在等 owner 时,每发一条 `[relay]` prompt 之前先 `set --pid <自己>`;退 3(属主已换人)就不发,本 session 改成 idle 并通知。
- **复活**:session.start 时 store 里的 GOAL 是 running / waiting-owner、记录里的 sessionId 就是这个 session,而 `check` 说属主不是自己、已经不在(或者没有记录),就 `claim --revive`,成了恰好发一条续跑 prompt(note `属主进程断了，已复活。`)。属主是另一个活进程:不发,toast 加通知。一小时内第 4 次(退 5):不复活,通知后停手。
- **waiting-owner 复活**:续跑 prompt 要求这一轮只重新挂单、不改文件、不提交、末行写 `RELAY: owner …`。这一轮答完 relay 不写 GOAL、不挂单、不再续跑,只核对三件:末行以 `RELAY: owner` 开头;`git rev-parse HEAD` 和复活时一样;GOAL 里带 `⏸` 的行逐字一样。有一件不对就通知「复活那一轮越界」。
- **推送**:复活认领成功后通知一条(GOAL 标题、断开时刻、复活时刻,本地 HH:MM;断开时刻取属主记录的最后一轮时刻);running 复活后第一轮答完再通知一条「推进」和 `git rev-list <复活时的 HEAD>..HEAD --count`;waiting-owner 复活只有第一条,写「仍在等你:#n …」。
- **owner.log 的 `mode` 行**:每改一次 GOAL 的 mode 都调 `owner.mjs mode`,原因取契约那 15 个之一(`goal` · `continue` · `owner-parked` · `done-accepted` · `no-relay-line-twice` · `stuck` · `max-turns` · `goal-clear` · `relay-stop` · `owner-clear` · `resume` · `revive` · `fence` · `relay-clear`;`done-failed` 不写，验收没过时 mode 不变);relay 自己 /clear 以后写一行 `relay-clear`,带 `--old-sid`。写不进(退 1)只 toast 一行,不挡续跑。

## 没有 GOAL 时的空等兜底

没开 GOAL 的会话,一轮不是 owner 推的(delegate 叫醒 · 后台回执 · /loop · 定时),回答却停在问 owner 上:relay 推回一条提醒,让 lead 技术岔口自己定、战略岔口写 `RELAY: owner … | 推荐: …`。提醒后还在问,就把问句记进 `~/.claude/relay/待owner-<仓名>.md` 并通知,不再催;之后同一夜冒出的新问题直接记进去,同一问题不重复记、不重复通知;owner 敲字后重新从提醒开始。GOAL 在跑或停在等 owner 时,兜底不动,问题进 GOAL 自己的「待 owner」节。`RELAY: owner` 也记进这个文件。判「停在问 owner 上」的规则在 `hooks/asks.ts`,和判官共用。

## 空转判官

`node bin/stall-scan.mjs [--since ISO] [--until ISO] [--gap 15] [文件或目录 …]`:读会话记录,点名不是 owner 推的一轮停在问他上、之后超过 15 分钟没动静的地方,以及早上 owner 第一条消息(他最长一段沉默之后那条)之前的空等。时间是 UTC。

## 交接判官

`node bin/handoff-audit.mjs [--since ISO] [--until ISO] [--json] [目录或文件 …]`:零模型,读 `~/.claude/projects/-home-owner-repos-*`(不含 worktree)里有 owner 发过消息的会话,出四个数:① 每个会话 `cache_read_input_tokens` > 400k 的请求数(判据 ≤ 20)和 > 550k 的(判据 0),`compact_boundary` 次数(判据 0);② 轮中冲高(< 400k 开轮、轮内 > 550k);③ 每次 armed 的去向 —— cleared · owner 说话取消(35 分钟内说的才算)· 卡着 · 未满 35 分,GOAL 期间 35 分内 cleared 的比例(判据 ≥ 95%)与卡着条数(判据 0);④ 每次 clear 后,新会话第一轮回答是否逐字含 owner 清空前最后一条和它之后每一轮的回答(比原文,不比摘要);⑤ /goal:`/goal` 到 GOAL.md 落盘 p90 ≤ 90 秒、落盘到 lead 收到激活 ≤ 30 秒、lead 自己 Write 覆盖 0 次、写出的 GOAL 没有模板提示和「(待补:」(落盘时刻、走 fork 还是 complete、秒数、输入大小读 relay 每次 `/goal` 在 handoff.log 记的 `goal` 行)。有判据没到退出码 1。`--sessions id8,…` 只量这些会话和它们续接出来的会话。

每日一跑:systemd 用户定时器 `relay-handoff-audit.timer`(06:47)调 `bin/handoff-audit-daily.mjs`。它从 `~/.claude/handoffs/handoff.log` 的 `start relay <版本>` 行(relay 每个 session 开头记一行;开着的窗口不会自己换版本)取 ≥ 0.6.0 的会话,并进 `~/.local/share/owner-mods/relay/audit/sessions.txt`,交给判官(`--since 2026-10-23T02:18:00Z --sessions …`);当天读数写 `<日期>.json`,一行进 `daily.jsonl`。判据没到就在 claude-mods 里起一个 headless lead(`claude -p`,日志 `lead-<日期>.log`,结论记 `lead.md`)接着改;上一个还在跑就不起第二个;还没有新版会话记 no-data。

## effort

`turn.step` 按 GOAL 的 effort 表给主线切 effort(默认 plan=xhigh · build=medium · review=high · chore=low),只在自动续跑时切。子 agent 按 `subagentEffort` 配置的类型映射来切。每次切换后,下一次请求的 `cache_read_input_tokens` 记进 `$.store` 的 `effortSwitches`,只记录不拦。

## 交接

**有没有 GOAL、人在不在,都在阈值自动清空**(23.10 起;21.10 的「平时只提醒」之后 8 个会话过了 400k 还在跑,峰值 965k,`/relay go` 一次没敲过)。

- **GOAL / 定时期间**(本 session 在跑的 GOAL,`running` 或 `waiting-owner`,GOAL 记录的 session id 就是这个 session;或定时任务 / `/loop` 起的一轮):上下文到 `thresholdTokens` 后,交接 note 跟在下一条**不是 owner 发的**干活 prompt 上(relay 续跑、delegate 叫醒、后台回执、定时);owner 自己发的那一轮不注入。lead 写完回 `HANDOFF-READY`,`delaySeconds`(30 秒)后自动 `/clear`;期间 owner 发任何消息即取消。
- **平时(没有 GOAL)**:一轮答完时上下文到阈值,再等 `delaySeconds`(30 秒)—— 期间没有任何 prompt(owner 的、回执、叫醒都算)、也没有一轮在跑 —— relay 自己提交一轮交接 prompt,写完立即 `/clear`(已经等过 30 秒)。等的时候来了任何 prompt 就作废,那一轮答完再从头等 30 秒;交接写的过程中 owner 说话就取消,他那一轮答完照样再等 30 秒。`/relay go` 照旧可用,写完立即清。
- **谁算 owner**:键盘(`composer`)、手机(`bridge`),和 cue 发的(cue 只在他按「发送」时才发)。20.10 bcda069e:READY 时子 agent 已全部完成,挡住 clear 的是他经 cue 发的消息 —— relay 当时不认它是 owner,既不取消、也不换锚点,只当「有一轮在跑」,等了两小时。

**锚点。** 交接第一行必须是 `relay-anchor: <owner 最后一条消息的 FNV-1a 64 前 12 位>`。`HANDOFF-READY` 时 relay 用当时 owner 的最后一条重算:对不上,自动交接说明 owner 中途说过话,退回空闲(人在,不清);`/relay go` 的交接带 owner 原话回推重写一次,第二次还对不上就停下通知。真正 `/clear` 之前再算一次,等待和补存 checkpoint 期间 owner 说过话就挡住。等 clear 时 GOAL 停了(`RELAY: done` 验收过、`/goal clear`、`maxTurns` 到顶),不清,降为提醒。

**原文旁车。** relay 自己记 owner 最后一条消息原文,和之后他没回应的回答原文(全部,owner 一说话就清空;relay 自己提交的交接那一轮的回答不记)。`/clear` 前写 `~/.claude/handoffs/<仓>-<id8>.last.md`:这两样原文,加 clear 时刻在跑的东西 —— 子 agent(id · 类型 · 描述 · Agent 调用的任务原文,读不到就只写描述)、后台 shell / Monitor(id · 命令原文)、本 session 的 MiniMax run。续接 prompt 整块内联这块原文,不截断,**新会话第一件事是把它原样贴给 owner**,列「等用户拍板」降为第二件事。自动清空(GOAL 期间和平时都算)时另发一次 `$.ui.notify`(最后一条回答前 200 字 + 旁车路径),并让新会话用 SendUserFile 把旁车文件发给 owner;`/relay go` 时 owner 就在屏幕前,不推。owner 自己手敲 `/clear` 不写旁车。

**子 agent。** 「在不在跑」以引擎的 `$.agent.list()`(pending / running;`waiting` 不算 —— 结果已交回、只剩自己留下的后台活的子 agent 会一直 waiting)为准,SubagentStart/Stop 账只在读不到时兜底 —— 10.11 一个 Stop 没来的 id 让交接卡了 4 小时。有子 agent 在跑就不清,它们回来后要求把结果并进交接重写;等满 30 分钟放弃。被挡住、放弃时除 toast 外再发 `$.ui.notify`(手机上看不到 toast)。后台 shell / Monitor 不挡(clear 后它们还在),写进旁车和交接。交接 note 把 relay 看到的子 agent 和后台任务逐条列出,要求写进第 3 节。

`/relay status` 末行显示交接阶段(`idle · due · armed · ready`)与在跑子 agent 数。clear 之前先补存一次 continuity checkpoint(经 `$.continuity.flushStart` 后台起 writer,轮询 checkpoint 的 mtime,最多等 10 分钟;continuity 没装或 flushStart 拒绝就用上一份,handoff.log 记 `checkpoint=old`),clear 后发续接 prompt;续接 prompt 一定带上激活中的 GOAL 路径和 phase,新 session 里 relay 照样自动续跑。没有 GOAL 时续接 prompt 要求把交接「等用户拍板」里的每一项列给 owner(问题 · 推荐 · 备选),有截图的用 Read 逐张读出来;交接 note 第 7 项因此要求每项带截图绝对路径(10-11 owner:清空后之前发过的图看不到,拍板无从判断)。

**冷交接 `/relay coldhandoff`。** cache-clock 的「一键交接」按钮填这条命令。不发任何 Claude 请求(缓存冷了 fork 要按写价重放整段会话,10.23 实测一次 $74.96):`$.continuity.flushStart` 起 writer,等 checkpoint 写出来(最多 10 分钟,期间输入框上方停在「补存 checkpoint」),再把 checkpoint 全文 + 当前 GOAL + `~/.claude/mods-state/plan-<会话id>.json` + `git log --oneline -10` + `git status --short` 拼进交接文件,走和 `/relay go` 一样的 clear(有子 agent 或一轮在跑就等)。超时或失败不 /clear,toast 说明。handoff.log 记 `cold start` / `ready cold` / `cleared cold` 或 `cold not cleared`。

**进度与日志。** 交接 armed 到 clear 完,输入框上方画 5 步:写交接 → 等子 agent 和这一轮结束 → 补存 checkpoint → 写原文旁车 → /clear 并续接。每一步(armed / ready / cleared / 取消 / 放弃)记一行到 `~/.claude/handoffs/handoff.log`(留最近 400 行)。

## 可分享的交接(/handoff)

给同事或另开窗口用,**不占一轮、不 /clear**:`$.model.fork` 在会话旁边写。输入框上方 5 步:读会话 → 找用过的文件 → 列技能、工具和链接 → 写交接 → 保存并核对。模型那步之前先从会话记录机械抽一份草稿(`~/.claude/handoffs/share-<时间>-draft.md`),模型失败留草稿、可重试;成功写 `share-<时间>.md` 并删草稿。存盘前删去形似密钥的串。写好后按钮:复制交接(WSL 走 `clip.exe`)· 交接并清空(= `/relay go`)· 关闭。和 benai handoff 的对照见 `docs/handoff-vs-benai.md`。

## 状态

`$.state` 的 `relay.mode`(`idle | running | waiting-owner | done`)给 cue 读。GOAL 路径、phase 和计数器同时存进 `$.store` 的 `goal:<cwd>`:同一个 session 重启后自动接上(属主进程已经不在就按「属主与复活」复活);换了 session,用 `/relay resume` 接着跑。

## 配置

`thresholdTokens` · `delaySeconds` · `heartbeatMinutes`(25)· `maxTurns`(200)· `subagentEffort`(如 `Explore=low, Plan=high`)。
