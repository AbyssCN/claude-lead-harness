---
name: verify
description: "统一验证 gate:读仓内 `.claude/delegate.json` 的片闸(sliceGate)与层闸(layerGates)照跑;只配了层闸的仓按改动命中跑层闸,一条都没命中就明说「没有命中的闸」(不算绿);仓里什么闸都没配就报错,不猜命令。用法 /verify [基线 ref,默认 main,没有 main 用 master] · /verify --full(跑 fullGatesCmd)。Trigger: 验证 / 跑测试 / 检查一下 / verify / run tests / 预检 / 提交前检查。Skip: 代码审查 (/code-review) / 提交 (/commit)。"
metadata:
  version: "4.3.0"
  note: "20.10:加「仅层闸仓」(只配 layerGates,如 claude-mods)与 NO-GATE 结论;基线没有 main 时用 master。4.2:改动集合 / 命中 / 豁免 / 未覆盖一律由同目录 gates.mjs 算(/commit 用同一个脚本),豁免只认 delegate.json 的 layerExempt;加 EXEMPT 结论。4.3:层闸由 gates.mjs run 跑,命令找不到(退 127)报 ENV-ERROR,等命令就位重跑一次,不当 PASS 也不当 FAIL。有 sliceGate 的仓(myapp)行为不变。"
---
# /verify — 按仓内配置跑闸

**只认仓内配置,不猜。** 闸由每个仓自己定义在 `<仓根>/.claude/delegate.json`(delegate mod 同一份配置),本 skill 只负责照着跑、读日志判结果。

## 结论只有六种

| 结论 | 含义 |
|---|---|
| `PASS` | 跑了的闸全绿。仅层闸仓还要同时列出「未覆盖」的改动路径(可以为空) |
| `FAIL` | 有闸红(同一次里有闸红又有环境错,结论是 FAIL —— 真红优先) |
| `ENV-ERROR` | 环境错,不是代码红:闸命令里有命令找不到(bash 退 127,`command not found` / `No such file or directory`,如 claude CLI 自动更新中途)。脚本已等它就位(最多 `GATES_ENV_WAIT` 秒,默认 180)并重跑一次仍找不到。**不是 PASS 也不是 FAIL**,报告首行写环境错与缺的命令 |
| `NO-GATE` | 改动里没有一个路径命中任何闸,一道闸都没跑。**不是绿**,报告首行写「没有命中的闸」并列出改动路径 |
| `NO-CHANGE` | (仅层闸仓)改动集合为空,没东西可验 |
| `EXEMPT` | (仅层闸仓)改动全在 `layerExempt` 里,没有要验的路径,一道闸都不跑;/commit 可以提交,报告写「全是豁免路径,未跑闸」 |

不许为了凑出 PASS 而改闸配置(加空的 / 恒真的 sliceGate、把 pattern 改宽、往 layerExempt 塞有代码的目录),那是假绿。

**片闸仓的覆盖声明**:`sliceGateCovers: [{pattern, why}]` = 片闸每次都跑、自己验得到的路径(读数 ① 算覆盖;读数 ② 按目录组单独插探针实跑片闸核对)。`notTests` 的项可写 `{lock: "<目录>/*.json", prefix, why}`,按锁文件 `.files` 的键逐个列入(factory 装件)。`worktreeSetup` = 干净 worktree 里跑闸前的准备命令(每周读数用)。

**判定只用脚本,不手算**:`node ~/.claude/skills/verify/gates.mjs plan [基线]` 给出 JSON(`kind` · `base` · `verdict` · `changed` · `exempt` · `hits[{pattern,cmd,paths}]` · `cmds` · `uncovered`)。/commit 用同一个脚本的 `check` 子命令,两边对「哪些路径要闸、哪些豁免」永远一致;豁免只有一个出处 —— `delegate.json` 的 `layerExempt: [{pattern, why}]`(JS 正则,对仓根相对路径)。

## 步骤

1. **找配置**:`root=$(git rev-parse --show-toplevel)`,读 `$root/.claude/delegate.json`。
   - 文件不存在,或 `sliceGate`、`gate`、`layerGates` 三个都没有(或 `layerGates` 是空数组)→ **停,报错**:
     `verify: 本仓 .claude/delegate.json 没有任何闸(sliceGate / gate / layerGates),不猜命令。先在仓里配好(字段说明见 <lead-harness>/delegate/README.md 配置节)。`
     不要退回去跑 `tsc` / `bun test` / `npm test` 之类的默认命令 —— 跑错闸比不跑更糟(假绿)。
   - 有 `sliceGate` 或 `gate` → **片闸仓**,走第 3 步全部。
   - 只有 `layerGates` → **仅层闸仓**:没有片闸可跑,第 3 步跳过片闸,报告里写一行 `片闸 —(本仓未配,仅层闸仓)`,不写 PASS。
