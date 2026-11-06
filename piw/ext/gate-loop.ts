/**
 * gate-loop —— 模型之外的确定性闸 + 回灌循环。
 *
 * 每次 agent_end:按序跑 OMD_LITE_GATES 里的命令(bash -lc,cwd = 会话 cwd,单条 15 分钟超时),
 * 判据只看退出码;完整输出写 $OMD_LITE_OUT/gate-round-<n>.log。
 *   全过            → result.json = {"gates":"pass","round":n},放行结束。
 *   有挂且还有轮数   → sendUserMessage(deliverAs:"followUp") 把失败回灌,pi 在退出前再跑一轮。
 *   轮数用完        → result.json = {"gates":"fail",...},结束。
 *
 * 实测(pi 0.84.1,-p / --mode json):agent_end 时会话仍算「处理中」,不带 deliverAs 会抛
 * "Agent is already processing";带 followUp 则 AgentSession._handlePostAgentRun 发现队列非空,
 * 在同一次 prompt() 里 continue,进程等它跑完才退出。
 * 命令闸全过后，若设了 OMD_LITE_ALLOWED(任务书「允许改动:」那一行，驱动解析好的 JSON 数组)与 OMD_LITE_BASE,
 * 再判一道「越界改动」:改动落在允许表之外 = 这一轮失败，把越界清单回灌。豁免见 outsideFiles()。
 * 未设 OMD_LITE_GATES 时本扩展什么都不做。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endKind, onTruncated } from "../lib/end-kind.ts";
import { runQueued, SLOT_BUSY, touchHeartbeat } from "../lib/slot-queue.mjs";
import { parseVerdict } from "../lib/round-classify.mjs";

const GATE_TIMEOUT_MS = 15 * 60 * 1000;
const TAIL_LINES = 80;
// 等闸槽:单次最多 SLOT_WAIT_S 秒(闸自己到点退 75),最多重排 SLOT_TRIES 次;等槽不吃 15 分钟闸超时
const SLOT_WAIT_S = process.env.GATE_SLOT_WAIT_MAX_S ?? "300";
const SLOT_TRIES = 12;
// 分类可能要在基线上重跑红了的测试文件(宿主守护进程,按基线 sha 缓存);超时就当判不了,照常回灌
const CLASSIFY_TIMEOUT_MS = 15 * 60 * 1000;

type GateRun = { cmd: string; code: number | null; timedOut: boolean; output: string; requeued?: number; stderr?: string };

// opts 只给白跑分类用:换环境、换超时、stdout 与 stderr 分开收(判词只认 stdout 最后一行)
function runGate(cmd: string, cwd: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; stdoutOnly?: boolean } = {}): Promise<GateRun> {
  return new Promise((resolve) => {
    // detached = 独立进程组,超时时整组杀掉(vitest/tsc 会起子进程)
    const child = spawn("bash", ["-lc", cmd], { cwd, env: opts.env ?? { ...process.env, PIW_GATE: "1", GATE_SLOT_WAIT_MAX_S: SLOT_WAIT_S }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [], errs: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.stderr.on("data", (b: Buffer) => (opts.stdoutOnly ? errs : chunks).push(b));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
    }, opts.timeoutMs ?? GATE_TIMEOUT_MS);
    const done = (code: number | null, extra = "") => {
      clearTimeout(timer);
      resolve({ cmd, code, timedOut, output: Buffer.concat(chunks).toString("utf8") + extra, ...(opts.stdoutOnly ? { stderr: Buffer.concat(errs).toString("utf8") } : {}) });
    };
    child.on("error", (e) => done(null, `\n[spawn error] ${e.message}`));
    child.on("close", (code) => done(code));
  });
}

const tail = (s: string, n: number) => s.split("\n").slice(-n).join("\n");

// 闸在跑的标记:驱动的墙钟见它就暂停计时(闸的时间不算执行体的,26.10 page-settings 收尾报告写完、闸跑到一半撞墙钟)
export const GATE_RUNNING = "gate-running";
// 预算到了以后还许几次工具调用(收尾报告要用);再调就终止
const BUDGET_GRACE = 5;

/** 这条 bash 命令是不是在执行片闸(读它、grep 它不算)。片闸只由启动器在交付后跑(executor-no-full-gate D-2)。 */
export function runsSliceGate(cmd: string): boolean {
  return /(^|[;&|(]\s*|\b(?:timeout\s+\S+|bash|sh|env(?:\s+\w+=\S*)*|\w+=\S*)\s+)(?:\.\/)?(?:\S*\/)?scripts\/dev\/gate-slice\.sh\b/.test(cmd);
}

/** assistant 一条消息的 token(全价口径,与 piw yield 同):输入 + 缓存读 + 缓存写 + 输出。 */
export function usageTokens(u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined): number {
  return u ? (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0) : 0;
}

export type Change = { status: string; path: string; diff?: string };

/**
 * 越界改动 = 不在允许表(精确路径，或目录前缀)里、也不在豁免里的改动。
 * 豁免(03.10 首批 104 slice 的越界全是这两类，验收判为正当):
 *   · 测试文件(*.test.* / *.spec.* / test_*.py)的新增与修改 —— 跟着行为变化改测试是常态;删除测试不豁免
 *   · index.ts/js 只新增 export 行(diff 里没有删除行，新增行都以 export 开头)
 */
export function outsideFiles(changes: Change[], allowed: string[]): string[] {
  const inAllowed = (f: string) => allowed.some((a) => f === a || f.startsWith(a.endsWith("/") ? a : a + "/"));
  const isTest = (f: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)test_[^/]*\.py$/.test(f);
  const exportOnly = (c: Change) =>
    /(^|\/)index\.[cm]?[jt]sx?$/.test(c.path) && c.status === "M" && c.diff !== undefined &&
    c.diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
      .every((l) => /^\+\s*export\b/.test(l) || /^\+\s*$/.test(l));
  return changes
    .filter((c) => !inAllowed(c.path))
    .filter((c) => !(c.status !== "D" && isTest(c.path)))
    .filter((c) => !exportOnly(c))
    .map((c) => (c.status === "D" ? `${c.path}(删除)` : c.path));
}

function gitOut(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}

function collectChanges(base: string, cwd: string): Change[] {
  const out: Change[] = [];
  for (const line of gitOut(["diff", "--name-status", "--no-renames", base], cwd).split("\n")) {
    const m = line.match(/^([A-Z])\t(.+)$/);
    if (!m) continue;
    const c: Change = { status: m[1], path: m[2] };
    if (c.status === "M" && /(^|\/)index\.[cm]?[jt]sx?$/.test(c.path)) c.diff = gitOut(["diff", "-U0", base, "--", c.path], cwd);
    out.push(c);
  }
  for (const f of gitOut(["ls-files", "--others", "--exclude-standard"], cwd).split("\n")) if (f) out.push({ status: "A", path: f });
  return out;
}

export default function (pi: ExtensionAPI) {
  // 双读:PIW_X ?? OMD_LITE_X(驱动两个名字都写;手动起 pi 时任一个都行)
  const envv = (n: string) => process.env[`PIW_${n}`] ?? process.env[`OMD_LITE_${n}`];
  const raw = envv("GATES");
  if (!raw) return;
  const gates: string[] = JSON.parse(raw);
  const maxRounds = Number(envv("MAX_ROUNDS") || 3);
  const out = envv("OUT") || process.cwd();
  const allowed: string[] | null = envv("ALLOWED") ? JSON.parse(envv("ALLOWED")!) : null;
  const base = envv("BASE");
  mkdirSync(out, { recursive: true });
  let round = 0;
  let finished = false;
  // 同一道闸连红 STUCK_ROUNDS 轮就提前停(与 bin/omd-lite 的 mcode 闸循环同判据)
  const STUCK_ROUNDS = 3;
  const failedHistory: string[] = [];
  let truncations = 0;
  // 预算闸(26.10):本片累计 token 到 PIW_TOKEN_BUDGET 就拦工具调用、叫它收尾;收尾后跑一次闸给结论,红了不回灌。0 / 不设 = 不限
  const budget = Number(envv("TOKEN_BUDGET") || 0);
  let spent = 0;
  let budgetHit = false;
  let afterBudget = 0;

  pi.on("tool_call", async (e) => {
    if (budgetHit) {
      afterBudget++;
      const reason = `本片的 token 预算 ${(budget / 1e6).toFixed(0)}M 已用完。不要再调工具,按任务书写收尾报告:做完了什么、没做完什么、卡在哪。启动器随后跑一次闸。`;
      return afterBudget > BUDGET_GRACE ? { block: true, reason, terminate: true } : { block: true, reason };
    }
    if (e.toolName === "bash" && runsSliceGate(String((e.input as { command?: string }).command ?? ""))) {
      return { block: true, reason: "片闸(scripts/dev/gate-slice.sh)由启动器在你交付后跑,你不跑,也不要设环境变量去绕。只跑你新写 / 改的测试文件,一条命令一个文件。" };
    }
  });

  pi.on("turn_end", async (e) => {
    spent += usageTokens((e.message as { usage?: Parameters<typeof usageTokens>[0] }).usage);
    if (budget > 0 && !budgetHit && spent >= budget) {
      budgetHit = true;
      try { writeFileSync(join(out, "budget.json"), JSON.stringify({ budget, spent, at: new Date().toISOString() }) + "\n"); } catch {}
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (finished) return;
    // 供应商报错 / 中断:pi 可能自行重试,此时不判闸(没判的轮不计数)
    const last = event.messages[event.messages.length - 1] as { role?: string; stopReason?: string } | undefined;
    const kind = budgetHit ? "done" : endKind(last);
    if (kind === "retry") return;
    if (kind === "truncated") {
      truncations++;
      if (onTruncated(truncations) === "continue") {
        pi.sendUserMessage("上一条输出撞了长度上限，被截断了。接着把活做完，最后照任务书写收尾报告。", { deliverAs: "followUp" });
        return;
      }
      finished = true;
      writeFileSync(join(out, "result.json"), JSON.stringify({ gates: "not-run", round, incomplete: "length", truncations }) + "\n");
      return;
    }

    round++;
    const started = new Date().toISOString();
    const runs: GateRun[] = [];
    writeFileSync(join(out, GATE_RUNNING), started + "\n");
    try {
      for (const g of gates) {
        const { r, tries } = await runQueued(() => runGate(g, ctx.cwd), SLOT_TRIES, () => touchHeartbeat(process.env.PIW_OUT ?? process.env.OMD_LITE_OUT));
        if (tries > 1) r.requeued = tries - 1;
        runs.push(r);
        if (r.code !== 0) break; // 首个失败即停,后面的闸在这一轮没有信息量
      }
    } finally {
      rmSync(join(out, GATE_RUNNING), { force: true });
    }
    if (runs.at(-1)?.code === SLOT_BUSY) {
      // 排满 SLOT_TRIES 次仍没拿到闸槽:闸没跑,不是闸红,不回灌执行体
      finished = true;
      writeFileSync(join(out, `gate-round-${round}.log`), runs.map((r) => `### $ ${r.cmd}\n### exit=${r.code}${r.requeued ? ` (闸槽重排 ${r.requeued} 次)` : ""}\n${r.output}\n`).join("\n"));
      writeFileSync(join(out, "result.json"), JSON.stringify({ gates: "not-run", round, error: "闸槽排队超时" }) + "\n");
      return;
    }
    let failed = runs.find((r) => r.code !== 0);
    let outside: string[] | undefined;
    if (!failed && allowed && base) {
      outside = outsideFiles(collectChanges(base, ctx.cwd), allowed);
      if (outside.length) {
        failed = {
          cmd: "越界改动检查(任务书「允许改动:」)", code: 1, timedOut: false,
          output: [
            "下列改动不在任务书「允许改动」里:",
            ...outside.map((f) => `  ${f}`),
            `还原它们(已跟踪的用 \`git checkout ${base.slice(0, 12)} -- <文件>\`,新建的删掉);如果确实非改不可，停下并说明理由。`,
          ].join("\n"),
        };
        runs.push(failed);
      }
    }
    writeFileSync(
      join(out, `gate-round-${round}.log`),
      runs.map((r) => `### $ ${r.cmd}\n### exit=${r.code}${r.timedOut ? " (timeout)" : ""}${r.requeued ? ` (闸槽重排 ${r.requeued} 次)` : ""}\n${r.output}\n`).join("\n"),
    );
    // 沙箱里写不进宿主事件流:记在 run 目录,驱动收尾时按这里的时刻转进去(lib/gate-events.mjs)。started = 这一轮执行体结束、闸开跑
    try {
      appendFileSync(join(out, "gate-events.jsonl"), JSON.stringify({ ts: new Date().toISOString(), phase: "gate", status: failed ? "fail" : "pass", round, started, evidence: join(out, `gate-round-${round}.log`), ...(failed ? { failed_gate: failed.cmd } : {}) }) + "\n");
    } catch { /* 记不下不影响闸 */ }
    const budgetNote = budgetHit ? { budget: { limit: budget, spent } } : {};
    if (!failed) {
      finished = true;
      writeFileSync(join(out, "result.json"), JSON.stringify({ gates: "pass", round, ...(outside ? { outside } : {}), ...budgetNote }) + "\n");
      return;
    }
    failedHistory.push(failed.cmd);
    const stuck = failedHistory.length >= STUCK_ROUNDS && failedHistory.slice(-STUCK_ROUNDS).every((c) => c === failed!.cmd);
    const classify = envv("ROUND_CLASSIFY");
    if (classify && !budgetHit) {
      // 分类期间照闸算:留 gate-running 标记(墙钟暂停)并按时 touch 心跳(看门狗不当它卡死)
      writeFileSync(join(out, GATE_RUNNING), new Date().toISOString() + "\n");
      const beat = () => touchHeartbeat(process.env.PIW_OUT ?? process.env.OMD_LITE_OUT);
      beat();
      const idleS = Number(envv("IDLE") || 1800);
      const timer = setInterval(beat, Math.min(30, (idleS > 0 ? idleS : 1800) / 4) * 1000);
      let c: GateRun;
      try {
        const env = { ...process.env, PIW_ROUND: String(round), PIW_ROUND_LOG: join(out, `gate-round-${round}.log`) };
        c = await runGate(classify, ctx.cwd, { env, timeoutMs: CLASSIFY_TIMEOUT_MS, stdoutOnly: true });
      } finally {
        clearInterval(timer);
        rmSync(join(out, GATE_RUNNING), { force: true });
      }
      try { writeFileSync(join(out, `round-classify-${round}.log`), `### exit=${c.code}${c.timedOut ? " (timeout)" : ""}\n${c.output}${c.stderr ?? ""}`); } catch {}
      const v = c.code === 0 && !c.timedOut ? parseVerdict(c.output) : null;
      if (v) {
        finished = true;
        writeFileSync(join(out, "result.json"), JSON.stringify({ gates: "fail", round, failed_gate: failed.cmd, exit: failed.code, timed_out: failed.timedOut, ...(stuck ? { stuck: "stuck-gate" } : {}), failureClass: v.failureClass, wasted: { class: v.failureClass, why: v.why, round }, ...(outside ? { outside } : {}) }) + "\n");
        return;
      }
    }
    if (round >= maxRounds || stuck || budgetHit) {
      finished = true;
      writeFileSync(
        join(out, "result.json"),
        JSON.stringify({ gates: "fail", round, failed_gate: failed.cmd, exit: failed.code, timed_out: failed.timedOut, ...(stuck ? { stuck: "stuck-gate" } : {}), ...(outside ? { outside } : {}), ...budgetNote }) + "\n",
      );
      return;
    }
    pi.sendUserMessage(
      [
        `闸未通过(第 ${round}/${maxRounds} 轮)。失败的命令:`,
        "```",
        failed.cmd,
        "```",
        `退出码 ${failed.code}${failed.timedOut ? "(超时被杀)" : ""}。输出最后 ${TAIL_LINES} 行:`,
        "```",
        tail(failed.output, TAIL_LINES),
        "```",
        "修好它,修完就停。不许削弱、跳过或删除测试,不许改闸命令本身;如果你认为判据本身错了,停下并说明理由。",
      ].join("\n"),
      { deliverAs: "followUp" },
    );
  });
}
