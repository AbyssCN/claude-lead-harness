#!/usr/bin/env bash
# S11 上线:omd-lite 改名 piw(目录 + 软链 + PATH 入口 + 线上脚本的 pgrep 锚 + resumedFrom 映射 + settings.json)。
#
# 只在 owner 上线时执行;本仓的 S11 分支只写了这个脚本,没有执行过。幂等:每一步先看是不是已经做完,做完就跳过;
# 随时可以重跑。用法:
#   deploy/s11-rename.sh --dry-run    只打印每一步会做什么(不改任何东西,也不要求 run 为 0)
#   deploy/s11-rename.sh              执行
#
# 前置:
#   1. omd-lite 的 s11-piw-rename 分支已合进 ~/repos/omd-lite 的 main(带 bin/piw 和 bin/omd-lite -> piw 软链);
#   2. 没有在跑的 run:pgrep -fc '^node [^ ]*/(omd-lite|piw) run' 为 0(有就整个脚本退出,什么都不动)。
#      锚在行首的 `node …` 上,免得把调用方 shell 命令行里的这串字也数进去(vibetunnel 的 fwd 进程同理)。
#
# 做什么(顺序即执行顺序;每步改线上文件前先备份成 <文件>.bak-S11,备份已存在就不覆盖):
#   A. ~/repos/omd-lite 改名 ~/repos/piw,原路径留一条软链 omd-lite -> piw(绝对路径的调用方不用改),git worktree repair
#   B. ~/repos/piw/bin/omd-lite 是指向 piw 的软链(分支里已带;缺则补)
#   C. ~/.local/bin/piw -> ~/repos/piw/bin/piw(piw 进 PATH)
#   D. ~/.omd-lite/bin/slot-run.sh:pgrep 锚认 (omd-lite|piw)
#   E. ~/.claude/bin/prune-agent-worktrees.sh:认 resumedFrom 映射(deploy/prune-agent-worktrees.sh.patch)
#   F. ~/.claude/settings.json:pluginConfigs["agent-guard@owner-mods"].options.requireWorktreeRepos 加 piw(保留 omd-lite)
#
# 不碰:~/.omd-lite/runs、omdl/ 与 omdl- 前缀、OMD_LITE_OUT 的写出、~/.config/piw、~/.pi。
# 回滚:把 .bak-S11 备份放回原处;rm ~/.local/bin/piw;rm ~/repos/omd-lite && mv ~/repos/piw ~/repos/omd-lite && git -C ~/repos/omd-lite worktree repair。
#
# 环境变量(测试用,线上不用设):S11_REPOS(默认 $HOME/repos)、S11_PGREP_PATTERN。其余路径都从 $HOME 来。
set -euo pipefail
shopt -u patsub_replacement 2>/dev/null || true

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  "") ;;
  *) echo "用法: $0 [--dry-run]" >&2; exit 2 ;;
esac

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPOS=${S11_REPOS:-$HOME/repos}
OLD=$REPOS/omd-lite
NEW=$REPOS/piw
PATTERN=${S11_PGREP_PATTERN:-'^node [^ ]*/(omd-lite|piw) run'}
SLOT_RUN=$HOME/.omd-lite/bin/slot-run.sh
PRUNE=$HOME/.claude/bin/prune-agent-worktrees.sh
SETTINGS=$HOME/.claude/settings.json
PIW_LINK=$HOME/.local/bin/piw

changed=0
say() { printf '%s\n' "$*"; }
done_() { say "跳过(已完成):$*"; }
act() { # act <说明> <命令…>:dry-run 只打印
  say "$([ "$DRY" = 1 ] && echo '[dry-run] 将做' || echo '做')：$1"
  shift
  if [ "$DRY" = 0 ]; then "$@"; changed=$((changed + 1)); fi
}
backup() { # 改线上文件前备份一次,已有备份不覆盖
  local f=$1
  [ -e "$f.bak-S11" ] || cp -p "$f" "$f.bak-S11"
}

