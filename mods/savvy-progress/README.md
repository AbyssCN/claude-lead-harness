> **已并入 board(2026-10-23)**:任务条、helper 卡、像素造型和计划工具都由 board 侧栏接管，计划工具改名 `mcp__board__plan`。本目录已从 marketplace 下架，不再维护。契约见 `docs/plan/2026-10-23-board-unified.md`。

# savvy-progress (lead-harness fork)

Fork of [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit) `plugins/savvy-progress` 1.2.0 (MIT, see `LICENSE`).
The fork keeps the name, so savvy-flow's tool names still match, and adds **omd-lite runs** and a Chinese UI (`language: zh`).

## omd-lite runs (fork)

savvy-progress only sees Claude Code's own subagents. This fork also tracks executors that
[omd-lite](../../omd-lite) starts outside Claude Code (`mcode`, `claude -p`, `pi`), **only runs launched from this session**:
savvy-progress has no scanner of its own: it reads `$.delegate.runs()` (this session and its /clear lineage) from the
[delegate](../delegate) mod, which it lists under `dependencies` in `.claude-plugin/plugin.json`. Keep delegate enabled;
without it the omd-lite section is empty and everything else still works. Runs started elsewhere do not show.

- **Band** under the prompt: the run, round `n/max`, executing or at the gates, tool calls, the tool in flight, tokens, time.
  It stays ten minutes after the last run ends; ✕ hides it; `×N` opens the panel.
- **Panel** (`/agents-info`): an `omd-lite` section, one row per run, with its result (`stuck-gate`, a failed gate, `interrupted`).
- **MiniMax** (mcode or a MiniMax model) is a peach pixel blob with the logo's waveform as its crest; the bars pump while it works.
  On the desktop it is SVG; in the terminal, half blocks.

Tests: `claude plugin test .` (band and panel). The scanner and its tests live in delegate (`node --test delegate/bin/scan.test.mjs`).

---

A Claude Code mod: a progress bar above the prompt and a live panel of subagents. Made for the [savvy-flow](../savvy-flow) skill, and useful with any subagents.

- **Progress bar**: the flow's title, phase, accepted tasks out of planned, and a button with the crew size that opens the panel. It appears once something reports progress (savvy-flow does) or a `savvy-*` worker starts.
- **Agents panel** (`/agents-info` toggles it): running, finished and planned subagents with model, effort, task progress, context, estimated cost and time. Working crabs walk, and each savvy tier animates its prop: the astronaut floats, the detective sweeps the magnifier, the engineer turns the wrench, the chef tosses the omelette, the racer runs with a fluttering flag. `prefers-reduced-motion` stops them.

## Tools it adds

- `mcp__savvy-progress__progress`: the orchestrator reports the plan, phase and accepted tasks.
- `mcp__savvy-progress__step`: a worker reports its own steps (`done`, `total`, `note`). A worker that does not report shows its context fill in grey instead.

Cost is a rough estimate from token counts and a built-in per-model price table (`PRICES` in `hooks/register.tsx`), not a bill.

## Settings

`language`: `auto` (default), `en`, `ru` or `zh`. `auto` follows Claude Code's `language` setting, then the system locale, and falls back to English. Set it in `/config`, or, for a mod loaded by hand, in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "savvy-progress": { "options": { "language": "ru" } } } }
```

Install instructions are in the [repository README](../../README.md).
