# cue 提词方法论对照(2026-10-15)

对象:`hooks/seat.ts` 里的两个提示 —— `seatPrompt`(C-3,回答后替 owner 写下一条)与 `enhancePrompt`(/enhance,改写粗稿),两者共用 `SHAPE` 五段结构。
材料:pstack(cursor/plugins 仓 `plugins/pstack/`,下称 **P**,本地副本 `/tmp/pstack-study/plugins/pstack/`)与 mattpocock/skills(commit `49dd158`,下称 **M** = `https://github.com/mattpocock/skills/blob/main/skills/`)。
不变的:输出格式(JSON 数组,title ≤ 18 字)· owner 口吻 · 一条完整指令。

判词三种:**已有**(现在的提示已经要求)· **吸收**(这次改进提示)· **不适合**(写理由)。

| # | 方法 | 出处 | 判词 | 落在哪 / 理由 |
|---|---|---|---|---|
| 1 | 只说目标和你已知的,不写仪式 | P `docs/guide/02-poteto-mode.md`「Say the goal, not the ceremony」 | 已有 | SHAPE 1「一句话要什么」+ 2「只放模型会用到的」 |
| 2 | 不规定做法 / 不手写步骤清单 | P `skills/poteto-help/references/prompting.md`「Leave out」;M `engineering/triage/AGENT-BRIEF.md`「Behavioral, not procedural」 | 已有 | 「限定终点和边界,不规定做法和第一步」 |
| 3 | 写出真约束(repro first、zero behavior change) | P `prompting.md`「Put in」第 4 条 | 已有 | SHAPE 3 边界 |
| 4 | 带上已知线索(症状、复现、日志、链接) | P `prompting.md`「Put in」 | 吸收(小) | SHAPE 2 证据指针里点名「复现步骤」 |
| 5 | 原因的猜测先别当结论写,否则搜索被带窄 | P `prompting.md`「Leave out」:"A stated guess narrows the search." | **吸收** | SHAPE 2:猜测标成「待证伪的假设」,放在事实之后 |
| 6 | 用正向目标写边界,禁令只留真护栏 | M `productivity/writing-for-agents/SKILL.md`「Leading words」:"Prompt the **positive**" | **吸收** | SHAPE 3:范围写成「只动哪里、哪些行为不变」 |
| 7 | 判据能判过 / 不过 | P `prompting.md`「Put in」:"'Make it better' and a duration are not checks." | 已有 | SHAPE 4「能写成可跑命令就写命令」 |
| 8 | 判据既可检查又穷尽 | M `writing-for-agents/SKILL.md`「Steps and completion criteria」:"both checkable and exhaustive" | **吸收** | SHAPE 4:能写成「每个改到的 X 都……」就写穷尽式 |
| 9 | 修 bug 先要一条会变红的命令 | M `engineering/diagnosing-bugs/SKILL.md` Phase 1:"No red-capable command, no Phase 2.";P `skills/principle-fix-root-causes/SKILL.md` | **吸收** | SHAPE 4 |
| 10 | 改动前留基线,事后对照新旧值 | P `skills/figure-it-out/SKILL.md` 第 29 行("baseline captured from the pre-change state") | **吸收** | SHAPE 4:重构 / 迁移先留基线 |
| 11 | 小步可验证,绿了再走下一步 | P `skills/principle-sequence-verifiable-units/SKILL.md`;M `engineering/to-tickets/SKILL.md`「Draft vertical slices」 | **吸收** | SHAPE 4:多步的每步带自己的验证 |
| 12 | 点名要的证据形态,不收「已完成」;让它论证修的是原因 | P `prompting.md`「Put in」与 "convince me it fixes the cause and not the symptom";P `skills/principle-prove-it-works/SKILL.md` | **吸收** | SHAPE 5 |
| 13 | 可逆的做完再报,预先回答停点问题 | P `skills/principle-never-block-on-the-human/SKILL.md`:"Proceed, then present.";P `prompting.md`「Before stepping away」 | 已有 → 写明 | SHAPE 5 原来只有例句,现在写成规则:只有要 owner 拍板的才停 |
| 14 | 想先看设计就设评审停点 | P `prompting.md`「Put in」("let me review before proceeding");P `docs/guide/04-design.md` | **吸收** | SHAPE 5:大改动先停在一段复述 + 计划处 |
| 15 | 先让 agent 用自己的话复述问题 | P `skills/in-your-own-words/SKILL.md`;P `prompting.md`「Load the context first」 | 部分吸收 | 并进 #14,只用于大改动;小事每次都要复述多一轮来回,违背 #13 |
| 16 | 同一前提上的修法连败 → 质疑前提 | P `skills/principle-attack-the-premise/SKILL.md`:"suspect the premise, not the fixes" | **吸收** | seatPrompt「怎么想」新增一条 |
| 17 | 报出的数先解释(why not double?) | P `skills/principle-explain-the-number/SKILL.md` | **吸收** | 同上一条 |
| 18 | 写明范围外,防镀金 | M `engineering/triage/AGENT-BRIEF.md`「Explicit scope boundaries」;M `engineering/to-spec/SKILL.md`「Out of Scope」 | 已有 | SHAPE 3 边界 |
| 19 | 事实自己查,决定才问人 | M `productivity/grilling/SKILL.md`:"Finding _facts_ is your job, never the user's." | 已有 | 「不编造路径和命令」+ 停点只留拍板 |
| 20 | 引用而不复制(路径 / URL) | M `productivity/handoff/SKILL.md` | 已有 | SHAPE 2「证据指针」 |
| 21 | 判断规格过松还是过紧,用户的选择留给用户 | P `skills/sharpen/SKILL.md` | 已有 | 「限定终点和边界」+ 真岔口才出方向 B |
| 22 | 一轮提问、每问附推荐答案,确认共识前不执行 | M `productivity/grilling/SKILL.md` | 不适合 | cue 产的是一条要发出去的指令,不是采访;需要拍板的情况已由「第一句就是 owner 的拍板」覆盖 |
| 23 | 不写文件路径与行号(会过期) | M `engineering/triage/AGENT-BRIEF.md`「Durability over precision」 | 不适合 | 那是给要放很久的 issue 的;cue 的 prompt 当场发出,路径是新鲜的,还省模型一次搜索(#4) |
| 24 | 跟进写短,「do it」就是完整 prompt | P `prompting.md`「Follow up short」 | 不适合 | 与 cue 的定位(一条完整指令)正面冲突;owner 想短发时自己打字比按 cue 快 |
| 25 | 换主题先写「new task」 | P `docs/guide/02-poteto-mode.md`「Switch tasks with "new task"」 | 不适合 | 针对 poteto-mode 的路由;cue 的 prompt 按构造承接上一条回答 |
| 26 | 设计取 2–3 个可运行原型比较 | P `skills/principle-exhaust-the-design-space/SKILL.md` | 不适合 | 成本由任务决定,不该由提词器默认加;真岔口已有方向 B |
| 27 | 用强词代替一串形容词 | M `writing-for-agents/SKILL.md`「Leading words」 | 不适合 | 主要针对常驻 skill 文档;单条 prompt 里收益小,放进提示只会让输出更花 |
| 28 | 多阶段流程(figure-it-out A–E、implement-spec 编排、wayfinder / to-tickets 发布) | P `skills/figure-it-out/SKILL.md`;M `engineering/implement-spec/SKILL.md`;M `engineering/wayfinder/SKILL.md` | 不适合 | 是执行方自己的长流程,不是一条用户 prompt 该写的;其中可用的(#10 基线、#11 竖切片)已单独抽出 |

## 张力与取舍

- **问清楚 vs 不阻塞**:grilling 要「确认共识前不执行」(#22),never-block 要「可逆的直接做」(#13)。cue 取后者为默认,只在两处停:等 owner 拍板,和大改动的复述 + 计划(#14)。
- **禁令 vs 正向**:pstack 的例句里有大量 "don't change any code yet",writing-for-agents 主张正向。SHAPE 3 取「正向为主,禁令只留真护栏」—— 「先只调查、不改代码」这类就是真护栏,照写。

## 这次改了什么

`hooks/seat.ts`:`SHAPE` 第 2–5 段吸收 #4 #5 #6 #8 #9 #10 #11 #12 #13 #14;`seatPrompt` 的「怎么想」加一条(#16 #17)。`enhancePrompt` 共用 `SHAPE`,同步生效。输出格式、title 上限、owner 口吻未动。
