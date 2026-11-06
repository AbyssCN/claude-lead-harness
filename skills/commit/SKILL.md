---
name: commit
tier: foundation
runtime: on-demand
trigger: mention
description: "git commit:先按仓内 `.claude/delegate.json` 跑 /verify(没配闸就报错不提交;仅层闸仓里要提交的路径必须被 PASS 的层闸覆盖,否则不提交),只 stage 本次改动的显式路径,写中文 conventional message。不做 PR / 合并 / push(除非用户明说)。Trigger: 提交 / commit / 保存变更 / git commit / 提交代码 / 帮我提交。Skip: 仅验证不提交 (/verify) / 代码审查 (/code-review)。"
metadata:
  version: "4.3.0"
  note: "15.10 改写:旧版是 rcmux 口径(bunx tsc / bun test、--ship 走 PR、带 Co-Authored-By 署名行 —— myapp 的 git 闸会拒这种提交)。"
---
# /commit — 验证后提交

## 步骤

1. **看改动**:`git status --short` + `git diff --stat`。分清哪些是本次任务的改动、哪些是别的会话 / 别的任务留下的未跟踪文件 —— 后者不碰、不 stage,报告里点名。
2. **验证**:照 `/verify` 的步骤跑(读 `<仓根>/.claude/delegate.json`;一道闸都没配 → 报错并**停止,不提交**)。闸红(`FAIL`)→ 不提交,报红在哪。
   - 片闸仓(有 sliceGate / gate):片闸绿 + 命中的层闸绿 → 可以提交,和以前一样。
   - 仅层闸仓(只有 layerGates,如 claude-mods):先定好第 3 步要 stage 的路径,跑 `node ~/.claude/skills/verify/gates.mjs check <这些路径>`(和 /verify 同一个脚本、同一份 `layerExempt`)。退 0 = 每个路径要么被层闸命中、要么在 `layerExempt` 里;命中的那些层闸必须本次 /verify 跑过且 PASS。退 1 → 它列出的路径没有闸 → **停止,不提交**,报「这些路径没有闸:…,在 delegate.json 给它们配 layerGates 再提交」。不许自己另判哪些路径豁免。工作区里别的会话留下的未覆盖改动不 stage,就不挡这次提交。
   - /verify 结论 `ENV-ERROR`(闸命令找不到,如 claude CLI 正在自动更新):不是代码红,也没验过 → 不提交;再跑一次 /verify(脚本会再等命令就位),仍是 `ENV-ERROR` 就停,报「环境错:<命令> 找不到,闸没跑成」,不要当 FAIL 去改代码,也不要当 PASS 提交。
   - /verify 结论 `EXEMPT`(要提交的全是豁免路径)→ 可以提交,报告写「全是豁免路径,未跑闸」。
   - 只有用户在这一轮明确说「这些不过闸也提交」时才放行未覆盖路径,并在提交正文写一行 `未过闸:<路径>(用户明确同意)`。不许自己判断「改动很小」就放行。
   - 片闸仓:只改了纯文档(`*.md`)的提交可跳过闸,报告里写明「纯文档,未跑闸」。仅层闸仓的豁免只看 `layerExempt`(上面 check 子命令),不另套这条。
3. **stage**:只 `git add -- <显式路径>`;不用 `git add -A` / `git add .`(会带进别的会话的文件、临时产物、截图)。
4. **提交信息**:`<type>(<scope>): <中文一句话>`,type ∈ feat · fix · refactor · test · docs · chore · perf;正文写「为什么」与验证读数(一两行)。
   - **不加任何署名行**(`Co-Authored-By` 等):myapp 的 git 闸会拒带 Claude 署名的提交,各仓 CLAUDE.md 也这么定。
   - 遵守仓内 CLAUDE.md 的写作规则(如 myapp 的禁用词表)。
5. **不 push、不合并、不开 PR**,除非用户这一次明说;合并走仓内配置的 `merge` 脚本(myapp:`scripts/dev/omdl-merge.sh`)。
6. 报告:提交 sha · 文件清单 · 闸读数(或「纯文档未跑闸」;仅层闸仓写明每个 stage 路径由哪条层闸覆盖)。
