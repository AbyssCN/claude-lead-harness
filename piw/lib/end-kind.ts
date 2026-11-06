// agent_end 时执行体是不是自己停的。stopReason=length:输出撞了 token 上限，常跟在压缩失败之后(24.10 st-e/i/m-r3 三片),
// 活没做完、收尾报告没写，这时跑闸判的是半成品。
export const MAX_TRUNCATIONS = 2;

/** 'retry' = 供应商报错 / 中断，pi 自己会重试 · 'truncated' = 撞输出上限 · 'done' = 执行体自己停。 */
export function endKind(last: { role?: string; stopReason?: string } | undefined): 'retry' | 'truncated' | 'done' {
  if (last?.role !== 'assistant') return 'done';
  if (last.stopReason === 'error' || last.stopReason === 'aborted') return 'retry';
  if (last.stopReason === 'length') return 'truncated';
  return 'done';
}

/** 第几次截断之后怎么办:还有次数就叫它接着做，用完就不跑闸、记 not-run 收尾(collect 判环境红，交重跑)。 */
export function onTruncated(count: number, max = MAX_TRUNCATIONS): 'continue' | 'give-up' {
  return count <= max ? 'continue' : 'give-up';
}