rename_dir() { mv "$1" "$2" && ln -s piw "$1"; }
repair_worktrees() { git -C "$1" worktree repair >/dev/null 2>&1 || true; }
link_into_path() { mkdir -p "$(dirname "$2")" && ln -sfn "$1" "$2"; }
# 换掉文件里的一段字面文本。写新文件再 mv(新 inode):正在跑的 bash 脚本是边读边执行的,原地改会让它们读到错位的内容。
replace_in_file() { # <文件> <旧> <新>
  local f=$1 old=$2 new=$3 tmp content
  backup "$f"
  tmp=$(mktemp "$f.XXXXXX")
  content=$(cat "$f")
  printf '%s\n' "${content//"$old"/$new}" > "$tmp"
  chmod --reference="$f" "$tmp"
  mv "$tmp" "$f"
}
patch_file() { # <文件> <补丁>:同样先备份,补丁写进新文件再 mv
  local f=$1 p=$2 tmp
  backup "$f"
  tmp=$(mktemp "$f.XXXXXX")
  cp -p "$f" "$tmp"
  patch -s -p1 "$tmp" < "$p"
  mv "$tmp" "$f"
}
add_piw_to_settings() { # <settings.json>
  local f=$1 tmp
  backup "$f"
  tmp=$(mktemp "$f.XXXXXX")
  jq '.pluginConfigs["agent-guard@owner-mods"].options.requireWorktreeRepos |= (. + ",piw")' "$f" > "$tmp"
  jq -e . "$tmp" >/dev/null
  chmod --reference="$f" "$tmp"
  mv "$tmp" "$f"
}

# ── 0. run 必须为 0 ─────────────────────────────────────────────────────────────────────
running=$(pgrep -fc "$PATTERN" || true)
if [ "${running:-0}" -ne 0 ]; then
  if [ "$DRY" = 1 ]; then say "注意:现在有 $running 个 run 在跑;真执行会在这一步退出(--dry-run 只报告)。"
  else say "有 $running 个 run 在跑(pgrep -fc '$PATTERN'),不改名。等它们结束再来。" >&2; exit 3; fi
else
  say "在跑的 run:0。"
fi

# ── A. 目录改名 + 旧路径软链 ────────────────────────────────────────────────────────────
if [ -d "$NEW" ] && [ -L "$OLD" ] && [ "$(readlink -f "$OLD")" = "$(readlink -f "$NEW")" ]; then
  done_ "A 目录已改名($OLD -> $NEW)"
elif [ -d "$OLD" ] && [ ! -L "$OLD" ] && [ ! -e "$NEW" ]; then
  [ -e "$OLD/bin/piw" ] || { say "$OLD/bin/piw 不存在:先把 s11-piw-rename 合进 omd-lite 的 main 再来。" >&2; exit 4; }
  act "A mv $OLD $NEW && ln -s piw $OLD" rename_dir "$OLD" "$NEW"
  # 其它 worktree(omd-lite-wt-*、agents-omd-lite/*)的 .git 文件里写的是旧的绝对路径,软链让它们仍然可用;repair 把它们改指新路径
  act "A git -C $NEW worktree repair(尽力而为,失败不影响)" repair_worktrees "$NEW"
else
  say "A 状态不对(OLD=$([ -L "$OLD" ] && echo 软链 || { [ -d "$OLD" ] && echo 目录 || echo 不存在; }),NEW=$([ -e "$NEW" ] && echo 存在 || echo 不存在)),不自动处理。" >&2
  exit 4
fi

# ── B. bin/omd-lite -> piw ──────────────────────────────────────────────────────────────
TARGET=$NEW/bin/piw
LEGACY_BIN=$NEW/bin/omd-lite
if [ "$DRY" = 1 ] && [ ! -e "$TARGET" ]; then TARGET=$OLD/bin/piw; LEGACY_BIN=$OLD/bin/omd-lite; fi   # dry-run 时目录还没改名
if [ -L "$LEGACY_BIN" ] && [ "$(readlink -f "$LEGACY_BIN")" = "$(readlink -f "$TARGET")" ]; then
  done_ "B bin/omd-lite 已是指向 piw 的软链"
