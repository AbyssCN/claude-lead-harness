export type Clock = {
  /** 主会话上次回复结束的时刻(ms);首次回复前为 0。 */
  lastEnd: number
  /** 回复后缓存保持热的时长(ms)。 */
  ttlMs: number
  /** detected:从会话日志读出;default:首次回复前按 5 分钟猜;demo:60 秒演示。 */
  ttlSource: 'detected' | 'default' | 'demo'
  /** 下一条消息要重发的上下文 tokens。 */
  tokens: number
  /** 主会话上次请求的模型,用来报价;读不到为 ''。 */
  model: string
  /** 时钟最后一跳(ms),让横条每秒重画。 */
  now: number
  /** 按钮按下后横条下的一行说明。 */
  note: string
}

export type Warm = {
  /** 开始保温的时刻(ms)。 */
  startedAt: number
  /** 保温窗口长度(ms),到点自停。 */
  windowMs: number
  /** 已发 ping 数,30 次自停。 */
  pings: number
  /** 上次 ping 的缓存读 tokens。 */
  read: number
  /** 上次 ping 的缓存写 tokens。 */
  write: number
  /** 上次 ping 写回了整段缓存:它已经冷过。 */
  cold: boolean
  /** 上次 ping 失败原因,或 ''。 */
  error: string
  /** 有 ping 在途。 */
  sending: boolean
  /** 连续失败次数,3 次自停。 */
  failures: number
  /** 失败后这个时刻前不再 ping(ms)。 */
  retryAt: number
  /** 本次保温已花的估算美元;报不出价为 null。 */
  usd: number | null
}

/** 本会话真付过的冷写。 */
export type Miss = { at: number; tokens: number; usd: number | null }

/** `$.cacheClock.state()` 的回值(D-14,冻结接口);首次回复前 lastEnd 为 0。 */
export type CacheClockState = {
  lastEnd: number
  ttlMs: number
  warm: { startedAt: number; windowMs: number; pings: number; /** 本次保温已花的估算美元(选读)。 */ usd?: number | null } | null
  /** 三者(一轮在跑 / 子 agent / delegate running)最后一次全部变空的时刻;正在干活 = null(缓存 v2 冻结接口)。 */
  idleSince: number | null
  /** ◷ 段该画哪一态(G 稿第 3、5、6 行):warm 停手满 5 分钟的提醒,stopped 保温自己停了,cold 缓存已冷。 */
  nudge: 'none' | 'warm' | 'stopped' | 'cold'
  /** 以下为缓存 v2 切片 4 加的选读字段(board 画 ◷ 段的文字和按钮用);旧读者不看也不受影响。 */
  /** 下一条消息要重发的上下文 tokens。 */
  tokens?: number
  /** 冷了重写的估算美元;报不出价为 null。 */
  coldUsd?: number | null
  /** 保温 ping 上限。 */
  maxPings?: number
  /** nudge='stopped' 时保温为什么停了的短句(如「窗口到了」);否则 ''。 */
  stopped?: string
  /** 一键交接(/relay coldhandoff)起跑的时刻,checkpoint 写出来或过了 10 分钟变回 null(契约 D-5)。 */
  handoffSince?: number | null
  /** 主对话这一轮在跑(0.4 起);false = 一轮已结束，只剩子 agent / delegate 在跑(board 据此画 ◷ 分钟而不是绿点)。 */
  turn?: boolean
}

declare module 'claude-code' {
  interface EngineInterface {
    cacheClock?: { state: () => Promise<CacheClockState> }
    /** delegate 的 noun(只读 runs,和 relay/types/delegate-ref.d.ts 同形);没装时为 undefined。 */
    delegate?: { runs: () => Promise<Array<{ label: string; state: string }>> }
  }
  interface PluginState {
    'cache-clock': { clock: Clock | null; warm: Warm | null; misses: Miss[] }
  }
}
