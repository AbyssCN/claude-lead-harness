# board(进度板)

> A read-only progress board for the current repo (next steps, GOAL checklist, pending decisions, TODO, roadmap, running runs, recent commits) as a command and a sidebar; no model calls.

relay 自动 /clear 之后随时看仓的进度,不用再问。纯读文件 + git,不调模型、不写文件。

## 用法

- `/board`:当前仓 —— 下一步 · 当前 GOAL 各节勾选与未勾项 · 待拍板 · TODO 各节未勾数 · roadmap 在进行 / 已排 / 待拍板(status-next 布局:现在 / 接下来 里未 Done 的,At Risk / Blocked 标 ⚠)· 在跑的片(装了 delegate 时)· 最近 5 个提交。每段后面写来源文件和它多久前改过。
- `/board <仓名>`:看 `<reposDir>/<仓名>`。
- `/board open` / `/board close`:开关右侧常驻侧栏(当前仓:标题卡 + GOAL 完成率 · ▶ 进行中卡片 · GOAL 各节与 ROADMAP 各层的彩色分段条(绿 完成 · 黄 进行中 · 灰 规划中)· 其余各段点 ▸ 展开;≥110 列全屏终端是侧栏,否则在输入框上方)。开着时每分钟和每轮回答后刷新,/clear 或重启后自动重开。
- `/board roadmap|goal|todo|next|待拍板 [仓名]`:那一段的完整列表,逐项不截断。roadmap = 全文件每一行(按 `##` / `###` 分组,带状态;「之后」表带触发条件);goal = 每项 ✓ 完成 / ▶ 进行中 / ○ 规划中。
- `/board all`:`reposDir` 下每个认得的仓(只看主 checkout),每段一行摘要。

## 读哪些文件

内置两套预设,按仓里有哪个文件认:

- **next-md 布局**(有 `_NEXT.md`):`_NEXT.md` · 最新 `docs/plan/<版本>/GOAL.md` · `docs/plan/DECISIONS-PENDING.md` · `docs/plan/TODO.md` · `docs/ROADMAP.md`。
- **status-next 布局**(有 `docs/status/NEXT.md`):`docs/status/NEXT.md` · `docs/ops/roadmap.md`(`### 现在` / `### 接下来` 状态表,`## <n>. 待…` 待拍板节)。

别的仓放 `.claude/board.json`(`{ "sections": [...] }`,段的写法见 `types/index.d.ts`)即可,它优先于预设。

## GOAL 进行中标记

`- [ ] 〔进行中 <run名>〕**项名** …`:派出 / 开工时加,合入验收改 `[x]` 时删,片停了也删。board 据此分:`[x]` 完成 · 带标记 = 进行中 · 其余 `[ ]` = 规划中(GOAL 规划范围内未开始);GOAL 外的 TODO / ROADMAP 候选是「未做」。

## 配置(plugin userConfig)

| 选项 | 默认 | 说明 |
|---|---|---|
| `reposDir` | 空 = `~/repos` | `/board <仓名>`、`/board all` 在这里找仓;会话在其下时以 `<reposDir>/<仓名>` 为仓根,否则以 cwd 为仓根 |

## 安装

```
/plugin marketplace add AbyssCN/claude-lead-harness
/plugin install board@claude-lead-harness
```
