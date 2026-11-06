# board(进度板)

relay 自动 /clear 之后随时看仓的进度,不用再问。纯读文件 + git,不调模型;只写本会话的计划文件(见下)。设计:`docs/plan/2026-10-11-board.md`,合并 helper-desk / savvy-progress 见 `docs/plan/2026-10-23-board-unified.md`。

## 用法

- `/board`:当前仓 —— 下一步 · 当前 GOAL 各节勾选与未勾项 · 待拍板 · TODO 各节未勾数 · roadmap 在进行 / 已排 / 待 owner(otherapp:Now/Next 里未 Done 的,At Risk / Blocked 标 ⚠)· 在跑的片(装了 delegate 时)· 最近 5 个提交。每段后面写来源文件和它多久前改过。
- 今日 token 用量:只在本会话所在仓的板上(侧栏里是「今日用量」块),读 piw 今日台账 `~/.omd-lite/usage/<本地日期>.jsonl`;模型按用量降序,后面是备用合计 / 上限(`$PIW_DAILY_FALLBACK_TOKEN_CAP`,缺省 300.0M)。没有台账就不显示这一行。
- `/board myapp`:看 `~/repos/myapp`(任意 `~/repos/<名>`)。
- `/board open` / `/board open all` / `/board close`:开关右侧常驻侧栏(≥110 列全屏终端是侧栏，否则在输入框上方;要 67 列宽，内容 62 列)。`/board open` 是折叠态：走到哪、谁在跑、任务条、待拍板四块展开，下一步 / GOAL / TODO / ROADMAP / 最近提交 / 今日用量只留一行 `▸ <标题>`;`/board open all` 全展开。开着时每分钟和每轮回答后刷新,/clear 或重启后自动重开。侧栏按设计稿 E① 从上到下(终端里逐格照 `docs/design/term/tui.py` 画，颜色取 board-unified.pen 原色，外面一圈圆角框):
  - 顶部卡片：深紫底圆角框;仓名、`● 活 · Ns 前 · 分支 短SHA · 预设 <文件>`、`现在在 §N <节名> · 下一步:<…>`,右上是 GOAL 完成率百分比，底部一条绿(完成)/ 黄(进行中)/ 轨道色(规划中)三色条。
  - `谁在跑 · N`(右侧 `子 agent a · MiniMax b`)、`任务条 · 本会话计划`、`下一步`、`GOAL · done/total`(每节 `§N 节名` + 双色条;GOAL 没写 `###` 节时按上面的 `##` 标题分节)、`待拍板 · N`(黄 ⚠)、`TODO · N 未勾`(按 § 分组)、`ROADMAP · 在进行 a · 已排 b · 待 owner c`(黄 ▶、Blocked / At Risk 红 ⚠)、`最近提交 · N`、`今日用量 · X / 上限`(逐模型，数值右对齐)。每块标题右侧写来源和多久前改过。
  - 每块默认列 3 条;侧栏放不下时各块一起收到 2 条、1 条，不让底下的块掉出屏。
  - 仓里没有进度文件(设计稿 H):顶部卡片照画(百分比写 `—%`,条全灰，注「没有进度文件」),谁在跑 / 任务条 / 最近提交 / 今日用量照常，进度块收成一张虚线提示卡，写建哪个文件会亮哪块。没数据的块写一行 `—`。
- `/board roadmap|goal|todo|next|待拍板 [仓名]`:那一段的完整列表，逐项不截断。roadmap = 全文件每一行(按 `##` / `###` 分组，带状态;otherapp 的「之后」表带触发条件);goal = 每项 ✓ 完成 / ▶ 进行中 / ○ 规划中。
- `/board all`:`~/repos` 下每个认得的仓,每段一行摘要。

## 计划工具与任务条

- 工具名 `mcp__board__plan`(`{ title?, steps: [{ text, status }] }`,status 取 pending / in_progress / completed),每次发整张清单。board 在会话开始时注入一段提示词，告诉模型用这个工具;连续几次工具调用都没计划、或计划很久没动时，在工具结果后补一句提醒(每轮最多一次)。
- `TodoWrite` / `TaskCreate` / `TaskUpdate` 也喂同一张计划。只认主对话，子 agent 的调用不算。
- 计划写到 `~/.claude/mods-state/plan-<会话 id>.json`(`title` / `steps` / `updatedAt`),chat-inventory 照读。写失败只记 `~/.claude/mods-logs/board.log`,任务条照画。
- 侧栏的任务条在「谁在跑」下面：桌面是紫色进度条 SVG(流光 2.6s、当前步呼吸 1.6s,系统开了减少动效就不动),终端是一行方块条加当前步。全部完成后停 20 秒再收起。
- 让位:`enabledPlugins` 里 `helper-desk@owner-mods` 为 `true` 时，board 不注册 `plan`、不注入提示词，任务条也不画，免得两个计划工具打架。没有手动开关，关掉 helper-desk 后下一个会话自动接手。

