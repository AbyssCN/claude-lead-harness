# M8a · piw 备用模型每日 token 上限 + 用量台账(MiniMax 任务书)

**原始目标原文(owner 15.10)**:「按 <lead-harness>/docs/plan/2026-10-15-production-grade-harness.md §2 路线图,做完 lead 能独立完成的项。……机械片用 /contract 写任务书交 MiniMax 并行跑」;§2 M8 行原文:「模型费用上限:piw fallback 每日 token 上限,超限即停不再切换;board 显示当日用量」,判据「模拟超限的 run 被停下」。
证据:同文档附录 C A7(fallback 的 deepseek 按量计费,没有预算上限);`bin/piw:243-263` 主跑供应商报错就无条件换 fallback 重跑。
执行者须知 `/home/user/repos/myapp/docs/process/executor-brief.md`(其中 myapp 专属的 TES / 界面条目与本片无关)。

**允许改动:** bin/piw lib/piw.js test/piw-budget.test.mjs (新建) README.md

## 现状(已核)

- fallback 触发点 `bin/piw:243-263`:主跑没有 `result.json` 且 `providerError(pi.jsonl)` 非空 → `fallback` 不为空且 ≠ 主模型 → 在 `out/fallback/` 重跑。没有任何预算检查。
- 用量只在 `finish()`(`bin/piw:275-305`)里由 `usageFromJsonl`(`:101-115`)算出写进 `meta.tokens`,没有跨 run 的按日汇总。
- 配置:`lib/piw.js` 的 `loadConfig({ repo })` 读 `~/.config/piw/config.json`(现有字段 `roles`)。
- 测试:`node --test test/`(`test/index.js` 收全部 `*.test.mjs`);替身 `test/fixtures/pi-stub.mjs` 按 `STUB_PLAN` 让指定模型报 `2056` / `402` / `stream` 等错误。参照 `test/piw-ask-run.test.mjs` 起 `piw run` 的写法(`PIW_PI_BIN` 指替身、临时仓、临时 HOME 或 runs 目录)。

## 设计裁定(写死)

### 对外签名

```
用量台账  <usageDir>/<YYYY-MM-DD>.jsonl,usageDir = $PIW_USAGE_DIR,缺省 ~/.omd-lite/usage;日期取本机本地日期
  每次 runPi 结束(主跑与 fallback 各一行)追加一行 JSON:
  {"at":<秒>,"label":"<run 名>","model":"<provider/id>","arm":"primary"|"fallback","tokens":{"input":n,"output":n,"cacheRead":n,"cacheWrite":n,"total":n}}
  tokens 用 usageFromJsonl(<该次 attempt 的 pi.jsonl>) 的同名字段;mcode / claude 执行器不写台账(本片不管)

每日上限  只管 fallback:dailyFallbackTokenCap = $PIW_DAILY_FALLBACK_TOKEN_CAP(整数),缺省读 config.json 的 "dailyFallbackTokenCap",
  再缺省 300000000(3 亿;15.10 实测单日 fallback 峰值约 2.5 亿,含 cacheRead)
  已用 = 今天台账里 arm == "fallback" 的 tokens.total 之和

lib/piw.js 新增导出:
  export function usageDir(env)                          // → string
  export function appendUsage(env, row)                  // 追加一行;目录不存在就建
  export function usageToday(env, now = Date.now())      // → { byModel: {<model>: total}, fallbackTotal: number }
  export function fallbackCap(cfg, env)                  // → number
```

### 行为

- 主跑供应商报错、本该换 fallback 时:先算 `usageToday(...).fallbackTotal`。**≥ 上限** → 不换、不建 `out/fallback/`;stderr 打印 `[piw] <name>: 今日备用模型已用 <已用> token ≥ 上限 <上限>,不换 <fallback>,本片停下`;`meta.attempts` 追加 `{ model: <fallback>, skipped: "budget" }`;`finish` 时 `meta.failureClass` 与 `result.json` 的 `failureClass` 都是 `"budget"`(覆盖原来按报错分类得出的值)。
- 未到上限 → 行为与现在逐字一致。
- 主跑没报错 → 根本不看上限。
- 台账写失败(只读目录等)不影响 run:吞掉错误,stderr 打一行 `[piw] 用量台账写不进 <路径>:<原因>`。
- README「已知限制」或配置节加三行:台账路径与格式、上限怎么配、超限的表现(failureClass budget)。

## 测试(先红后绿,test/piw-budget.test.mjs,`node:test`)

每条在当前代码上红:

1. `usageToday`:临时 `PIW_USAGE_DIR` 里放今天的台账两行 fallback(total 100、200)+ 一行 primary(total 999)+ 昨天文件一行 fallback(total 5000)→ `fallbackTotal = 300`,`byModel` 按 model 求和。
2. `fallbackCap`:env 优先于 config,缺省 300000000。
3. **模拟超限的 run 被停下**:`STUB_PLAN` 让主模型 `2056`、fallback `ok`;`PIW_DAILY_FALLBACK_TOKEN_CAP=1000`,今天台账预置一行 fallback total 5000 → 跑 `piw run` → `out/fallback/` 不存在、替身日志里**没有** fallback 模型的调用、`meta.json` 的 `failureClass === "budget"`、`attempts` 末项 `skipped === "budget"`、stderr 含「不换」。
4. **未超限照旧切换**:同上但上限 1000000 → fallback 被调用、`out/fallback/` 存在。
5. **台账写入**:一次主跑 ok 的 run 结束后,今天台账多一行 `arm: "primary"`、`label` 等于 run 名、`tokens.total` 是数字。
6. 现有测试全绿、断言不改。

## 不做

- 不给主跑(MiniMax 包月)设上限;不改 `ask` 子命令;不改冷却逻辑;不碰 board(另一片做)。
- 不新增依赖。

## 成功判据

- 仓根 `node --test test/` 全绿(读末尾 `ℹ fail 0`),条数比 base 多 ≥ 5。
- `git diff <base> --stat` 只含允许改动的文件。

期望值:测试里的上限、token 数是 lead 定的构造值(lead 已重算),照抄不改。
