# savvy-progress (fork)

Progress bar above the prompt plus a live agents panel for Claude Code subagents, extended to also track omd-lite executor runs.

> **Forked from [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit) `plugins/savvy-progress` 1.2.0 (MIT, see `LICENSE`).**
> Changes in this fork:
> - 跟踪本会话启动的 omd-lite run(`bin/omd-scan.mjs` + 提示框下方的 band + 面板里的 `omd-lite` 一节);
> - MiniMax 执行器的像素形象(桌面端 SVG,终端半块字符);
> - 中文界面(`language: zh`);
> - runs 目录可用环境变量 `OMD_LITE_RUNS_DIR` 覆盖。
>
> 保留原名,所以 savvy-flow 的工具名照样对得上。

## 功能(上游)

- **进度条**:flow 标题、阶段、已验收 / 计划任务数,以及打开面板的按钮。有东西上报进度(savvy-flow 会)或 `savvy-*` worker 启动后出现。
- **Agents 面板**(`/agents-info` 开关):运行中、已结束、计划中的子 agent,含模型、effort、任务进度、上下文、估算花费与耗时。`prefers-reduced-motion` 时停动画。
- 新增工具:
  - `mcp__savvy-progress__progress`:编排者上报计划、阶段、已验收任务;
  - `mcp__savvy-progress__step`:worker 上报自己的步骤(`done` / `total` / `note`)。

花费是按 token 数和内置价格表(`hooks/register.tsx` 的 `PRICES`)的粗估,不是账单。

## omd-lite runs(本 fork)

savvy-progress 本来只看得到 Claude Code 自己的子 agent。本 fork 还跟踪 omd-lite 在 Claude Code 之外启动的执行器(`mcode`、`claude -p`、`pi`),**只看本会话启动的 run**:omd-lite 把 `claude_session`(取自 `CLAUDE_CODE_SESSION_ID`)和 `driver_pid` 写进 `<runs>/<label>/meta.json`,`bin/omd-scan.mjs <session-id>` 只读这些(纯读;有 run 在跑时每 2 秒,否则每 10 秒,以及提到 `omd-lite` 的 Bash 调用之后立即扫一次)。

- **Band**(提示框下方):run、轮次 `n/max`、执行中或在跑闸、工具调用数、当前工具、token、耗时。最后一个 run 结束后保留十分钟;✕ 隐藏;`×N` 打开面板。
- **面板**:`omd-lite` 一节,每个 run 一行,带结果(`stuck-gate`、失败的闸、`interrupted`)。

没装 omd-lite 时这部分什么都不显示。

## 配置

- `language`:`auto`(默认)、`en`、`ru`、`zh`。`auto` 依次跟随 Claude Code 的 `language` 设置、系统 locale,最后回落英文。在 `/config` 设置,或手动加载时写进 `~/.claude/settings.json`:

  ```json
  { "pluginConfigs": { "savvy-progress": { "options": { "language": "zh" } } } }
  ```

- 环境变量 `OMD_LITE_RUNS_DIR`:omd-lite runs 目录,默认 `$HOME/.omd-lite/runs`。

## 测试

`claude plugin test .`(band 和面板)与 `node --test bin/omd-scan.spec.mjs`(扫描器)。

## 安装

```
/plugin marketplace add AbyssCN/claude-lead-harness
/plugin install savvy-progress@claude-lead-harness
```