## helper 卡(谁在跑)

- 每个在跑的子 agent 一张卡(精灵 + 造型色名字 + `步/总 · tok · 用时`;子 agent 没有已知的总步数，写 `N/— 步`),本会话起的 delegate run(`$.delegate.runs()`,MiniMax / mcode 用 MiniMax 造型)一张卡。造型按子 agent 类型:`savvy-<档>` → 该档造型,`Explore` → 海盗，其余是普通螃蟹。
- 桌面：每张卡一只 SVG 螃蟹，在跑时带 CSS 动画;终端:7×8 半块像素精灵(4 行高),heavy / medium / MiniMax 三种是从 .pen 像素矩形按 tui.py `sprite_px` 缩出来的常量(`hooks/pen-sprites.ts`,`python3 -I board/scripts/gen-pen.py` 重新生成),不动;其余造型用原来的 10×6 精灵居中，每 500ms 换一帧。
- 多于 6 个时只画前 6 张在跑的卡，其余折成一行 `+N`。
- 有 helper 在跑时侧栏每 500ms 一跳，只推进帧号和用时，不重读进度文件、不跑 git;没有在跑的就停掉这个时钟，回到原来的每分钟刷新。
- 依赖 delegate 插件;delegate 不在时只画子 agent 卡。
- 在跑不在跑以 `$.agent.list()` 的状态为准:`pending` / `running` / `waiting` 都算在跑(子 agent 一轮结束后等自己的后台活时报 `waiting`,不算完)。子 agent 的一轮结束只触发重读一次列表;它一轮结束后从列表里消失才算完。

## 输入框上方两行

board 在输入框上方固定画 2 行，不画网址:

- 第 1 行:`模型·effort │ 仓 ⎇ 分支* ↑未推送(有就显示，≥5 变黄) │ ctx 条 N% │ 5h 条 N% 重置剩余 │ 周 N%`。模型读 `$.session.model()`,effort 读主对话最近一次 `turn.step`,上下文和额度读 `$.session.usage()`。引擎没给的数显示 `—`,不填 0。
- 第 2 行:`▶ 任务 条 n/m 当前步骤(最多 24 格，超出用 …) │ 在跑的每个 helper 一个帽色圆点 ●(精灵画不进一行)+「N 在跑」 │ ◷ N m`。N = 在跑的子 agent 数 + 在跑的 delegate run 数。没有计划、没人在跑时对应那段不画;◷ 段一直在(cache-clock 还没计时写 `◷ —`),所以第 2 行永远在。
- 第 1 行太宽时先截分支、再截仓名，ctx / 5h / 周不掉出行尾。颜色照设计稿 D-8:模型紫、完成绿 `#22c55e`、进行中黄 `#eab308`。

两行逐格照 tui.py 的 l1 / l2:分隔 ` │ `、`▆` 条、↑N 粗体、模型青色。格式化在 `hooks/tui.ts`(`hudLines`)。

## 夹具模式

`BOARD_FIXTURE=<json 路径>`:侧栏和两行的所有数据都取这个文件，不读 git、仓文件、引擎用量、agent 列表。和 .pen 示例数据逐字相同的夹具是 `docs/design/term/fixture/pen.json`,schema 见同目录 README.md。给 `tools/screenshot/tui-judge.py` 逐字对稿用。

## 读哪些文件

内置两套预设,按仓里有哪个文件认:`_NEXT.md` → myapp 式(`_NEXT.md` · 最新 `docs/plan/<版本>/GOAL.md` · `DECISIONS-PENDING.md` · `TODO.md` · `docs/ROADMAP.md`);`docs/status/NEXT.md` → otherapp 式(`docs/status/NEXT.md` · `docs/ops/roadmap.md`)。别的仓放 `.claude/board.json`(`{ "sections": [...] }`,段的写法见 `types/index.d.ts`)即可。

## GOAL 进行中标记(owner 10.11 定)

`- [ ] 〔进行中 <run名>〕**项名** …`:派出 / 开工时加，合入验收改 `[x]` 时删，片停了也删。board 据此分:`[x]` 完成 · 带标记 = 进行中 · 其余 `[ ]` = 规划中(GOAL 规划范围内未开始);GOAL 外的 TODO / ROADMAP 候选是「未做」。
