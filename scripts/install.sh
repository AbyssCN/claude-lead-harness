#!/usr/bin/env bash
# One machine setup: checks tools, links `ticket` and `piw`, links skills and agents. Never overwrites an existing file.
set -uo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bin=${LH_BIN:-$HOME/.local/bin}; claude_dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
missing=0
need() { if command -v "$1" >/dev/null; then echo "ok    $1"; else echo "MISS  $1  ($2)"; missing=1; fi; }
opt()  { if command -v "$1" >/dev/null; then echo "ok    $1"; else echo "skip  $1  ($2)"; fi; }
need git    "required"
need node   "required, >= 22"
need claude "Claude Code"
need herdr  "https://herdr.dev  required for lead + ticket sessions"
need jq     "used by the example gate"
need rg     "ripgrep"
opt  pi       "default executor for piw; without it use --executor mcode|codex"
opt  mcode    "MiniMax Code executor, also the multimodal path"
opt  codex    "second family for cross-model review"
opt  bwrap    "sandbox for executors; without it they run with your user's rights"
opt  gitleaks "secret scan in the gate"
opt  vt       "VibeTunnel: watch and steer sessions from a phone"
node -e 'process.exit(+process.versions.node.split(".")[0]>=22?0:1)' 2>/dev/null || { echo "MISS  node >= 22"; missing=1; }
link() { if [ -e "$2" ] || [ -L "$2" ]; then echo "keep  $2"; else ln -s "$1" "$2" && echo "link  $2"; fi; }
mkdir -p "$bin" "$claude_dir/skills" "$claude_dir/agents"
link "$root/ticket/bin/ticket.mjs" "$bin/ticket"
link "$root/piw/bin/piw" "$bin/piw"
link "$root/scripts/send-to-ticket" "$bin/send-to-ticket"
for s in "$root"/skills/*/; do link "${s%/}" "$claude_dir/skills/$(basename "$s")"; done
for a in "$root"/agents/*.md; do link "$a" "$claude_dir/agents/$(basename "$a")"; done
case ":$PATH:" in *":$bin:"*) ;; *) echo "note  add $bin to PATH" ;; esac
cat <<M

Next, inside Claude Code:
  /plugin marketplace add $root
  /plugin install relay@claude-lead-harness      (repeat for cue delegate board agent-guard prompt-guard cache-clock)
  /reload-plugins
Then for each project:  scripts/init-repo.sh <repo>
Executor models:        cp examples/piw-config.json ~/.config/piw/config.json   and fill in the roles
herdr:                  docs/herdr.md
M
exit "$missing"
