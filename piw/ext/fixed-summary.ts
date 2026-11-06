/**
 * fixed-summary —— 定长压缩摘要(只在 piw --compaction-ext 点名的 run 里加载)。
 *
 * pi 默认的压缩摘要是叠加式的:每次把上一份摘要和新消息一起重写,压缩次数越多摘要越长,
 * 顶到 0.8 × reserveTokens 后压缩连续失败、上下文涨满 → length(otherapp
 * docs/investigations/2026-10-25-pi-length-truncation.md)。这里在 session_before_compact 返回
 * 分节固定的摘要:前四节零 LLM、各有上限,只有进度一节过模型且被截断,摘要总长与压缩次数无关。
 * 每节截掉多少写进 details.truncated。契约:otherapp docs/plan/2026-10-25-fixed-summary-compaction-sdd.md。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CAPS = { task: 1500, paths: 80, pathChars: 3000, gate: 3000, progress: 6000 };
const GATE_PREFIX = "闸未通过(第";

type Cut = { count: number; dropped: number };
type Section = "task" | "modified" | "read" | "gate" | "progress";
export type SummaryInput = { task: string; read: string[]; modified: string[]; gateText: string | null; narrative: string | null };

function head(text: string, cap: number): [string, Cut] {
  return text.length > cap ? [text.slice(0, cap), { count: 1, dropped: text.length - cap }] : [text, { count: 0, dropped: 0 }];
}

function tail(text: string, cap: number): [string, Cut] {
  return text.length > cap ? [text.slice(-cap), { count: 1, dropped: text.length - cap }] : [text, { count: 0, dropped: 0 }];
}

function pathList(paths: string[]): [string, Cut] {
  const kept: string[] = [];
  let chars = 0;
  for (const p of paths) {
    if (kept.length >= CAPS.paths || chars + p.length + 1 > CAPS.pathChars) break;
    kept.push(p);
    chars += p.length + 1;
  }
  const dropped = paths.length - kept.length;
  if (!kept.length && !dropped) return ["(none)", { count: 0, dropped: 0 }];
  return [[...kept, ...(dropped ? [`… +${dropped}`] : [])].join("\n"), { count: dropped ? 1 : 0, dropped }];
}

export function buildSummary(input: SummaryInput): { summary: string; narrative: string; truncated: Record<Section, Cut> } {
  const [task, cTask] = head(input.task, CAPS.task);
  const [modified, cMod] = pathList(input.modified);
  const [read, cRead] = pathList(input.read);
  const [gate, cGate] = input.gateText ? tail(input.gateText, CAPS.gate) : ["no gate feedback yet", { count: 0, dropped: 0 }];
  const [narrative, cProg] = head(input.narrative ?? "narrative unavailable", CAPS.progress);
  const summary = [
    "## Task", task,
    "## Files modified", modified,
    "## Files read", read,
    "## Gate state", gate,
    "## Progress · Next · Open problems", narrative,
  ].join("\n");
  return { summary, narrative, truncated: { task: cTask, modified: cMod, read: cRead, gate: cGate, progress: cProg } };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
}

function userTexts(entries: any[]): string[] {
  return entries.filter((e) => e?.type === "message" && e.message?.role === "user").map((e) => textOf(e.message.content));
}

export function lastGateText(entries: any[]): string | null {
  return userTexts(entries).filter((t) => t.startsWith(GATE_PREFIX)).at(-1) ?? null;
}

function lastDetails(entries: any[]): { narrative?: string; read?: string[]; modified?: string[] } | null {
  return entries.filter((e) => e?.type === "compaction" && e.details).at(-1)?.details ?? null;
}

const uniq = (xs: string[]) => [...new Set(xs)];

const SYSTEM = [
  "You maintain the working-state section of a coding agent's memory after its context is compacted.",
  "Rewrite the state as it is NOW; do not append history or repeat earlier wording.",
  "Cover: what is done, what is in progress, the next concrete step, and open problems (failing checks, blockers, decisions taken).",
  "Do not list files read or modified and do not quote gate output; those are kept elsewhere.",
  `Plain markdown bullets, at most ${CAPS.progress} characters.`,
].join("\n");

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, signal } = event;
    const prev = lastDetails(branchEntries);
    const ops = preparation.fileOps;
    const read = uniq([...ops.read, ...(prev?.read ?? [])]);
    const modified = uniq([...ops.written, ...ops.edited, ...(prev?.modified ?? [])]);
    let narrative = prev?.narrative ?? null;
    let fallback = false;
    let usage;
    try {
      const { convertToLlm, serializeConversation } = await import("@earendil-works/pi-coding-agent");
      const conversation = serializeConversation(convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]));
      const level = pi.getThinkingLevel();
      const model = ctx.model!;
      const res = await ctx.modelRegistry.complete(model, {
        systemPrompt: SYSTEM,
        messages: [{ role: "user", content: [{ type: "text", text: `<previous-state>\n${narrative ?? "(none)"}\n</previous-state>\n\n<new-conversation>\n${conversation}\n</new-conversation>` }], timestamp: Date.now() }],
      }, {
        maxTokens: Math.floor(0.8 * preparation.settings.reserveTokens),
        ...(model.reasoning && level && level !== "off" ? { reasoning: level } : {}),
        signal,
      });
      const out = textOf(res.content).trim();
      usage = res.usage;
      if (res.stopReason === "length" || res.stopReason === "error" || res.stopReason === "aborted" || !out) fallback = true;
      else narrative = out;
    } catch {
      fallback = true;
    }
    const r = buildSummary({ task: userTexts(branchEntries)[0] ?? "", read, modified, gateText: lastGateText(branchEntries), narrative });
    return {
      compaction: {
        summary: r.summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        ...(usage ? { usage } : {}),
        details: { narrative: r.narrative, read, modified, truncated: r.truncated, fallback },
      },
    };
  });
}
