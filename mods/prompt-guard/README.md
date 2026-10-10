# prompt-guard

Stops prompts carrying secrets and drops accidental duplicate sends.

只看人输入的 prompt(终端 `composer` 和远程 `bridge`),其它来源原样放行。

- **密钥 / 密码**:命中 Stripe、MiniMax、Anthropic、通用 `sk-` API key、GitHub token、AWS key、Slack token、JWT / Supabase key、私钥块,以及「密码是 X」「password: X」(值为 6 位以上非中文字符,所以「密码是什么」「密码是否正确」不算)时,不发出;把去掉密钥的版本放回输入框,提示改用环境变量或 secret store。
- **确实要发**:在开头加 `#allow-secret `,标记会先去掉再发出。
- **重复发送**:同一条消息(空白折叠后相同)5 分钟内再发,丢弃并提示;改一个字即可再发。
- 守卫自身出错时放行,不会吞掉 prompt。

## 配置

无。规则在 `hooks/scan.ts` 的 `PATTERNS` / `PASSWORD`,要加新密钥格式改那里。

## 测试

`claude plugin test .`

## 安装

```
/plugin marketplace add AbyssCN/claude-lead-harness
/plugin install prompt-guard@claude-lead-harness
```
