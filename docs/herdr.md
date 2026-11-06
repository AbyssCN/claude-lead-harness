# herdr 配置

[herdr](https://herdr.dev) 是跑 agent 的终端工作区(Apache-2.0)。这里用它做三件事:给每个会话一个稳定的名字 · 跨会话投提示 · 重启后续回会话。`ticket` 依赖它,总管必须在 herdr pane 里运行(开单时取 `$HERDR_PANE_ID` 作叫醒地址)。

要求 herdr ≥ 0.9.5。

## 步骤

1. 安装 herdr,然后接上 Claude Code 的状态上报:`herdr integration install claude`。
2. 把 [`herdr/config.toml`](../herdr/config.toml) 合并进 `~/.config/herdr/config.toml`,在 herdr 里按 `prefix+shift+r` 重载。`herdr server reload-config` 不重载客户端配置。
3. 如果 herdr 跑在 tmux 里,加上 [`herdr/tmux.conf.snippet`](../herdr/tmux.conf.snippet)。
4. 可选:装重启核对插件。把 `herdr/plugins/resume-check` 拷到 `~/.local/share/herdr-resume-check`,运行 `herdr plugin link ~/.local/share/herdr-resume-check`。设了 `RESUME_CHECK_NOTIFY=<命令>` 时,对不上的结果会推给那条命令。

5. **每个新项目先手动用 Claude Code 打开一次,确认信任这个目录。** 否则 `ticket open` 起的会话停在信任确认框,报 `agent_not_ready`,单留在 `queued`。

## 截图贴不进 Claude Code

这个问题有四层,修一层不够:

| 层 | 问题 | 修法 |
|---|---|---|
| Windows Terminal | `ctrl+v` 绑给了粘贴,键码不下传 | keybinding 改成 `{"id": null, "keys": "ctrl+v"}` |
| tmux | `extended-keys on` 把 Ctrl+V 编码成 CSI u,herdr 丢弃 | `extended-keys off` |
| herdr | `copy_on_select` 默认开,鼠标一划就把剪贴板里的图顶掉 | 设为 `false` |
| 操作 | 截图后又复制了文本 | 截完立刻贴 |

## 约定

- 总管一个 tab。主管按组分 tab:`ticket open --tab 前端`,同组在同一 tab 分 pane。
- herdr agent 名只许 `[a-z][a-z0-9_-]{0,31}`,所以单号是小写。
- 并发上限默认 6(`TICKET_MAX`)。每个交互会话常驻几百 MB。
- 主管不用会弹确认框的工具,权限模式要提前配好,否则新会话会停在确认框。
