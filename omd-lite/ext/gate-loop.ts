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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GATE_TIMEOUT_MS = 15 * 60 * 1000;
const TAIL_LINES = 80;

type GateRun = { cmd: string; code: number | null; timedOut: boolean; output: string };

function runGate(cmd: string, cwd: string): Promise<GateRun> {
  return new Promise((resolve) => {
    // detached = 独立进程组,超时时整组杀掉(vitest/tsc 会起子进程)
    const child = spawn("bash", ["-lc", cmd], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.stderr.on("data", (b: Buffer) => chunks.push(b));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
    }, GATE_TIMEOUT_MS);
    const done = (code: number | null, extra = "") => {
      clearTimeout(timer);
      resolve({ cmd, code, timedOut, output: Buffer.concat(chunks).toString("utf8") + extra });
    };
    child.on("error", (e) => done(null, `\n[spawn error] ${e.message}`));
    child.on("close", (code) => done(code));
  });
}

const tail = (s: string, n: number) => s.split("\n").slice(-n).join("\n");

export type Change = { status: string; path: string; diff?: string };

/**
 * 越界改动 = 不在允许表(精确路径，或目录前缀)里、也不在豁免里的改动。
 * 豁免(首批约百个 slice 实测的越界全是这两类，验收判为正当):
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
  const raw = process.env.OMD_LITE_GATES;
  if (!raw) return;
  const gates: string[] = JSON.parse(raw);
  const maxRounds = Number(process.env.OMD_LITE_MAX_ROUNDS || 3);
  const out = process.env.OMD_LITE_OUT || process.cwd();
  const allowed: string[] | null = process.env.OMD_LITE_ALLOWED ? JSON.parse(process.env.OMD_LITE_ALLOWED) : null;
  const base = process.env.OMD_LITE_BASE;
  mkdirSync(out, { recursive: true });
  let round = 0;
  let finished = false;
  // 同一道闸连红 STUCK_ROUNDS 轮就提前停(与 bin/omd-lite 的 mcode 闸循环同判据)
  const STUCK_ROUNDS = 3;
  const failedHistory: string[] = [];

  pi.on("agent_end", async (event, ctx) => {
    if (finished) return;
    // 供应商报错 / 中断:pi 可能自行重试,此时不判闸(没判的轮不计数)
    const last = event.messages[event.messages.length - 1] as { role?: string; stopReason?: string } | undefined;
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) return;

    round++;
    const runs: GateRun[] = [];
    for (const g of gates) {
      const r = await runGate(g, ctx.cwd);
      runs.push(r);
      if (r.code !== 0) break; // 首个失败即停,后面的闸在这一轮没有信息量
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
      runs.map((r) => `### $ ${r.cmd}\n### exit=${r.code}${r.timedOut ? " (timeout)" : ""}\n${r.output}\n`).join("\n"),
    );
    if (!failed) {
      finished = true;
      writeFileSync(join(out, "result.json"), JSON.stringify({ gates: "pass", round, ...(outside ? { outside } : {}) }) + "\n");
      return;
    }
    failedHistory.push(failed.cmd);
    const stuck = failedHistory.length >= STUCK_ROUNDS && failedHistory.slice(-STUCK_ROUNDS).every((c) => c === failed!.cmd);
    if (round >= maxRounds || stuck) {
      finished = true;
      writeFileSync(
        join(out, "result.json"),
        JSON.stringify({ gates: "fail", round, failed_gate: failed.cmd, exit: failed.code, timed_out: failed.timedOut, ...(stuck ? { stuck: "stuck-gate" } : {}), ...(outside ? { outside } : {}) }) + "\n",
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
