# agent-guard

Guards subagent dispatch so each code-writing subagent works in its own clean git worktree.

拦在 `Agent` 工具调用前:

- 拒绝 `isolation: "worktree"`(多个 agent 会共用同一个目录)。
- prompt 里单独一行 `WORKTREE: <绝对路径>` 时,检查它是绝对路径、存在、是 git worktree(不是主仓库)、没有未提交改动、之前没派给过别的 agent(一个目录只派一次,记录在插件 store 里,最多 2000 条)。
- `WORKTREE: none`:声明纯调研、不写代码,直接放行。
- 只读类型(`Explore`、`Plan`、`claude-code-guide`、`statusline-setup`)不检查。
- 在**已开启**的仓库里,非只读子 agent 没写 `WORKTREE:` 行就拒绝。默认没有仓库开启,所以开箱只做前三条。
- 守卫自身出错时放行,不会卡住派发。

## 配置

两种方式开启「必须带 WORKTREE 行」,任一满足即生效:

1. 插件设置 `requireWorktreeRepos`:仓库目录名(主 checkout 的目录名),逗号分隔,默认空。

   ```json
   { "pluginConfigs": { "agent-guard": { "options": { "requireWorktreeRepos": "my-app,my-api" } } } }
   ```

2. 在仓库里放 `.claude/agent-guard.json`(从主 checkout 读):

   ```json
   {
     "requireWorktree": true,
     "worktreeCommand": "scripts/dev/agent-wt.sh <name>"
   }
   ```

   `worktreeCommand` 可选,是拒绝提示里教模型建 worktree 的命令;默认 `git worktree add ../<repo>-<name> -b agent/<name>`。

## 测试

`claude plugin test .`

## 安装

```
/plugin marketplace add AbyssCN/claude-lead-harness
/plugin install agent-guard@claude-lead-harness
```
