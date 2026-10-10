# copy-lint

Lints public-facing copy after each Write/Edit against the repo's own rules and hints the model; never blocks the write.

`Write` / `Edit` 成功之后,如果目标文件算「对外文案」,就对写入的文本查:

- 禁用词 / 短语(字面词或正则),带原因;
- 标题(Markdown `#` 行,或 JSON 里 `title` / `heading` / `headline` / `h1` / `h2` 开头的键)以指定标点结尾。

命中时把提示作为 context 交给模型去改;**从不拦写入**。代码标识符里的命中由模型自行判断忽略。

## 配置

规则全部来自仓库里的 `.claude/copy-lint.json`。从被写文件所在目录往上找,遇到 `.git` 停(所以 git worktree 里也生效)。**没有配置文件、或 `include` 为空时,什么都不做。**

| 键 | 含义 |
| --- | --- |
| `include` | glob 列表,相对 `.claude/` 所在目录;命中的文件算对外文案。支持 `**`、`*`、`?`、`{a,b}` |
| `exclude` | 即使命中 `include` 也跳过的 glob(例如引用了禁用词的写作指南本身) |
| `banned` | 数组;元素是字符串(字面词),或 `{ "word": "...", "reason": "..." }`,或 `{ "pattern": "<正则>", "flags": "i", "reason": "..." }` |
| `headingNoTrailing` | 标题不得以这些字符结尾,如 `"。."`;空串或省略则不查 |
| `guide` | 可选,提示里让模型对照的写作指南路径 |

示例见 [`example.copy-lint.json`](./example.copy-lint.json),复制到你的仓库 `.claude/copy-lint.json` 再改。

## 测试

`claude plugin test .`

## 安装

```
/plugin marketplace add AbyssCN/claude-lead-harness
/plugin install copy-lint@claude-lead-harness
```
