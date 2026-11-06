# F1b · piw `allowedFromSpec` 改用 `lib/brief.mjs`(兼修紧贴路径的「(新建)」)(MiniMax 任务书)

**原始目标原文(owner 18.10)**:「F1 brief.mjs + schemas …… F1 先 /contract 结晶成任务书再派 MiniMax。」
证据:myapp `docs/plan/10.18/f1-brief-contract.md` 切片 2;TODO 18.10「piw `allowedFromSpec` 不剥紧贴路径的『(新建)』:任务书写成 `x.ts(新建)` 时整串被当路径」(S20 实例)。`lib/brief.mjs` 是 claude-mods `factory/lib/brief.mjs`(`bde0978`)的逐字副本,lead 已放进基线;**不许改它**。
执行者须知:限定边界,不规定做法;收尾写 omd-report 块。

允许改动:bin/piw test/piw-brief.test.mjs (新建)
阻塞于:无(F1a 已合入)
借的方法:豁免 -- 换解析器调用点,无领域方法
对外签名:`allowedFromSpec(meta)` → `string[] | null`(不变)

## 设计裁定(写死)

- `bin/piw` 的 `allowedFromSpec(meta)`:`git show` 取任务书文本那一步不变,解析改成 `require("../lib/brief.mjs").allowedList(text)`(Node 24 支持 require ESM,lead 已实测 `allowedList("允许改动:a.ts(新建) b.ts")` → `['a.ts','b.ts']`)。删掉原来的正则。
- 为了能测,把「文本 → 路径」那半导出或抽成可 require 的函数都行,但 `allowedFromSpec` 的名字与返回形状不变。
- **不做**:不改 `lib/brief.mjs`;不改越界闸的其他逻辑。

## 测试(先红后绿,期望值 lead 已重算)

`test/piw-brief.test.mjs`(`node --test`):临时 git 仓提交一份任务书,`allowedFromSpec({repo, base_sha, spec})`:
1. `允许改动:src/x.ts(新建) src/y.ts` → `['src/x.ts','src/y.ts']`。在 main 上红(旧正则给 `src/x.ts(新建)`)。
2. frontmatter `---\n允许改动: a.ts\n---\n允许改动:b.ts` → `['a.ts']`。在 main 上红。
3. 没有允许改动行 → `null`。

## 成功判据

- `node --test test/` 全绿
- `git diff <base> --stat` 只含允许改动的文件
