#!/usr/bin/env bash
# omdl-launch.sh — 在 VibeTunnel(vt)里起一片 omd-lite run(默认 pi 执行器),闸 = 可选的切片闸 + 命令行给的额外闸。
# 用法:omdl-launch.sh <name> <base> <任务书> ["额外闸" ...]
#
# 环境变量(括号内为默认):
#   OMD_LITE_REPO        目标仓库(当前目录所在 git 仓的顶层)
#   OMD_LITE_BIN         omd-lite 可执行文件(本仓 ../omd-lite/bin/omd-lite)
#   OMD_LITE_MODEL       执行模型 provider/id(minimax-cp/MiniMax-M3.1-Flash-Preview)
#   OMD_LITE_PROMPT      提示词臂(omd-leaf)
#   OMD_LITE_SLICE_GATE  (可选)第一道闸,会以 "<它> <base>" 运行,如 scripts/dev/gate-slice.sh
#   OMD_LITE_MAX_ROUNDS  闸轮数(4)
#   WALL                 墙钟上限秒数(3600)
#   OMD_LITE_LOG_DIR     终端日志目录(/tmp/omdl-logs);产物在 ~/.omd-lite/runs/<name>/
#   密钥相关的 OMD_LITE_ENV_FILE 等见 omd-lite/README.md
#
# 注意:
# - 本脚本**前台阻塞**到 run 结束 —— 在 agent / 脚本里一律后台起(nohup … &),之后轮询 ~/.omd-lite/runs/<name>/meta.json 的 wall_seconds。
# - 任务书必须已提交进 <base>(仓内相对路径),否则 omd-lite 起 worktree 后即失败;失败用 <name>-r2 重来。
# - 并行起多片要错开 ≥ 10 s:同一秒起的 vt 会撞 IPC socket(Server.listen 报错,run 目录都不建)。
set -euo pipefail
[ $# -ge 3 ] || { sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
name=$1; base=$2; spec=$3; shift 3
repo="${OMD_LITE_REPO:-$(git rev-parse --show-toplevel)}"
bin="${OMD_LITE_BIN:-$HERE/../omd-lite/bin/omd-lite}"
model="${OMD_LITE_MODEL:-minimax-cp/MiniMax-M3.1-Flash-Preview}"
logdir="${OMD_LITE_LOG_DIR:-/tmp/omdl-logs}"
gates=()
[ -n "${OMD_LITE_SLICE_GATE:-}" ] && gates+=(--gate "$OMD_LITE_SLICE_GATE $base")
for g in "$@"; do gates+=(--gate "$g"); done
[ ${#gates[@]} -gt 0 ] || { echo "至少要一道闸:设 OMD_LITE_SLICE_GATE 或在命令行给额外闸" >&2; exit 1; }
mkdir -p "$logdir"
exec vt "$bin" run --repo "$repo" --base "$base" --spec "$spec" --model "$model" \
  --prompt "${OMD_LITE_PROMPT:-omd-leaf}" "${gates[@]}" --name "$name" \
  --max-rounds "${OMD_LITE_MAX_ROUNDS:-4}" --wall "${WALL:-3600}" > "$logdir/$name.log" 2>&1
