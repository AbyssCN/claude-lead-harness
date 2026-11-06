# claude-lead-harness

> Run a software team out of Claude Code: one lead session you talk to, ticket sessions it spawns in herdr, cheap executors in isolated worktrees, and deterministic gates that decide what counts as done. Extracted from the workflow behind a production SaaS built by one person.

一套可以直接拿去用的 agent 工作流:你只和一个总管会话说话,总管按单拉起主管会话,主管调度执行体,闸决定算不算完。它来自一个一个人开发的线上 SaaS,这里是去掉项目内容后的通用版。

```
你 → 总管(lead,常驻) → 主管(一单一个会话,在 herdr 里) → 执行体(子 agent · 便宜模型)
                                                                ↓
                                                     闸(tsc · 测试 · lint):只看退出码
```

## 十分钟上手

要 Claude Code · Node ≥ 22 · [herdr](https://herdr.dev) ≥ 0.9.5 · git · jq · ripgrep。执行体用 [pi](https://pi.dev)、`mcode` 或 `codex` 任一个。

```bash
git clone https://github.com/AbyssCN/claude-lead-harness ~/repos/claude-lead-harness
cd ~/repos/claude-lead-harness
scripts/install.sh                  # 查工具,链接 ticket · piw · skills · agents,不覆盖已有文件
scripts/init-repo.sh ~/repos/myapp  # 给项目加 CLAUDE.md · 闸模板 · 起片配置
```

在 Claude Code 里装 mod:

```
/plugin marketplace add AbyssCN/claude-lead-harness
/plugin install relay@claude-lead-harness
/plugin install delegate@claude-lead-harness
/plugin install agent-guard@claude-lead-harness
/reload-plugins
```

然后:

1. 在项目目录手动开一次 Claude Code,确认信任目录(不做这步,主管会话会停在确认框)。
1. 把 `scripts/dev/gate-slice.sh` 改成你项目真实的检查,确认它会红。
2. 把 [`examples/piw-config.json`](examples/piw-config.json) 拷到 `~/.config/piw/config.json`,填上执行模型。
3. 按 [`docs/herdr.md`](docs/herdr.md) 配 herdr,在 herdr pane 里开一个 Claude Code,这就是总管。
4. 对总管说目标。它用 `/goal` 写目标,用 `ticket open` 开单。

```bash
ticket open --repo myapp --tab 后端 --title "加登录限流" \
  --origin "登录接口要防爆破" --scope "只动 src/auth" --accept "npm test"
ticket board
```

## 文档

| 文档 | 内容 |
|---|---|
| [分层](docs/architecture.md) | 总管 · 主管 · 执行体,谁跟谁怎么说话,脏场景 |
| [工作流](docs/workflow.md) | 七段流程,每段标明本仓能不能直接用 |
| [软件工程纪律](docs/software-engineering.md) | 契约 · 实验 · 切片 · 闸 · 复核 · 权限 · 交接 |
| [活给谁做](docs/routing.md) | 模型路由 · 先算账 · 复核份数 |
| [herdr 配置](docs/herdr.md) | 配置 · 截图粘贴 · 约定 |
| [角色包](docs/role-packs.md) | agent 仓的设计:角色文件夹 · 收集箱 · 晋升检查 |
| [ROADMAP](ROADMAP.md) | 还没公开的部分 |

## 里面有什么

| 目录 | 是什么 |
|---|---|
| [`ticket`](ticket) | 开单、回报、看板,按单拉起主管会话 |
| [`piw`](piw) | 执行体驱动:建 worktree → 按任务书干活 → 跑闸 → 失败回灌,同一道闸连红 3 轮提前停 |
| [`skills`](skills) | `/grill` `/contract` `/verify` `/commit` `/retro` `/note` `/investigate` |
| [`agents`](agents) | `spec-reviewer`:只读对照任务书审 diff |
| [`herdr`](herdr) | herdr 配置 · tmux 片段 · 重启核对插件 |
| [`mods/relay`](mods/relay) | `/goal` 写目标,按 RELAY 行续跑到验收全过;到阈值自动交接、`/clear`、新会话接着做 |
| [`mods/delegate`](mods/delegate) | 起片前查任务书和改动范围,run 结束合成一条叫醒,合并后提示该跑的闸 |
| [`mods/agent-guard`](mods/agent-guard) | 写代码的子 agent 必须有独立干净的 worktree;可把重命令改写到远端 |
| [`mods/board`](mods/board) | `/board` 一屏看进度、待拍板和 roadmap,纯读文件 |
| [`mods/cue`](mods/cue) | 替你写好下一条 prompt 放进草稿,不替你发送 |
| [`mods/cache-clock`](mods/cache-clock) | 倒数到 prompt cache 变冷,冷发前报价 |
| [`mods/prompt-guard`](mods/prompt-guard) | prompt 里的密钥拦下去掉;重复发送的丢掉 |
| [`mods/copy-lint`](mods/copy-lint) | 对外文案查禁用词 |
| [`mods/savvy-progress`](mods/savvy-progress) | 进度条和子 agent 面板(fork 自 johnnyvizz/claude-kit,MIT) |
| [`scripts`](scripts) | 安装 · 项目初始化 · 起片 · `send-to-ticket` |
| [`examples`](examples) | CLAUDE.md · 任务书须知 · 闸模板 · 配置 · 角色包结构 |

几条原则:
- **不替人按发送键**:cue 只写草稿;relay 自动清空前留 30 秒，你发任何消息就取消。
- **能读文件就不调模型**:board、retro 都是纯文件读取。
- **状态放磁盘，不放对话**:GOAL.md、交接文件、run 的 `result.json` 都写入磁盘，对话随时可以清。
- **判据在模型之外**:执行手说"完成了"不算，闸过了才算。

## 开发

每个 mod:`claude plugin validate mods/<name>`、`claude plugin test mods/<name>`。类型检查用 plugin-authoring skill 带的 `claude-code.d.ts`(在 Claude Code 里加载 plugin-authoring skill 会给出路径)。

piw:`cd piw && node --test --test-skip-pattern='gc:按名字判活' 'test/**/*.test.mjs'`。ticket:`cd ticket && node --test 'test/*.test.mjs' 'bin/*.test.mjs'`。

`mods` `ticket` `piw` `skills` 由 `scripts/publish/sync.sh` 从私有仓生成,不要手改;改动发 issue 或 PR,维护者回推到源头。公开前闸:`scripts/publish/scrub-check.sh`。

## License

MIT,见 [LICENSE](LICENSE)。`mods/savvy-progress` 保留上游的 MIT LICENSE。
