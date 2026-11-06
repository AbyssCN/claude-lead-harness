# 分层:总管 · 主管 · 执行体

人只对一到四个常驻会话说话。其余都是这些会话拉起来的。

```
owner
  │  只和总管说话
总管(lead)         常驻,每个领域或仓一个,总数 ≤ 4        不写代码,只调度
  │  ticket open
主管(单会话)       一件事一个 Claude Code 会话,在 herdr pane 里   自己调度下一层,做完就关
  │  子 agent / piw run
执行体              Claude 子 agent · 便宜模型的 piw run            只做一片,闸决定算不算完
  │
闸(模型之外)      tsc · 测试 · lint · 泄漏扫描                   只看退出码
```

## 为什么是这三层

- **总管不干活。** 真实项目一天 8 个长会话发给 lead 193 条自由文本,将近一半是进度。总管一旦自己写代码,所有人都在等它。
- **主管用会话,不用子 agent。** Claude Code 的子 agent 不能再派子 agent,会话可以。总管 `/clear` 时,会话不受影响。分层要靠架构定:只靠提示词劝,模型不会主动委派。
- **执行体在隔离环境里。** 每片独占一个 worktree,一片一份任务书,做完由闸判定,不由模型自己说。
- **卡死看护是程序,不是一层会话。** 多加一层模型只会多一个会卡死的东西。

## 通信规则

| 方向 | 走什么 | 说明 |
|---|---|---|
| owner → 总管 | 直接对话 | 一个入口,不被多个会话各自打断 |
| 总管 → 主管 | `ticket open` · `send-to-ticket` · `ticket answer` | `send-to-ticket` 发完确认输入框已提交,3 次仍卡住就报回总管 |
| 主管 → 总管 | 只有 `ticket report` | `ready` · `needs-lead` · `needs-owner` · `blocked` · `failed` 五种才叫醒总管 |
| 主管进度 | `ticket note` | 只写事件流,不叫醒任何人 |
| 主管 → 主管 | 直接发给对方,同时 `ticket note` | 交接产物不绕总管,否则总管又成了传话枢纽 |
| 主管 → owner | 不允许 | 要 owner 定的由总管问,答复用 `ticket answer` 写回单里 |

主管不用 AskUserQuestion:6 个 pane 没人盯,弹一个框就停一张单。

## 单(ticket)

单号就是 herdr agent 名(`t1106-07`),别的地址都现查,不存副本。记录是一个 JSON 快照加一条只追加的事件流,放在 `~/.local/share` 下,不放 `/tmp`,不进 git。总管只看 `ticket board`,要细节就读单里登记的产物,不读对话记录。

- 只有总管能开单。主管觉得活太大,报 `needs-lead` 附拆分建议。
- 长期职责(比如发版负责人)也是一张长单,不设特殊类型。
- 收单时会话先写 15 行以内的收尾再关。worktree、分支、记录都留下。
- `ticket open` 会立刻起一个干活的会话,它不是登记。已经有人在做的事不要再开单,一件事两个执行者是发版事故的来源。
- 按组分 tab:`ticket open --tab 前端`。一单一 tab 时 tab 栏几十个,找不到人。

状态机、退出码和所有参数见 [`ticket/README.md`](../ticket/README.md)。

## 脏场景

| 场景 | 怎么扛 |
|---|---|
| 会话崩溃、整机死机 | 记录在 `~/.local/share`,不丢;board 现查 herdr,找不到 agent 就标 `lost`,总管新开会话续上 |
| 总管 `/clear` 或重启 | 叫醒投给 pane 不投给 sessionId;pane 没了就进 outbox,下次跑 `ticket` 补发 |
| 单不回报,自顾自干 | `working` 超过 90 分钟没新事件,board 标 `stale` |
| 额度用完 | 主管报 `blocked`,原因写 `quota:<家族>`;Claude 自己没额度时全体失声,board 表头提示 |
| 提示没提交进输入框 | `send-to-ticket` 重试回车,3 次仍卡住报总管(真实事故:一单卡了 35 分钟) |
