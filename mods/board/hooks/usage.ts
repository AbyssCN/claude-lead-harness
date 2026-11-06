// Today's model spend, read out of the fallback ledger piw writes:
// `<HOME>/.omd-lite/usage/<local day>.jsonl`, one JSON object per line.
// Pure on purpose: the board shows the ledger, it never writes it and never caps a run.
export type UsageRow = {
  at: number
  label: string
  model: string
  arm: 'primary' | 'fallback'
  tokens: { total: number }
}

// The ledger's file name for a day, in local time (piw files it by the local date).
export function usageDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// The lines piw wrote, in order. A line that is not a row with a model and a token
// total is skipped: one torn line must not cost the day its other rows. `arm` is one of
// the format's two words; anything else reads as `primary`, so the row still counts.
export function parseUsage(jsonl: string): UsageRow[] {
  const out: UsageRow[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const r = parsed as { at?: unknown; label?: unknown; model?: unknown; arm?: unknown; tokens?: { total?: unknown } } | null
    const total = Number(r?.tokens?.total)
    if (typeof r?.model !== 'string' || !r.model || !Number.isFinite(total)) continue
    const at = Number(r.at)
    out.push({
      at: Number.isFinite(at) ? at : 0,
      label: typeof r.label === 'string' ? r.label : '',
      model: r.model,
      arm: r.arm === 'fallback' ? 'fallback' : 'primary',
      tokens: { total },
    })
  }
  return out
}

// `今日 token:<model> <spent> · …(备用 <fallback spent> / 上限 <cap>)`, models by spend high first,
// each named by the part after its provider. null when the day holds no rows: nothing spent
// is not a `0` worth printing.
export function usageLine(rows: UsageRow[], cap: number): string | null {
  if (!rows.length) return null
  const totals = new Map<string, number>()
  let fallback = 0
  for (const r of rows) {
    totals.set(r.model, (totals.get(r.model) ?? 0) + r.tokens.total)
    if (r.arm === 'fallback') fallback += r.tokens.total
  }
  const spent = [...totals]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model, total]) => `${model.slice(model.lastIndexOf('/') + 1)} ${fmtTokens(total)}`)
    .join(' · ')
  return `今日 token:${spent}(备用 ${fmtTokens(fallback)} / 上限 ${fmtTokens(cap)})`
}

// 999 → '999' · 1234 → '1.2k' · 1234567 → '1.2M' · 1234567890 → '1.2B'
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

// The sidebar's 今日用量 block: the day's total and one row per model, spend high first,
// each named by the part after its provider. null when the day holds no rows.
export function usageRows(rows: UsageRow[]): { total: number; models: Array<{ model: string; total: number }> } | null {
  if (!rows.length) return null
  const totals = new Map<string, number>()
  for (const r of rows) totals.set(r.model, (totals.get(r.model) ?? 0) + r.tokens.total)
  const models = [...totals]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model, total]) => ({ model: model.slice(model.lastIndexOf('/') + 1), total }))
  return { total: models.reduce((n, m) => n + m.total, 0), models }
}
