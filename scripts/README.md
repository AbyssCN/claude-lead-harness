# scripts

`install.sh` 配本机,`init-repo.sh <仓>` 给项目加文件,`send-to-ticket` 是总管给单会话发提示的可靠入口,`publish/` 是维护者从私有源生成本仓的工具。下面讲执行会话的启动脚本。VibeTunnel 可选,没有 `vt` 时 `omdl-launch.sh` 直接运行。

Launchers that run cheap executor models (MiniMax Code `mcode`, or `piw` with pi) in isolated git worktrees inside VibeTunnel, so you can watch and steer them from your phone.

这里是 lead(Claude)把切好的片交给便宜执行模型的几支启动脚本。所有执行会话都跑在 VibeTunnel(`vt`)里,手机浏览器打开 VibeTunnel 网页就能实时看输出、插话、打断。

## 需要的工具

| 工具 | 用途 |
|---|---|
| `git` | worktree(一个执行者一个目录) |
| `tmux` | `mgo` 的无人值守会话(独立服务 `tmux -L mgo`) |
| `vt` / [VibeTunnel](https://github.com/amantus-ai/vibetunnel) | 把终端会话发布到网页;手机经 Tailscale / 局域网访问 |
| `mcode` | MiniMax Code CLI(交互会话 + `mcode exec`) |
| `pi` | piw 的默认执行器 |
| `node` ≥ 23 | 跑 `piw`(只依赖标准库) |
| `systemd --user` | `mgo` 把 tmux 放进独立 scope;`mgo after` 用 `systemd-run` 等待 |

## 文件

| 脚本 | 做什么 |
|---|---|
| `agent-wt.sh <name> [base]` | 给一个执行者建独占 worktree(分支 `agent/<name>`),软链 node_modules / `.venv*` 免安装,打印路径 |
| `mcode.sh <name> <任务书> [base]` | 建 worktree → 在里面 `vt mcode "<开工提示>"`,起一个可看可插话的交互执行会话 |
| `omdl-launch.sh <name> <base> <任务书> ["闸" ...]` | `vt piw run …`:非交互,跑完闸循环出结果 |
| `mgo <goal.md>` | 用一份 goal 文件起一个通宵无人值守的 mcode 会话 |

## 1. mcode 在 VibeTunnel 里起(`mcode.sh`)

```bash
scripts/mcode.sh fix-login docs/plan/fix-login.md main
```

1. `agent-wt.sh` 建 `<仓库>-agents/fix-login` worktree。
2. 环境里带 `UNTRUSTED_AGENT=1`(目标仓的 git hook 可据此拦删分支 / 动主干 / push);设了 `AGENT_GUARD_BIN` 就把它放到 PATH 最前,拦 `pkill` / `killall`。这些 hook 和闸目录属于目标仓自己,本仓不带。
3. `exec vt mcode "<提示>"`:提示里写 `WORKTREE: <路径>`,让它先读执行者须知(`EXECUTOR_BRIEF`,默认 `docs/process/executor-brief.md`,示例见 `../examples/executor-brief.md`),再读任务书,只做这一片,按格式交收尾报告。

`vt` 把这个终端发布成 VibeTunnel 会话:桌面上照常看,手机打开 VibeTunnel 网页能看到同一个会话、能打字插话。

环境变量:`AGENT_WT_REPO`(默认当前 git 仓)· `AGENT_WT_ROOT`(默认 `<仓库父目录>/<仓库名>-agents`)· `AGENT_WT_SCOPE`(monorepo 工作区包的 npm scope,如 `@myapp`,让工作区包指向 worktree 自己的源码)· `EXECUTOR_BRIEF` · `AGENT_GUARD_BIN`。

## 2. mgo 通宵流程

分工:白天 lead 把计划写成 goal 文件 → 睡前 `mgo` 起会话 → mcode 通宵跑 → 早上 lead 只读报告验收。

```bash
mgo goals/refactor-billing.md -d ~/repos/<your-app>    # 起会话并发 /goal
mgo ls                                                 # 列出会话与 goal 状态(Active / complete)
mgo after mg-refactor-billing goals/next.md -d …       # 前一个 goal 完成后自动起下一个
```

- **goal 文件**至少写清:规矩(绝对不做的事)· 要做什么 · 完成标准 · 报告写到哪(固定路径,早上只读这一个文件)。
- **tmux -L mgo + systemd scope**:用独立的 tmux 服务,并经 `systemd-run --user --scope` 起。默认 tmux 如果是从某个 systemd 服务(例如跑 Claude 的服务)里起的,会挂在那个服务的 cgroup 下,服务一重启 mcode 就跟着被杀。
- 会话里跑 `vt mcode`,等到 TUI 出现后用 `send-keys` 发 `/goal 先逐字读完 <goal 文件> 再动手…`,确认出现 `Goal · Active` 才算起好(长行输入后 Enter 可能被吞,会重按最多 3 次)。
- 会话名默认 `mg-<goal 文件名>`。桌面接入 `tmux -L mgo a -t <会话名>`;手机打开 `$MGO_VT_URL`。
- **`mgo after`**:在独立的 systemd 单元里每 2 分钟看一次前一个会话,出现 `Goal complete` 且没有 `piw run` 在跑时起下一个;最多等 12 小时。不占 Claude 额度,Claude 会话断了也照样等。
- **早上**:lead 读 goal 文件指定的报告,再读 diff、跑闸验收;不凭报告信。日志在 `$MGO_LOG`。

环境变量:`MGO_VT_URL`(默认 `http://localhost:4020`,通常换成你的 Tailscale / 局域网地址)· `MGO_VT_UNIT`(VibeTunnel 的 systemd --user 单元名,默认 `vibetunnel`;设为空不自动拉起)· `MGO_LOG`(默认 `~/.local/state/mgo.log`)。

## 3. piw 启动(`omdl-launch.sh`)

```bash
export OMD_LITE_REPO=~/repos/<your-app>
export OMD_LITE_SLICE_GATE=scripts/dev/gate-slice.sh      # 可选;会以 "<它> <base>" 跑
export OMD_LITE_ENV_FILE=~/.config/<your-app>/llm.env       # 可选;供应商密钥
nohup scripts/omdl-launch.sh s1 main docs/plan/s1.md "npm run lint" &
sleep 10
nohup scripts/omdl-launch.sh s2 main docs/plan/s2.md &
```

- **闸**:`OMD_LITE_SLICE_GATE`(如果设了)是第一道,命令行后面的每个参数各是一道;按序跑、首个失败即停,失败输出尾 80 行回灌给执行器,最多 `OMD_LITE_MAX_ROUNDS` 轮(默认 4)。任务书里写一行 `允许改动:` 还会判越界改动。细节见 `../piw/README.md`。
- **前台阻塞**到 run 结束 —— 从 agent / 脚本里一律后台起,之后轮询 `~/.piw/runs/<name>/meta.json`(`wall_seconds` 出现 = 结束),结果看 `result.json`。终端输出在 `$OMD_LITE_LOG_DIR/<name>.log`(默认 `/tmp/omdl-logs`)。
- **错开 ≥ 10 秒**:同一秒起的多个 `vt` 会撞 IPC socket(`Server.listen` 报错,run 目录都不建)。
- 任务书必须已提交进 `<base>`;失败用 `<name>-r2` 重来。
- 全量测试闸要经一个全机加锁的包装脚本(`flock`),否则并行一多负载爆掉、大批墙钟超时。

环境变量:`OMD_LITE_REPO` · `OMD_LITE_BIN`(默认 `../piw/bin/piw`)· `OMD_LITE_MODEL`(默认 `minimax-cp/MiniMax-M3.1-Flash-Preview`,provider 名要和你 `~/.pi/agent/models.json` 里的一致)· `OMD_LITE_PROMPT`(默认 `omd-leaf`)· `OMD_LITE_SLICE_GATE` · `OMD_LITE_MAX_ROUNDS` · `WALL`(秒,默认 3600)· `OMD_LITE_LOG_DIR`;piw 本身还读 `OMD_LITE_ENV_FILE` / `OMD_LITE_FALLBACK_MODEL` / `OMD_LITE_GUARD_BIN` / `OMD_LITE_BRIEF`。