2. **基线与改动集合**:跑 `node ~/.claude/skills/verify/gates.mjs plan [用户给的基线]`。基线 = 用户给的 ref;没给就用 `main`,没有 `main` 用 `master`;两个都没有脚本退 2 → 报错让用户给基线,不猜。
   改动集合(`changed`)= `<基线>...HEAD` 的 diff + 未暂存 + 已暂存 + 未跟踪,去重。仅层闸仓 `verdict` 为 `NO-CHANGE` / `EXEMPT` → 照结论报告,停;片闸仓不看这条,照旧跑片闸(片闸自己按基线判)。
3. **跑闸**,在 `$root` 下:
   - 片闸(仅片闸仓):`<sliceGate> <基线>`(没有 sliceGate 时用 `gate`,原样执行,不加基线)。
   - 层闸:`node ~/.claude/skills/verify/gates.mjs run [基线]` —— 跑 plan 的 `cmds`(已去重;命中 = 改动路径匹配 `pattern`),首行即结论,退出码 0 PASS/EXEMPT/NO-CHANGE · 1 FAIL · 3 NO-GATE · 4 ENV-ERROR。没命中的层闸不跑。不要自己 `bash -c` 跑层闸再手判:退 127 的环境错只有脚本分得出来。
   - 仅层闸仓:`verdict` 为 `NO-GATE`(有要验的路径但一条层闸都没命中)→ 一道闸都不跑,停。
   - 每道闸的输出写到 `/tmp/verify-<仓名>-<短 sha>/<序号>.log`(片闸照旧 `<序号>-<名字>.log`),长命令放后台,等它结束再读。
4. **`--full`**:配置里有 `fullGatesCmd` 就跑它;没有 → 报错 `verify: 本仓没配 fullGatesCmd`,不自己拼全量。
5. **判结果读日志,不只看退出码**:
   - 片闸日志末行要有 `PASS`(myapp:`gate-slice: PASS`),有 `FAIL` 行就是红;层闸看各自的汇总行(测试数、`0 fail`、validate 通过行等),退出码非 0 一律红。
6. **报告**,首行是结论:
   - 每道闸一行 `<闸> PASS|FAIL <关键行>`,仅层闸仓的片闸行写 `—(本仓未配)`;红的贴失败断言原文(≤ 20 行),不复述整段日志。
   - 仅层闸仓:再列 `未覆盖:<plan 的 uncovered>`(按目录归并,如 `relay/ 6 个文件`)和 `豁免:<plan 的 exempt 条数>`。未覆盖的路径**没有被验证过**,/commit 据此拦截。
   - `NO-GATE`:写「没有命中的闸」+ 改动路径(按目录归并)+ 一句「要验证这些路径,在 delegate.json 给它们配 layerGates」。
7. 红了不提交,不绕过(不加 `--no-verify`、不加 `eslint-disable` / `@ts-ignore` / `# noqa` 压错误)。

## 各仓现状(20.10)

| 仓 | 片闸 | 层闸 | 基线 |
|---|---|---|---|
| myapp | `scripts/dev/gate-slice.sh` | 5 条(迁移 replay · next build · mobile · functions · design);`fullGatesCmd` = `bash scripts/dev/full-gates.sh`(只在独占量测前 / 目标收尾 / 发版跑) | main |
| claude-mods | 未配(仅层闸仓) | 每个顶层目录一条(18 条,见仓内 delegate.json);`layerExempt` = `*.md` · `docs/` · 仓根 `.gitignore`;读数 `gates.mjs coverage` 与 `gates.mjs tests`(探针数没被闸执行的测试文件)都应为 0;每周一 07:30 `gates-weekly-readout.timer` 在干净 master worktree 上跑 `gates-readout.sh`,一行追加到 `~/.local/share/lead-harness/gates/claude-mods/weekly.jsonl`(status OK / REGRESSED / ENV;ENV 那轮作废,② 记 null,1 小时后重跑) | master |
| otherapp | `scripts/dev/gate-slice.sh`(干净 worktree 里要先软链主仓 `.env`,见 `worktreeSetup`) | 9 条补片闸盲区:proto-t typecheck + vitest + scripts/graph · console vitest · docs 链接 · scripts(factory-install --check · sh/mjs 语法 · scripts/dev 自有 bun 测试)· ops/tools 脚本语法 · .codex · docker-compose · .impeccable/.mcp.json · .claude;`sliceGateCovers` 声明片闸自己验的路径;`notTests` 按 `scripts/dev/.factory/*.json` 锁排除 factory 装件;每周一 08:30 `gates-weekly-readout-otherapp.timer` → `~/.local/share/lead-harness/gates/otherapp/weekly.jsonl` | main |
| 其他 | 以仓内配置为准 | | |
