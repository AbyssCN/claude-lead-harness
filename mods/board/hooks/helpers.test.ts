import { describe, expect, test } from 'claude-code/testing'

import { frameOf, helperFromAgent, helperFromRun } from './helpers'

const agent = (type: string, status = 'running') => helperFromAgent({ id: 'a1', type, description: 'look around', status, startedAt: 1, contextTokens: 1200 })
const run = (executor: string, state = 'running', model?: string) =>
  helperFromRun({ id: 'r1', label: 'slice', executor, model, state, startedAt: 2, round: 1, maxRounds: 3 })

describe('board helpers', () => {
  test('savvy-<tier> agent types map to that tier, with or without a plugin prefix', () => {
    for (const t of ['fable', 'heavy', 'careful', 'medium', 'light'] as const) {
      expect(agent(`savvy-${t}`).costume).toBe(t)
      expect(agent(`savvy-flow:savvy-${t}`).costume).toBe(t)
    }
  })

  test('Explore → explore, anything else → other', () => {
    expect(agent('Explore').costume).toBe('explore')
    expect(agent('general-purpose').costume).toBe('other')
    expect(agent('savvy-bogus').costume).toBe('other')
    expect(agent('x:Explore').costume).toBe('other')
  })

  test('agent fields and status → phase', () => {
    const h = agent('Explore')
    expect(h).toEqual({ id: 'a1', label: 'look around', costume: 'explore', phase: 'working', step: 'look around', tokens: 1200, startedAt: 1 })
    expect(agent('Explore', 'completed').phase).toBe('done')
    expect(agent('Explore', 'idle').phase).toBe('done')
    expect(agent('Explore', 'failed').phase).toBe('failed')
    expect(agent('Explore', 'killed').phase).toBe('failed')
    expect(helperFromAgent({ id: 'a2', type: 'Explore', status: 'running', startedAt: 0 }).tokens).toBeNull()
  })

  test('runs: mcode / minimax executor or minimax model → minimax, else other', () => {
    expect(run('mcode').costume).toBe('minimax')
    expect(run('minimax').costume).toBe('minimax')
    expect(run('pi', 'running', 'MiniMax-M2').costume).toBe('minimax')
    expect(run('pi', 'running', 'gpt-5').costume).toBe('other')
    expect(run('pi').costume).toBe('other')
  })

  test('run state → phase, round fields carried', () => {
    const h = run('mcode')
    expect(h.phase).toBe('working')
    expect(h.round).toBe(1)
    expect(h.maxRounds).toBe(3)
    expect(h.label).toBe('slice')
    expect(run('mcode', 'fail').phase).toBe('failed')
    expect(run('mcode', 'pass').phase).toBe('done')
    expect(run('mcode', 'merged').phase).toBe('done')
  })

  test("delegate's interrupted run is a failed card", () => {
    expect(run('mcode', 'interrupted').phase).toBe('failed')
  })

  test('frameOf: consecutive ticks differ while working, 0 otherwise', () => {
    for (let t = 0; t < 6; t++) {
      expect(frameOf(t, 'working')).not.toBe(frameOf(t + 1, 'working'))
      expect(frameOf(t, 'done')).toBe(0)
      expect(frameOf(t, 'failed')).toBe(0)
    }
  })

  test("savvy's old floor(at / 500) on a 1000ms clock never changes parity (D-4)", () => {
    const old = (at: number) => Math.floor(at / 500) % 2
    expect(old(1000)).toBe(old(2000))
  })
})