elif [ -e "$TARGET" ]; then
  act "B ln -sfn piw $LEGACY_BIN" ln -sfn piw "$LEGACY_BIN"
else
  say "B $TARGET 不存在,不能补软链。" >&2; exit 4
fi

# ── C. ~/.local/bin/piw ─────────────────────────────────────────────────────────────────
if [ -L "$PIW_LINK" ] && [ "$(readlink "$PIW_LINK")" = "$NEW/bin/piw" ]; then
  done_ "C $PIW_LINK 已指向 $NEW/bin/piw"
else
  act "C ln -sfn $NEW/bin/piw $PIW_LINK" link_into_path "$NEW/bin/piw" "$PIW_LINK"
fi

# ── D. slot-run.sh 的 pgrep 锚 ──────────────────────────────────────────────────────────
OLD_ANCHOR="'^node /home/user/repos/omd-lite/bin/omd-lite run'"
NEW_ANCHOR="'^node [^ ]*/(omd-lite|piw) run'"
if [ ! -f "$SLOT_RUN" ]; then
  say "D $SLOT_RUN 不存在,跳过。"
elif grep -qF "$NEW_ANCHOR" "$SLOT_RUN"; then
  done_ "D slot-run.sh 的锚已认两个名字"
elif grep -qF "$OLD_ANCHOR" "$SLOT_RUN"; then
  act "D slot-run.sh:pgrep 锚改成 $NEW_ANCHOR(备份 .bak-S11)" replace_in_file "$SLOT_RUN" "$OLD_ANCHOR" "$NEW_ANCHOR"
else
  say "D slot-run.sh 里找不到已知的 pgrep 锚,不自动改:请人工核对 $SLOT_RUN" >&2
  exit 5
fi

# ── E. prune-agent-worktrees.sh 认 resumedFrom ──────────────────────────────────────────
PATCH=$HERE/prune-agent-worktrees.sh.patch
if [ ! -f "$PRUNE" ]; then
  say "E $PRUNE 不存在,跳过。"
elif grep -q 'resumed_done' "$PRUNE"; then
  done_ "E prune-agent-worktrees.sh 已认 resumedFrom"
elif patch --dry-run -s -p1 "$PRUNE" < "$PATCH" >/dev/null 2>&1; then
  act "E prune-agent-worktrees.sh:应用 $PATCH(备份 .bak-S11)" patch_file "$PRUNE" "$PATCH"
else
  say "E 补丁套不上($PRUNE 和打补丁时的版本不一样),不自动改:人工对着 $PATCH 改。" >&2
  exit 5
fi

# ── F. settings.json:requireWorktreeRepos 加 piw ────────────────────────────────────────
if [ ! -f "$SETTINGS" ]; then
  say "F $SETTINGS 不存在,跳过。"
else
  cur=$(jq -r '.pluginConfigs["agent-guard@owner-mods"].options.requireWorktreeRepos // empty' "$SETTINGS")
  if [ -z "$cur" ]; then
    done_ "F settings.json 里没有 requireWorktreeRepos(用插件默认值;agent-guard 代码里会自动补 piw)"
  elif printf '%s' "$cur" | tr ',' '\n' | grep -qx 'piw'; then
    done_ "F requireWorktreeRepos 已含 piw($cur)"
  else
    act "F settings.json:requireWorktreeRepos \"$cur\" -> \"$cur,piw\"(备份 .bak-S11)" add_piw_to_settings "$SETTINGS"
  fi
fi

say ""
if [ "$DRY" = 1 ]; then say "dry-run 结束,没有改任何东西。"
elif [ "$changed" -eq 0 ]; then say "全部已完成,什么都没改。"
else say "完成,改了 $changed 处。收尾:新开会话让 settings.json 生效;验证 readlink -f $OLD/bin/omd-lite、command -v piw、cd $NEW && node --test test/。"; fi
