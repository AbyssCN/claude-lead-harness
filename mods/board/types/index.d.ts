// A section of the board, as presets and a repo's `.claude/board.json` (`{ "sections": [...] }`) write it.
// `file` is relative to the repo root; a `*` path segment picks the highest-versioned match (10.11 > 10.9).
// Regexes are strings, matched per line.
export type BoardSection =
  | { kind: 'list'; label: string; file: string; heading: string; after?: string; stamp?: string; countOnly?: boolean; max?: number }
  | { kind: 'checklist'; label: string; file: string; group: '##' | '###'; titles?: boolean }
  | { kind: 'table'; label: string; file: string; heading?: string; show: string; count?: string; alert?: string }
  | { kind: 'pending'; label: string; file: string }

export type PaneTally = { name: string; done: number; running: number; planned: number }
export type PaneModel = {
  title: string
  goal: { tag: string; groups: PaneTally[] } | null
  running: Array<{ title: string; runs: string }>
  blocks: Array<{ key: string; summary: string; lines: string[] }>
  roadmap: PaneTally[]
}

// The sidebar's model (the current repo's board), refreshed on open, each turn and every minute.
declare module 'claude-code' {
  interface PluginState {
    board: { model: PaneModel | null; at: number; open: Record<string, boolean> }
  }
}
