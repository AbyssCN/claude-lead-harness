#!/usr/bin/env bash
# Slice gate: what every executor round must pass. Exit code is the only verdict.
# Usage: gate-slice.sh [base]   Fill in your own commands; keep it under a few minutes.
set -euo pipefail
base=${1:-main}
changed=$(git diff --name-only "$base"...HEAD; git status --porcelain | awk '{print $2}')
[ -n "$changed" ] || { echo "gate-slice: no changes against $base" >&2; exit 1; }
if [ -f package.json ]; then
  jq -e '.scripts.typecheck' package.json >/dev/null && npm run -s typecheck
  jq -e '.scripts.lint' package.json >/dev/null && npm run -s lint
  jq -e '.scripts.test' package.json >/dev/null && npm test --silent
elif [ -f Makefile ]; then
  make test
else
  echo "gate-slice: fill in your checks in $0" >&2; exit 1
fi
command -v gitleaks >/dev/null && gitleaks git --no-banner --redact -l error --log-opts="$base..HEAD"
echo "gate-slice: PASS"
