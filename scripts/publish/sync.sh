#!/usr/bin/env bash
# Regenerates the vendored directories of this repo from private sources, so they cannot drift by hand.
# Every source is read at its git HEAD; uncommitted work never ships.
#   LH_MODS_SRC  private mods monorepo   LH_PIW_SRC  private piw repo
#   LH_SKILLS_SRC  directory of user skills (default ~/.claude/skills)
#   LH_REWRITE   private sed file (default ~/.config/claude-lead-harness/rewrite.sed)
#   scripts/publish/manifest.txt lists what to copy; a leading `!` is an exclude glob.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); root=$(cd "$here/../.." && pwd)
mods=${LH_MODS_SRC:?set LH_MODS_SRC}; piw=${LH_PIW_SRC:?set LH_PIW_SRC}
sedf=${LH_REWRITE:-$HOME/.config/claude-lead-harness/rewrite.sed}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
git -C "$mods" archive HEAD | tar -x -C "$tmp" --one-top-level=mods-src
git -C "$piw" archive HEAD | tar -x -C "$tmp" --one-top-level=piw-src
skills=${LH_SKILLS_SRC:-$HOME/.claude/skills}
excludes=(); : >"$tmp/map"
while read -r kind a b; do
  case "$kind" in ''|\#*) ;; '!') excludes+=(--exclude "$a") ;; mods) echo "mods-src/$a $b" >>"$tmp/map" ;; piw) echo "piw-src/$a $b" >>"$tmp/map" ;; skill) mkdir -p "$tmp/skills-src"; rsync -aL "$skills/$a/" "$tmp/skills-src/$a/"; echo "skills-src/$a $b" >>"$tmp/map" ;; *) echo "bad manifest line: $kind" >&2; exit 2 ;; esac
done <"$here/manifest.txt"
while read -r src dst; do
  rm -rf "${root:?}/$dst"; mkdir -p "$root/$dst"
  rsync -a "${excludes[@]}" "$tmp/$src/" "$root/$dst/"
  find "$root/$dst" -type f ! -name '*.png' ! -name '*.jpg' -print0 | xargs -0 -r sed -i -E -f "$sedf"
  # file names can carry the same terms
  find "$root/$dst" -depth -print | while read -r p; do n=$(basename "$p" | sed -E -f "$sedf"); [ "$n" = "$(basename "$p")" ] || mv "$p" "$(dirname "$p")/$n"; done
done <"$tmp/map"
[ -d "$here/overlay" ] && rsync -a "$here/overlay/" "$root/"
{ echo "mods $(git -C "$mods" rev-parse HEAD)"; echo "piw $(git -C "$piw" rev-parse HEAD)"; } >"$root/scripts/publish/SOURCE.lock"
echo "sync: done; now run scripts/publish/scrub-check.sh"
