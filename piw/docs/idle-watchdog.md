# 执行体空闲看门狗(18.10)

pi 臂:执行体的 stdout / stderr 连续 `--idle` 秒(默认 1800,`PIW_IDLE` 可改)没有一个字节 → 整个进程组 SIGKILL,
run 目录写 `hang.json`(`idle_s` · `command` = 杀时还没返回的最后一条工具调用),`result.json` 带 `failureClass: "hang"` 与 `hang`。
墙钟 `--wall` 的行为不变。

## 阈值为什么是 1800 s

原始材料:myapp `~/.omd-lite/runs/*/pi.jsonl`,10.01–18.10。读数在 myapp `docs/plan/10.18/hang-replay.md`。
- 正常结束的工具调用 63,192 次:沉默最长 1310 s(一个轮询 vitest 的循环),p99.9 331 s,p99 117 s。
- 挂死的 run:从最后一次有动静到被墙钟杀,空了 2895–3572 s。
- 1800 s = 已知最长正常沉默 1310 s 再加约 37 % 余量;回放里 0 次误杀,挂死片每片省下 1100–1800 s。

## 不做的

- codex / agy / claude / mcode 臂还只有墙钟(它们的输出不是 pi 的 JSON 流),待补。
- 只给 bash 工具套 `timeout`:不够。执行体能自己改写或去掉,挂在 read / 别的工具上管不到,供应商流卡住也管不到;
  而且单条命令的上限要按同一份分布定(正常沉默最长 1310 s),省不下多少。
