#!/bin/bash
# 层闸每周读数:在干净 worktree 上跑 gates.mjs coverage(①)与 tests(②),往 jsonl 追加一行。
# 用法: gates-readout.sh <仓路径> [ref,默认 master]   (systemd 里 READOUT_REF / READOUT_PATH 可覆盖 ref 与 PATH,判官用)
# 一行:date · ref · sha · status · ① · ①paths · ② · ②files · gates[{patterns,status}] · envMissing
#   status = OK(①=0 且 ②=0 且闸全绿;FLAKY = 红了重跑一次绿,照记在 flaky 栏,不算回归)· REGRESSED · ENV(有闸命令找不到:本轮作废,②记 null,不算 0 也不算回退,1 小时后 systemd 重跑)
# 退出码 0 OK · 2 REGRESSED · 75 ENV
set -uo pipefail
repo=${1:?用法: gates-readout.sh <仓路径> [ref]}
ref=${READOUT_REF:-${2:-master}}
[ -n "${READOUT_PATH:-}" ] && export PATH=$READOUT_PATH
G=$(dirname "$(readlink -f "$0")")/gates.mjs
name=$(basename "$repo")
out=${READOUT_DIR:-$HOME/.local/share/owner-mods/gates/$name}
mkdir -p "$out"

sha=$(git -C "$repo" rev-parse --short "$ref") || exit 1
# 路径固定(不带 sha):片闸按仓根路径给闸库起名(otherapp_gate_<md5>),路径每次变就每周多建一个库
wt=$HOME/.cache/gates-readout-$name
[ -e "$wt" ] && { git -C "$repo" worktree remove --force "$wt"; git -C "$repo" worktree prune; }
git -C "$repo" worktree add -q --detach "$wt" "$sha" || exit 1
trap 'git -C "$repo" worktree remove --force "$wt"; git -C "$repo" worktree prune' EXIT
# 仓自己的 worktree 准备(delegate.json 的 worktreeSetup,如 otherapp:软链主仓 .env + bun install)
setup=$(jq -r '.worktreeSetup // empty' "$wt/.claude/delegate.json" 2>/dev/null)
if [ -n "$setup" ]; then (cd "$wt" && bash -c "$setup") || { echo "worktreeSetup 失败:$setup" >&2; exit 1; }; fi

cov=$(cd "$wt" && node "$G" coverage --json) || { echo "coverage 失败" >&2; exit 1; }
logs=$out/logs/$sha
tst=$(cd "$wt" && GATES_LOG_DIR=$logs node "$G" tests --json 2>"$out/tests-stderr.log" | tail -1)
[ -n "$tst" ] || { echo "tests 没出读数,见 $out/tests-stderr.log" >&2; exit 1; }

line=$(jq -nc --arg date "$(date -Iseconds)" --arg ref "$ref" --arg sha "$sha" --arg logs "$logs" --argjson c "$cov" --argjson t "$tst" '
  ($t.gates | map({patterns, status})) as $g
  | (if $t.env then "ENV"
     elif ($c.uncovered == 0 and $t.missing == 0 and ($g | all(.status == "PASS" or .status == "FLAKY"))) then "OK"
     else "REGRESSED" end) as $status
  | {date: $date, ref: $ref, sha: $sha, status: $status, logs: $logs,
     "①": $c.uncovered, "①paths": $c.paths,
     "②": $t.missing, "②files": $t.files, "②total": $t.total,
     gates: $g,
     flaky: [$g[] | select(.status == "FLAKY") | .patterns[]],
     envMissing: ([$t.gates[] | select(.status == "ENV") | .envMissing] | unique)}')
echo "$line" >> "$out/weekly.jsonl"
echo "$line"
case $(jq -r .status <<<"$line") in OK) exit 0 ;; ENV) exit 75 ;; *) exit 2 ;; esac
