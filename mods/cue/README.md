# cue(提词)

> After each answer, drafts the next full prompt from your seat into the input box (never sends it); /enhance rewrites your rough draft into a complete prompt.

主 session 每回答完一条(≥ 80 字),cue 让同一个模型 fork 一次,站在你的位置写好**下一条完整 prompt**:要什么 · 关键事实 · 边界 · 判据 · 停在哪回什么。默认只给一条;回答停在真岔口时才多给一条「方向 B」。cue 只往输入框写草稿,**从不替你发送**。

## 按键

- 输入框为空时按 `1`,或点 **Enhance · 标题**:把整条 prompt 写进输入框(覆盖),改完自己回车。
- `2`:方向 B(只在真岔口出现)。
- 按数字只在输入框为空时生效;输入框里有字时,数字会被当成普通输入。
- `/enhance`:把输入框里的粗稿改写成完整结构,写回输入框;输入框为空时等于按 `1`。
- `/cue stats`:累计生成次数、各类 token 合计与平均、按 1/2/enhance 的次数、发出时原样/改写/弃用的比例。

relay 自动续跑(`relay.mode === 'running'`)期间不生成、不出按钮;没装 relay 时当作空闲。

## 配置(plugin userConfig)

- `engine`:`fork`(默认,主模型带完整上下文,上下文走主线缓存)· `haiku`(只看最后一条回答,便宜但浅)· `off`(回答后不自动生成,`/enhance` 仍可用)。
- `minChars`:回答短于此字符数不生成,默认 80。

## 成本

fork 每次都会重发主线最近一次请求的全部上下文,这部分走缓存读,另外加上 cue 自己那段提示和输出(不走缓存)。每次的 usage 都记在 `$.store`,用 `/cue stats` 查看。如果太贵,把 `engine` 设为 `off`,只在需要时用 `/enhance`。

## 安装

```
/plugin marketplace add AbyssCN/claude-lead-harness
/plugin install cue@claude-lead-harness
```
