#!/usr/bin/env bash
# mcode.sh — 启动一个 MiniMax Code(mcode)执行会话:一片一会话、一个独占 worktree、在 VibeTunnel(vt)里可看可插话。
# 用法:mcode.sh <名字> <任务书路径> [base=main]
#   → 建 worktree(agent-wt.sh)→ 在里面以执行者身份启动 `vt mcode "<开工提示>"`。
#
# 环境变量:
#   AGENT_WT_REPO / AGENT_WT_ROOT / AGENT_WT_SCOPE   透传给 agent-wt.sh
#   EXECUTOR_BRIEF   仓内执行者须知的相对路径(默认 docs/process/executor-brief.md;不存在就不提)
#   AGENT_GUARD_BIN  (可选)执行体闸目录,放到 PATH 最前,用来拦 pkill / killall 之类
#
# 所有执行会话都带 UNTRUSTED_AGENT=1。目标仓若有 git hook 认这个标记,就可以据此拦删分支 / 动主干 / push / 冒名提交;
# 那些 hook 和闸目录属于目标仓自己(原项目里的实现没有随本仓发布),没有它们时这个标记无害。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
name="${1:?用法: mcode.sh <名字> <任务书路径> [base]}"
spec="${2:?用法: mcode.sh <名字> <任务书路径> [base]}"
base="${3:-main}"
[ -f "$spec" ] || { echo "任务书不存在:$spec" >&2; exit 1; }
spec_abs="$(cd "$(dirname "$spec")" && pwd)/$(basename "$spec")"
wt="$("$HERE/agent-wt.sh" "$name" "$base")"
[ -n "${AGENT_GUARD_BIN:-}" ] && export PATH="$AGENT_GUARD_BIN:$PATH"
export UNTRUSTED_AGENT=1
cd "$wt"
brief_path="${EXECUTOR_BRIEF:-docs/process/executor-brief.md}"
brief=""; [ -f "$brief_path" ] && brief="先读 $brief_path,再"
prompt="WORKTREE: $wt
你是执行者。${brief}读任务书 $spec_abs,按任务书只做这一片。完成后按须知 / 任务书要求的收尾报告格式回报,然后停下等待。"
exec vt mcode "$prompt"
