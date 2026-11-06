// 「停在问 owner 上」的判词:relay 的空等兜底与 bin/stall-scan.mjs 判官共用这一份,判官点名的就是兜底接住的。

// 强信号:在交代「卡在你身上」,查最后 1200 字。「等你拍板的:无」「等你拍板的事不是队列行」这类陈述不算。
const STRONG = /你定了?(以后|之后)|还在等你(来)?(定|拍板|决定)|等你拍板的[^:：无\n]{0,6}(卡|项|件|事)(?![^\n]{0,3}不是)|要你(拍|定)的(还是|有)/
// 弱信号:只在最后 3 行里才算(正文里「只有……才请你拍板」是在讲规则,不是在问)。
const WEAK = /(?<!不|需|无需|不用|不必|没有|无须|别)(等|要|需要|请)你(来)?(拍板|定夺|决定|确认|选)(?!的?[:：]?\s*无)|(?<!不用|不必|无需|不需要|别)你来定|你选哪|要不要(?![^\n]{0,10}[:：])|是否继续|want me to|should i/i
export const lines = (t: string): string[] => t.split('\n').map((l) => l.trim()).filter(Boolean)

/** relay 认可的停法:回答末行是 RELAY: owner / done(relay 会挂单续跑或亲自验收)。 */
export function sanctioned(answer: string): boolean {
  const last = lines(answer).pop() ?? ''
  return /^[>*_`\s]*RELAY\s*[:：]\s*(owner|done)\b/i.test(last)
}

/** 回答停在问 owner 上:末行是问句,或最后 1200 字里有「你定了以后 / 等你拍板」这类话。 */
export function asksNick(answer: string): boolean {
  const ls = lines(answer).filter((l) => !/^HANDOFF-READY$/.test(l) && !/^[>*_`\s]*RELAY\s*[:：]/i.test(l))
  const last = ls[ls.length - 1] ?? ''
  if (/[?？]\s*\**$/.test(last)) return true
  return STRONG.test(ls.join('\n').slice(-1200)) || ls.slice(-3).some((l) => WEAK.test(l) && !/只有|才会|会停下来|不是/.test(l))
}

/** 单会话(环境有 TICKET_ID)停在问人上时的提醒:回报只走 `ticket report`,不写待 owner 文件(契约 D-14)。 */
export const ticketNudgePrompt = (id: string): string =>
  `[relay] 你在单 ${id} 的会话里,上一轮停在了问人上,没人盯这个 pane。技术岔口按你的推荐直接定,接着做。要 lead 定的用 \`ticket report ${id} --status needs-lead --summary <一句> --question <问题> --recommend <推荐>\`,要 owner 定的用 \`ticket report ${id} --status needs-owner …\`(由 lead 转问);不要写 RELAY: owner,不要写待 owner 文件,不要用 AskUserQuestion。报完去做不依赖它的活。`
