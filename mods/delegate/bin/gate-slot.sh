#!/usr/bin/env bash
# gate-slot.sh <cmd…> —— 片闸按内存排队(契约 C-5 / D-16)。
# 槽数 = max(1, ⌊(MemAvailable_GB − 8) ÷ 2⌋),每次取槽前重读 /proc/meminfo;
# 用 flock 在 $DELEGATE_GATE_SLOT_DIR(默认 /tmp/delegate-gate-slots)/<i>.lock 上取一个空槽,然后 exec 原命令,退出码原样返回。
# 一个参数 = 一整条 shell 命令(bash -c);多个参数 = argv 原样 exec。
# 环境:DELEGATE_GATE_SLOTS=<n> 强制槽数(测试 / 手动限流);DELEGATE_GATE_RESERVE_GB(默认 8)· DELEGATE_GATE_PER_GB(默认 2)。
# 注意:排队时间算在 omd-lite 单道闸的 15 分钟超时里。
set -u
[ $# -ge 1 ] || { echo "用法: gate-slot.sh <cmd…>" >&2; exit 2; }
dir="${DELEGATE_GATE_SLOT_DIR:-/tmp/delegate-gate-slots}"
mkdir -p "$dir"

slots() {
  if [ -n "${DELEGATE_GATE_SLOTS:-}" ]; then echo "$DELEGATE_GATE_SLOTS"; return; fi
  local kb n
  kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null)
  n=$(( (${kb:-0} / 1048576 - ${DELEGATE_GATE_RESERVE_GB:-8}) / ${DELEGATE_GATE_PER_GB:-2} ))
  [ "$n" -lt 1 ] && n=1
  echo "$n"
}

waited=0
while :; do
  n=$(slots)
  for ((i = 0; i < n; i++)); do
    exec 9>"$dir/$i.lock"
    if flock -n 9; then
      [ "$waited" -gt 0 ] && echo "gate-slot: 等了 ${waited} s,拿到槽 $i/$n" >&2
      export DELEGATE_GATE_SLOT="$i"
      if [ $# -eq 1 ]; then exec bash -c "$1"; else exec "$@"; fi
    fi
    exec 9>&-
  done
  [ "$waited" -eq 0 ] && echo "gate-slot: $n 个槽全占,排队…" >&2
  sleep 1
  waited=$((waited + 1))
done
