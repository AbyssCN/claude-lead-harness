#!/usr/bin/env bash
# Public-repo gate. Fails on secrets, and on any term in a private denylist kept OUTSIDE this repo
# ($SCRUB_TERMS, default ~/.config/claude-lead-harness/scrub-terms.txt; absent = only the generic checks).
# Usage: scrub-check.sh [dir]   (default: every tracked file plus untracked non-ignored files)
set -euo pipefail
root=${1:-$(git rev-parse --show-toplevel)}
terms=${SCRUB_TERMS:-$HOME/.config/claude-lead-harness/scrub-terms.txt}
cd "$root"
rc=0
if command -v gitleaks >/dev/null; then
  gitleaks dir . --no-banner --redact -l error || rc=1
else
  echo "scrub-check: gitleaks not installed" >&2; rc=1
fi
generic='-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-ant-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9]{32,}|ghp_[a-zA-Z0-9]{30,}'
if rg -n --hidden -g '!.git' -g '!scripts/publish/scrub-check.sh' -e "$generic" .; then rc=1; fi
if [ -f "$terms" ]; then
  mapfile -t pats < <(rg -v '^(#|$)' "$terms")
  args=(); for p in "${pats[@]}"; do args+=(-e "$p"); done
  if rg -n -i --hidden -g '!.git' "${args[@]}" . ; then rc=1; fi
fi
[ "$rc" = 0 ] && echo "scrub-check: PASS" || echo "scrub-check: FAIL"
exit "$rc"
