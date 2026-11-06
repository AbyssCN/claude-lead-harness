# piw gc · 审查 run 第二轮:「被审提交已进 main」不能当可清判据,换成「分支上的判词文件逐字在 main」

原始目标原文(owner,17.10):「按照你的推荐来。」(推荐:给 piw gc 加规则「判词已被 merged.md 引用即可清」)

## 第一轮(分支 `omdl/piw-gc-reviews`,已提交)的问题(lead 17.10 收片时发现)

判词按设计**只存在于 run 分支**(`docs/reviews/<slug>.<家族>.md` 或 `<slug>.md`),不在 main。第一轮规则 1「被审提交已进 main → 可清」会把分支连同判词一起删掉,而 S8 的合并说明写的「判词: <路径>」就指向这个分支 —— 删了以后事后审计读不到判词。规则 1 作废。

## 要改什么(只改 `reviewReason`,其余不动)

两条判据改成(任一成立即可清):
1. **判词已在 main**:`git diff --name-only <m.base_sha>..<it.branch> -- docs/reviews/` 列出分支新增 / 改动的判词文件(排除 `-brief` 任务书:`/-brief(-\d+)?(\.[a-z0-9]+)?\.md$/`);文件数 ≥ 1,且每个文件 `git rev-parse <it.branch>:<f>` 的 blob 与 `git rev-parse main:<f>` 相等(文件在 main 上不存在 = 不等)→ `reason = "审查 run,判词 <n> 份已逐字在 main"`。分支没了(只剩 worktree)→ 不判。
2. **判词已进合并稿**(第一轮规则 2 不变):`<repo>/docs/reviews/<slug>.merged.md` 存在 → `reason = "审查 run,判词已进合并稿 docs/reviews/<slug>.merged.md"`。

`reviewTarget` 函数留着(规则 1 不再用它,别的地方以后用),`REVIEW_SPEC` 不变。「正在跑 / 脏 worktree / 被忽略产物」的 keep 照旧先于这两条。

允许改动:bin/piw test/retro-gc.test.mjs

不许碰:`ext/` · `prompts/` · 别的测试文件 · `~/.omd-lite/` 真实目录。不装依赖。

## 对外签名(写死)

- `reviewReason(repo, it, m): string | null`(去掉第四个参数 `baseBranches`)。
- `gcPlan` 签名与 `clear[]` 条目形状不变。

## 测试(改 `test/retro-gc.test.mjs` 里第一轮的六条审查 run 测试;期望值 lead 已重算)

1. 「被审提交已进 main → 可清」改成「判词文件逐字在 main → 可清」:审查 run 分支上提交 `docs/reviews/x.minimax.md`,再把**同内容**的同名文件提交进 main → 可清,reason 含「已逐字在 main」。
2. 同名文件在 main 上但**内容不同** → 不可清(quiet)。
3. 第一轮加的「base 是被审 head + 任务书」反例(`rv-base`)改成:被审提交在 main、但判词文件不在 main → **不可清**(这条是本轮的「该拦没拦」:把判词删掉就是丢证据)。
4. 「判词已进合并稿」「只剩分支时从分支上读」「不绕过正在跑 / 被忽略产物」三条照旧绿(夹具按新规则改:只剩分支那条改成判词在 main 的形状)。
5. 非审查 run 行为不变:既有测试全绿。

## 成功判据

- `cd <worktree> && node --test test/` 全绿。
- 收片时 lead 对 `~/repos/myapp` 跑 `piw gc` 预览(只读):`agent-people-md2-1016-review`(判词 2/2 逐字在 main)在可清列表,`agent-fix5-client-a-oct2-review`(判词只在分支)不在。执行者不跑真仓。

收尾报告照 myapp `docs/process/executor-brief.md` 的格式(`omd-report` 块)。
