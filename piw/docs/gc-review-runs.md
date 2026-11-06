# piw gc · 认出审查 run,被审提交已进 main 或判词已有合并稿就列进可清

原始目标原文(owner,17.10,对「37 条审查分支要不要给 piw gc 加规则」的拍板):「按照你的推荐来。」推荐原文:「给 piw gc 加规则『判词已被 merged.md 引用即可清』。」

## 事实(lead 17.10 核过)

- 审查 run 的判词按设计留在 run 分支上(`review-merge.mjs` 从分支读),不合进 main,所以 `gcPlan`(`bin/piw:955-1028`)永远判不出「已合进」,37 条审查分支(myapp)一直留着。
- 审查 run 的 `meta.spec` 形如 `docs/reviews/<slug>-brief.md`;任务书正文有一行 `审查对象:分支 \`<branch>\` @ \`<sha>\`(…)`(myapp `scripts/dev/review-launch.mjs:153` 的 `BRIEF_TARGET_RE`:`/^审查对象:分支\s*\`([^\`]+)\`\s*@\s*\`([0-9a-f]{7,40})\`/m`)。
- 合并稿在 main 上:`docs/reviews/<slug>.merged.md`(slug = 任务书文件名去掉 `-brief.md`;`review-launch` 起的重审任务书可能叫 `<slug>-brief-2.md`,slug 同样去掉 `-brief-N`)。

## 要做什么

`gcPlan` 里,对 `m.spec` 匹配 `/(^|\/)docs\/reviews\/[^/]+-brief(-\d+)?\.md$/` 的 run,在既有「已合进 / fail 过期」两条都没给出 `reason` 时再判两条(任一成立即可清,`reason` 文字写死):
1. 任务书里「审查对象」的 sha 是 `main`(或 `m.base` 指的分支)的祖先 → `reason = "审查 run,被审 <sha 前 9 位> 已进 <分支>"`。任务书正文从 run 分支上读(`git show <it.branch>:<m.spec>`),分支没了就读 `<repo>/<m.spec>`,两处都读不到或没有那一行 → 不判(保持 quiet)。
2. `<repo>/docs/reviews/<slug>.merged.md` 存在 → `reason = "审查 run,判词已进合并稿 docs/reviews/<slug>.merged.md"`。

其余逻辑(正在跑 · 脏 worktree · 被忽略产物 §17 → keep)照旧在后面生效,不绕过。

允许改动:bin/piw test/retro-gc.test.mjs

不许碰:`ext/` · `prompts/` · 别的测试文件 · `~/.omd-lite/` 真实目录(测试用临时 HOME)。不装依赖。

## 对外签名(写死)

- 新增纯函数 `export`(bin/piw 是 CLI,不 export;写成顶层函数即可)`reviewTarget(text: string): { branch: string, sha: string } | null` —— 正则同上。
- `gcPlan({ olderDays, procs })` 签名不变;`clear[]` 条目形状不变(多的只是 `reason` 文字)。

## 测试(`node --test test/`,照 `test/retro-gc.test.mjs` 的 `world()` / `mkRun()` 写;期望值 lead 已重算)

1. 审查 run(`spec: "docs/reviews/x-brief.md"`,任务书提交在 run 分支上,`审查对象` 的 sha = main 上某个已有提交)→ `piw gc` 预览的可清列表里有它,reason 含「已进 main」。
2. 同上但 sha 是一个不在 main 历史里的提交(在另一个分支上做一个提交)且 main 没有 `docs/reviews/x.merged.md` → 不在可清列表(quiet)。
3. 第 2 条的世界里再往 main 提交 `docs/reviews/x.merged.md` → 可清,reason 含「合并稿」。
4. 非审查 run(`spec: "spec.md"`)行为与今天一致:既有测试全绿。

## 成功判据

- `cd ~/repos/piw && node --test test/` 全绿(含既有 60 条)。
- `piw gc` 对 `~/repos/myapp` 预览(只读,不 `--apply`)时,可清列表里出现 `agent-rv-mon-a-review`(被审 `313c1f249` 已进 main)—— 这条 lead 收片时自己跑,执行者不跑真仓。

收尾报告照 myapp `docs/process/executor-brief.md` 的格式(`omd-report` 块)。
