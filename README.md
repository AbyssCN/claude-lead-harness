# claude-lead-harness

> A set of Claude Code mods, plus a small driver for cheap executor models, that turns one Claude session into a lead: it plans, delegates coding slices to MiniMax Code, lets deterministic gates judge the result, and keeps going across context clears.

一套 Claude Code mod + 执行手驱动:让一个 Claude 会话当 lead,负责拆任务、写任务书、看 diff、验收;写代码交给便宜的执行手(MiniMax Code `mcode` 或 pi);可靠性交给模型之外的确定性闸(tsc / 测试 / lint / 性能预算)。

## 里面有什么

| 目录 | 是什么 |
|---|---|
| [`mods/relay`](mods/relay) | `/goal 一句话` 写成 GOAL.md,按 RELAY 行自动续跑到验收命令全过或碰到要你拍板的事;上下文到阈值自动写交接、`/clear`、新会话接着做 |
| [`mods/cue`](mods/cue) | 每次回答后替你写好下一条 prompt,空输入框按 1 写进草稿，从不替你发送;`/enhance` 改写粗稿 |
| [`mods/delegate`](mods/delegate) | 外部 omd-lite run 的驾驶舱：派活前检查任务书、改动范围、磁盘;run 结束合成一条叫醒;合并后提示该跑的闸 |
| [`mods/board`](mods/board) | 进度板:`/board` 一屏看 GOAL 完成 / 进行中 / 规划中、待拍板、TODO、roadmap;`/board open` 常驻侧栏，彩色分段进度条，清空后自动重开。纯读文件，不调模型 |
| [`mods/agent-guard`](mods/agent-guard) | 写代码的子 agent 必须有独立、干净的 worktree |
| [`mods/prompt-guard`](mods/prompt-guard) | prompt 里的密钥 / 密码拦下并去掉;几分钟内重复发送的同一条丢掉 |
| [`mods/copy-lint`](mods/copy-lint) | 对外文案写入后按 `.claude/copy-lint.json` 查禁用词和格式，只提示不拦 |
| [`mods/savvy-progress`](mods/savvy-progress) | fork 自 johnnyvizz/claude-kit(MIT):进度条和子 agent 面板，加上 omd-lite run 跟踪 |
| [`omd-lite`](omd-lite) | 执行手驱动：建独立 worktree → 执行手按任务书干活 → 按序跑闸 → 失败输出回灌，最多 N 轮;同一道闸连红 3 轮提前停 |
| [`scripts`](scripts) | 在 VibeTunnel(`vt`)里起 mcode,手机上能看能插话;`mgo` 睡前用 goal 文件起无人值守会话;`omdl-launch.sh` 起 omd-lite run |
| [`examples`](examples) | 一个真实项目 CLAUDE.md 和执行手 brief 的脱敏版 |

## 安装 mod

```
/plugin marketplace add AbyssCN/claude-lead-harness
/plugin install relay@claude-lead-harness
/plugin install board@claude-lead-harness
...
```

装完 `/reload-plugins`。各 mod 的命令和配置项见各自 README;路径类配置都有 `$HOME` 相对的默认值。

## 分工

```
lead(Claude Opus)   想、拆、写任务书、看 diff、验收
   │ delegate / omd-lite
   ▼
执行手(MiniMax Code)  按任务书写一片代码，在独立 worktree 里
   │
   ▼
闸(tsc · 测试 · lint · 性能预算)  只看退出码;失败输出回灌给执行手再跑
```

几条原则:
- **不替人按发送键**:cue 只写草稿;relay 自动清空前留 30 秒，你发任何消息就取消。
- **能读文件就不调模型**:board、retro 都是纯文件读取。
- **状态放磁盘，不放对话**:GOAL.md、交接文件、run 的 `result.json` 都落盘，对话随时可以清。
- **判据在模型之外**:执行手说"完成了"不算，闸过了才算。

## 开发

每个 mod:`claude plugin validate mods/<name>`、`claude plugin test mods/<name>`。类型检查用 plugin-authoring skill 带的 `claude-code.d.ts`(在 Claude Code 里加载 plugin-authoring skill 会给出路径)。

omd-lite:`node --test ext/outside.test.ts test/retro-gc.test.mjs`。

## License

MIT,见 [LICENSE](LICENSE)。`mods/savvy-progress` 保留上游的 MIT LICENSE。
