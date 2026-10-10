#!/usr/bin/env bash
# agent-wt.sh — 给一个写代码的子 agent 建独占 worktree(一个 agent 一个目录;共享目录的 agent 会互相踩改动)。
# 用法:agent-wt.sh <name> [base=main]   → 打印 worktree 绝对路径;派遣 prompt 里写一行「WORKTREE: <路径>」。
# (可选)配合 agent-guard 类 mod:只放行带这一行、且路径是独立、干净、没派过的 worktree。
#
# 环境变量:
#   AGENT_WT_REPO   目标仓库(默认:当前目录所在 git 仓的顶层)
#   AGENT_WT_ROOT   worktree 放哪(默认:<仓库父目录>/<仓库名>-agents)
#   AGENT_WT_SCOPE  monorepo 工作区包的 npm scope,如 @myapp(默认空 = 不特殊处理)
set -euo pipefail
name="${1:?用法: agent-wt.sh <name> [base]}"
base="${2:-main}"
[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "name 只许小写字母 / 数字 / 连字符" >&2; exit 1; }
repo="$(git -C "${AGENT_WT_REPO:-$PWD}" rev-parse --show-toplevel)"
root="${AGENT_WT_ROOT:-$(dirname "$repo")/$(basename "$repo")-agents}"
scope="${AGENT_WT_SCOPE:-}"
wt="$root/$name"
[ -e "$wt" ] && { echo "已存在:$wt(换个名字;一个 agent 一个目录)" >&2; exit 1; }
mkdir -p "$root"
git -C "$repo" worktree add -q -b "agent/$name" "$wt" "$base"
# node_modules:根目录建成真目录,逐项软链到主仓(免 npm install)。
# 工作区包(node_modules/<scope>/* → ../../packages/*)单独处理:整个根 node_modules 软链过去时,
# 它们会解析回主仓的代码,跨包测试测的是主仓旧代码。所以 <scope>/* 重建成指向本 worktree 的相对链接。
# 子包自己的 node_modules 一般没有工作区包,整目录软链即可。
if [ -d "$repo/node_modules" ]; then
  mkdir "$wt/node_modules"
  for e in "$repo"/node_modules/* "$repo"/node_modules/.[!.]*; do
    [ -e "$e" ] || continue
    n="$(basename "$e")"
    [ -n "$scope" ] && [ "$n" = "$scope" ] && continue
    ln -s "$e" "$wt/node_modules/$n"
  done
  if [ -n "$scope" ] && [ -d "$repo/node_modules/$scope" ]; then
    mkdir "$wt/node_modules/$scope"
    for l in "$repo/node_modules/$scope"/*; do
      ln -s "$(readlink "$l")" "$wt/node_modules/$scope/$(basename "$l")"   # 相对链接 ../../packages/x,落在本 worktree
    done
  fi
fi
for d in "$repo"/apps/*/node_modules "$repo"/packages/*/node_modules "$repo"/services/*/node_modules; do
  [ -d "$d" ] || continue
  rel="${d#"$repo"/}"
  ln -s "$d" "$wt/$rel"
done
# 仓根的 Python venv(.venv*)也软链过去:没有它,依赖 venv 的测试可能 skipIf 静默跳过。
for v in "$repo"/.venv*; do
  [ -d "$v" ] && ln -s "$v" "$wt/$(basename "$v")"
done
sha="$(git -C "$wt" rev-parse HEAD)"
printf "name=%s\nbase=%s\nsha=%s\n" "$name" "$base" "$sha" > "$(git -C "$wt" rev-parse --absolute-git-dir)/agent-wt"
echo "$wt"
