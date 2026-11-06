---
name: retro
description: 一批 omd-lite(mcode / pi)run 合并后的复盘:先跑确定性汇总 omd-lite retro(零模型),再把 ≥ 2 次的重复模式按七类定位、分流到「闸 / 审查标准 / 任务书模板 / 不处理」四个去处,产出提案表交 owner 批;顺带 omd-lite gc 预览清 worktree。Trigger:/retro、批后复盘、这批 run 复盘一下、坑变闸、retro。
---

# /retro — 批后复盘:把重复的坑分流成闸或审查标准

契约:`docs/plan/2026-10-08-mcode-loop-retro-and-spec-axis.md`(oh-my-dag)§3。分类法来自 mattpocock/skills 的 `retro`;
2026-10-25 起与 learn mod 每周 retro 共用一套规矩和一本台账(吸收 Matt「每条追到具体时刻」与 poteto「只收模式、宁缺毋滥」;原文在 `~/.omd-lite/research/retro-skills/`)。
**时机**:一批 omdl run 合并进 main 之后跑一次。**不自动改闸、不自动改模板**(D7)—— 产出是提案,owner 批了才落地。

## 步骤

1. **汇总(零模型)**:`omd-lite retro --since <批次开始日 YYYY-MM-DD>`(可再跟 label 只看某几个 run)。
   读末尾的「聚合」:首败闸 / 执行器失败 · 越界文件 · 执行器失败 · not-run / 中断原因 · 多轮占比。聚合只列 **≥ 2 个 run** 的模式(D6);单次的只记不提。
   - `执行器挂了(<码>)` 是执行器 / 供应商 / 调度的问题(限流、并发锁 `agent_name_conflict…:lock`、`CONTENT_REVIEW_BLOCKED`、spawn 失败),
     去处通常是调度规则或驱动,**不是**任务书;`执行体没交付(没有改动)` 才要回头读任务书与执行体的收尾报告。
   - 越界文件 ≥ 2 次 = 「允许改动」漏列候选(典型:登记处 —— i18n messages、规则注册表、index 导出)。
2. **清 worktree(预览)**:`omd-lite gc`(只打印路径 · 原因 · 大小)。把可清清单与总大小写进产出;**owner 批了再** `omd-lite gc --apply`。
   不对正在跑的批次跑 `--apply`;gc 自己也会跳过正在跑的 run、有未提交改动的、有被忽略产物的 worktree。
3. **补两路人工信号**(机器数不到的):
   - 本批 lead 返工:`git log main --since <批次开始日> --grep '<run 名>'` 里 merge 之后带 run 名的修正提交,读改了什么;
   - 本批跨模型审(`scripts/dev/review-launch.sh` 的判词 `docs/reviews/*.md`,或 `/code-review`)里被 accept 的项。
4. **定位**:每个重复模式先按七类归因 —— Navigation(找不到该改的地方)· Automated checks(闸缺 / 闸错)· Coding standards ·
   AGENTS.md 瘦身(上下文太长被忽略)· Tool economy(工具用法浪费轮次)· No-ops(空转、没交付)· Information access(读不到该读的)。
5. **分流**(D5:**机械可判 → 确定性闸,没有例外;要判断 → 审查标准给 reviewer,不加给执行方**):
   - **闸**:myapp `scripts/dev/gate-*.sh` 加一道,或 omd-lite 越界闸加预检。写出**具体命令**和它在本批哪几个 run 上会红。
   - **审查标准**:追加到 reviewer 的 `--extra` 焦点清单(myapp `docs/process/` 下一份文件,首次 retro 时建)。
   - **任务书模板 / executor-brief**:只放导航指针和「Out of scope」,**不放规范条文**(执行方上下文压力最大,条文塞给它不生效)。
   - **不处理**:写明为什么(一次性、已修、成本高于收益)。
   - **修复梯(排去处的优先级,出处 pstack `correct`)**:同一个坑能在多层堵时,取最靠前的一层 ——
     ① 架构(让错误写不出来:类型化接口、单一入口)→ ② 类型(tsc 拦)→ ③ lint / 闸(报错文字里写明怎么改)→ ④ 测试 → ⑤ 文档 / 审查标准。
     提案表里写明为什么没取更前一层。
   - **先查仓里已有的闸**:`.claude/delegate.json` 的 sliceGate / layerGates 与它们调的脚本。已有的检查没接上或坏了,结论就是接上 / 修好,不另造。
   - **新闸先证红证绿**:新检查命令在一个**真实坏样本**上退 1、在一个**真实好样本**上退 0。坏样本可以是出错的提交(`git worktree add --detach /tmp/x <旧 sha>`),
     也可以是证据 run 里那份真实文件 / 日志;好样本可以是修好的提交、当前 main,或另一个没犯这个错的 run 的同名文件。证不了红的闸不提。
   - **审查标准要有读者**:写明追加到哪个文件,且这个文件存在、你能指出哪个审查脚本或 agent 读它;找不到读者 = 写了也没人看,丢掉或改成闸。
   - **豁免带到期日与批准人**:闸上线时给既有违规开的豁免(白名单、基线、`ignoreUntil`)每条写 `到期 YYYY-MM-DD · 批准人`,
     不超过 90 天;每次 retro 列出 30 天内到期的豁免(`rg -n '到期 20' <豁免文件>`),到期前重判,不许静默续期。
6. **产出 = 进台账,不写进没人看的文档**:
   - 提案表写成 `~/.local/share/owner-mods/learn/proposals/<日期>-<仓>-manual.md`,表格式与 learn 每周 retro 相同
     (`<lead-harness>/learn/bin/retro-prompt.md`「提案文件格式」一节:# · 模式 · 次数 · 七类 · 去处 · 修复梯 · 改法 · 证据),**最多 5 行**,不放「不处理」行,末尾一行「没进表的:n 条(原因计数)」。
   - 入账:`bun <lead-harness>/learn/bin/proposals.ts ingest --repo <仓名> --date <日期>-manual --file <上面的文件> --worktree <仓根>`;
     它做同样的机械检查(缺证据的闸降级、没读者的审查标准丢、已有提案的模式不重提),stdout 是待批段 —— 追加进 `~/.claude/relay/待owner-<仓名>.md`。
   - 在对话里给 owner:待批段原文 + gc 预览一行 + 30 天内到期的豁免。批 / 驳 / 落地用 `proposals.ts approve|reject|done <id>`。批之前不改闸、不改模板、不跑 `gc --apply`。

## 纪律

- **每一行都要追到一个具体时刻**(run 名 + 文件 + 行号或原文引用),追不到的丢掉;不要为了填满七类编通用建议。
- 聚合里的数是**计数不是结论**:先读至少一个证据 run 的 `gate-round-<n>.log` / `mcode-round-<n>.log` 再下判断(一个在任何干预下都不动的数,通常量的是尺子)。
- 已经修过的坑(例如 harness 自己造的越界)写进「不处理 · 已修」,注明修它的提交,别再提一遍。
- 单次出现的模式不进提案表;如果你认为它危险到值得破例,标 `?` 交 owner,不要自己决定。
