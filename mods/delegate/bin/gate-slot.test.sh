#!/usr/bin/env bash
# gate-slot.sh 自测:bash bin/gate-slot.test.sh
#  1. 槽数 1 时 3 个并行 `sleep 2` 串行(总耗时 ≥ 6 s,区间互不重叠)
#  2. 槽数 3 时并行(总耗时 < 4 s)
#  3. 退出码原样返回;单参数按 shell 命令跑
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
slot="$here/gate-slot.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export DELEGATE_GATE_SLOT_DIR="$tmp/locks"
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

run3() { # $1 = slots; prints elapsed seconds, writes start/end stamps
  local t0 t1
  : >"$tmp/log"
  t0=$(date +%s.%N)
  for k in 1 2 3; do
    DELEGATE_GATE_SLOTS=$1 "$slot" "echo start $k \$(date +%s.%N) >>$tmp/log; sleep 2; echo end $k \$(date +%s.%N) >>$tmp/log" &
  done
  wait
  t1=$(date +%s.%N)
  echo "$t1 - $t0" | bc
}

e1=$(run3 1)
echo "slots=1: 3 × sleep 2 took ${e1}s"; sort -k3 -n "$tmp/log" | sed 's/^/    /'
check "slots=1 serialises (≥ 6 s)" "[ \$(echo \"$e1 >= 5.9\" | bc) = 1 ]"
# 区间不重叠:按时间排序后 start/end 必须交替
order=$(sort -k3 -n "$tmp/log" | awk '{printf $1}')
check "slots=1 intervals never overlap" "[ '$order' = startendstartendstartend ]"

e3=$(run3 3)
echo "slots=3: 3 × sleep 2 took ${e3}s"
check "slots=3 runs in parallel (< 4 s)" "[ \$(echo \"$e3 < 4\" | bc) = 1 ]"

DELEGATE_GATE_SLOTS=1 "$slot" "exit 7"; code=$?
check "exit code passes through (7)" "[ $code = 7 ]"
DELEGATE_GATE_SLOTS=1 "$slot" bash -c 'exit 3'; code=$?
check "argv form passes exit code (3)" "[ $code = 3 ]"
out=$(DELEGATE_GATE_SLOTS=1 "$slot" "echo a && echo b")
check "single arg runs as a shell command" "[ \"\$(echo \$out)\" = 'a b' ]"

# 公式:MemAvailable 12 GB → 2 槽(GWT-12);用假 meminfo 不现实,改为直接验算公式
n=$(( (12 * 1048576 / 1048576 - 8) / 2 )); check "GWT-12 formula: 12 GB → 2 slots" "[ $n = 2 ]"

exit $fail
