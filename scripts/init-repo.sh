#!/usr/bin/env bash
# Adds the harness files to a project. Existing files are left alone. Afterwards edit the placeholders.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo=$(cd "${1:?usage: init-repo.sh <repo>}" && git rev-parse --show-toplevel)
put() { mkdir -p "$(dirname "$repo/$2")"; if [ -e "$repo/$2" ]; then echo "keep  $2"; else cp "$root/$1" "$repo/$2" && echo "add   $2"; fi; }
put examples/CLAUDE.md          CLAUDE.md
put examples/delegate.json      .claude/delegate.json
put examples/executor-brief.md  docs/process/executor-brief.md
put examples/gate-slice.sh      scripts/dev/gate-slice.sh
put scripts/omdl-launch.sh      scripts/dev/omdl-launch.sh
put scripts/agent-wt.sh         scripts/dev/agent-wt.sh
[ -e "$repo/scripts/dev/sensitive-paths.txt" ] || { printf '# one bash pattern per line: paths that need a security section and cross-model review\n' >"$repo/scripts/dev/sensitive-paths.txt"; echo "add   scripts/dev/sensitive-paths.txt"; }
chmod +x "$repo"/scripts/dev/*.sh
cat <<M

Open this repo once in Claude Code and accept the trust dialog, or ticket sessions stop there.

Edit before first use:
  CLAUDE.md                 replace <your-app> and the project sections
  scripts/dev/gate-slice.sh your real checks; a gate that cannot go red protects nothing
  .claude/delegate.json     layer gates for your repo
The slice gate fails on an empty diff by design: a run that changed nothing is not a success.
M
