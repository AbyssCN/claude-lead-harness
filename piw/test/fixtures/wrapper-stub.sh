#!/usr/bin/env bash
# --exec-wrapper 替身:把 <worktree> -- <cmd…> 记进 WRAPPER_LOG,再原样执行命令
printf '%s\n' "$*" >> "${WRAPPER_LOG:?}"
wt=$1; shift; [ "$1" = "--" ] && shift
exec "$@"
