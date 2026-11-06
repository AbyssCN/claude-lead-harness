# 交接:relay 对照 benai handoff(22.10)

benai 源:`benai-mods/plugins/handoff`(0.1.0)。relay 当时 0.4.0。

| 项 | benai | relay 0.4.0 | 取舍 |
|---|---|---|---|
| 谁写交接 | `$.model.fork` 在旁边写,不占一轮 | 主线自己写一轮(带全部上下文,写进文件) | 交接并清空仍走主线一轮:它要接锚点、子 agent 结果、RELAY 状态,fork 拿不到这些副作用。**可分享的交接**改用 fork(新增 `/handoff`),不打扰会话 |
| 触发 | 250k 提议 · /handoff · /refresh · 模型调 refresh 工具 · Cache Clock 留请求文件 | 阈值(默认 500k):GOAL/定时期间自动,平时提醒 /relay go | 阈值不动(relay 配置为准)。cache 变冷的提议由 cache-clock 提示 /relay go,relay 不读请求文件。不加 refresh 工具:清不清由 owner 或 GOAL 规则定,不交给模型 |
| 进度 UI | 输入框上方 5 步进度条(spinner + 条 + 用时) | 只有 toast | **拿**:`/handoff` 5 步;`/relay go` 与自动交接也在输入框上方画 5 步(写交接 → 等子 agent → 补存 checkpoint → 写旁车 → /clear 续接) |
| 先存草稿 | 先从会话记录机械抽一份草稿,模型失败也有东西 | 无(主线一轮写不出来就没有) | **拿**到 `/handoff`:fork 失败留草稿 + 重试。/relay go 有原文旁车和 continuity checkpoint 兜底,不加 |
| 日志 | `~/.claude/handoffs/handoff.log` 每次一行 | 无,只 toast | **拿**:同一个文件,记 armed / ready / cleared / cancelled / gave up / share ok / share failed |
| 抽事实 | 文件(按读写加权)· 技能 · MCP · 链接,喂给模型 | 交接 note 列子 agent、后台任务、MiniMax run | **拿**到 `/handoff` 的 prompt;路径正则改成 /home、/mnt(benai 是 /Users) |
| 去密钥 | 存盘与复制前删 sk-/ghp_/Bearer 等 | 无 | **拿**到 `/handoff`(要发给别人);旁车是 owner 原话原文,不改 |
| 复制 / 开新会话 | pbcopy;`claude://` 链接或 Claude Pet 开新聊天(macOS) | 无;/clear 后自动发续接 prompt | 复制改 WSL `clip.exe`(UTF-16LE,无 BOM),退 wl-copy / xclip。不做开新聊天:终端里 /relay go 已在同一窗口清空续接,按钮直接接 /relay go |
| 锚点 · 子 agent 挡 clear · 原文旁车 · continuity 补存 · GOAL 续接 | 无 | 有 | relay 更好,不动 |
| switches.json 开关 | 有 | 无 | 不拿:开关走 settings.json enabledPlugins |
