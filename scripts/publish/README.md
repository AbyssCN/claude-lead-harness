# publish

维护者用。`mods` `ticket` `piw` `skills` 由 `sync.sh` 从私有源生成,不要手改。

- `manifest.txt`:拷什么、排除什么。
- `overlay/`:生成后覆盖上去的公开版文件(合成夹具等)。
- 替换规则与禁用词表在仓外:`~/.config/claude-lead-harness/{rewrite.sed,scrub-terms.txt}`。它们本身含私有词,不进任何仓,要单独备份。
- 发布前:`sync.sh` → `scrub-check.sh` → 测试。
