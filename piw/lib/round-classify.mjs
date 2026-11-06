// 白跑守卫的判词(PIW_ROUND_CLASSIFY 的输出)与 result.json 的 failureClass。分类逻辑在仓里(myapp scripts/factory-checks/wasted-round.mjs),
// 这里只认两类能让闸循环提前停的白跑:基线本来就红(base-red)· 任务书本身写错(brief-red)。分类命令跑在执行体沙箱里,
// 执行体改得到它 —— 它能做的最坏的事是让自己提前停,停下的片由 auto-collect 按类处置,不会因此合进 main。
export const WASTED_CLASSES = new Set(["base-red", "brief-red"]);

export function parseVerdict(stdout) {
  const last = String(stdout ?? "").trimEnd().split("\n").at(-1) ?? "";
  try {
    const v = JSON.parse(last);
    if (v && v.stop === true && WASTED_CLASSES.has(v.failureClass)) return { failureClass: v.failureClass, why: String(v.why ?? "") };
  } catch {}
  return null;
}

export function classOfResult(r) {
  if (r?.gates === "fail") return WASTED_CLASSES.has(r.failureClass) ? r.failureClass : "gate";
  if (r?.gates === "pass") return null;
  return undefined;
}
