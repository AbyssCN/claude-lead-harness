import { describe, expect, test } from 'claude-code/testing'

import { cells, handoffView } from './hud'
import type { RelayIn } from './hud'
import { hudLines, textOf } from './tui'
import type { Cache, Hud } from './tui'
import { PEN_FIXTURE as pen } from './pen-fixture'

// F 稿 ④(40 列定稿,10.24):relay 交接时第 2 行右段整段换掉 ◷,≤24 格。
const HUD = (pen as { hud: Hud }).hud
const NOW = 50_000_000
const idle: RelayIn = { phase: 'idle', waitAgents: false, armedAt: 0, clearAt: 0, stage: '' }
const seg = (c: Cache) => {
  const l2 = hudLines({ ...HUD, cache: c })[1]
  const all = textOf(l2)
  const at = all.lastIndexOf('│ ') + 2
  let n = 0
  return { text: all.slice(at), row: l2.filter(s => ((n += s.t.length) - s.t.length) >= at) }
}

describe('handoffView: relay handoff() → F row', () => {
  test('idle / due / no relay → null (◷ as before)', () => {
    expect(handoffView(null, NOW)).toBe(null)
    expect(handoffView(idle, NOW)).toBe(null)
    expect(handoffView({ ...idle, phase: 'due' }, NOW)).toBe(null)
  })
  test('armed → writing', () => {
    expect(handoffView({ ...idle, phase: 'armed', armedAt: NOW - 5000 }, NOW)).toEqual({ state: 'ho-write' })
  })
  test('armed waiting for subagents → minutes waited', () => {
    expect(handoffView({ ...idle, phase: 'armed', waitAgents: true, armedAt: NOW - 4 * 60_000 }, NOW)).toEqual({ state: 'ho-wait', min: 4 })
  })
  test('ready before clearAt → seconds left', () => {
    expect(handoffView({ ...idle, phase: 'ready', clearAt: NOW + 22_300 }, NOW)).toEqual({ state: 'ho-count', sec: 23 })
  })
  test('ready past clearAt (held by a turn or subagents) → waiting', () => {
    expect(handoffView({ ...idle, phase: 'ready', clearAt: NOW - 2 * 60_000 }, NOW)).toEqual({ state: 'ho-wait', min: 2 })
  })
  test('the checkpoint flush wins', () => {
    expect(handoffView({ ...idle, phase: 'ready', clearAt: NOW + 9000, stage: 'flush' }, NOW)).toEqual({ state: 'ho-flush' })
  })
})

describe('the F segment, as the .pen ④', () => {
  test('writing: ✎ 写交接… + [取消]', () => {
    const s = seg({ state: 'ho-write' })
    expect(s.text).toBe('✎ 写交接…  取消 ')
    expect(s.row.find(x => x.t === ' 取消 ')?.press).toBe('ho-cancel')
  })
  test('waiting: ⏸ 等子 agent 4m + [取消]', () => {
    expect(seg({ state: 'ho-wait', min: 4 }).text).toBe('⏸ 等子 agent 4m  取消 ')
  })
  test('countdown: yellow seconds, [现在交接] [取消]; last 5 s red', () => {
    const s = seg({ state: 'ho-count', sec: 23 })
    expect(s.text).toBe('⟲ 23s  现在交接   取消 ')
    expect(s.row[0]).toEqual({ t: '⟲ 23s ', fg: '#eab308', bg: '#0c0c0c', b: true })
    expect(s.row.find(x => x.t === ' 现在交接 ')?.press).toBe('ho-now')
    expect(seg({ state: 'ho-count', sec: 4 }).row[0]!.fg).toBe('#ef4444')
  })
  test('flush: ✎ 补存 checkpoint…, no button', () => {
    expect(seg({ state: 'ho-flush' }).text).toBe('✎ 补存 checkpoint…')
  })
  test('every F row at its longest fits 24 cells', () => {
    for (const c of [{ state: 'ho-write' }, { state: 'ho-wait', min: 30 }, { state: 'ho-count', sec: 300 }, { state: 'ho-flush' }] as Cache[])
      expect(cells(seg(c).text)).toBeLessThanOrEqual(24)
  })
})
