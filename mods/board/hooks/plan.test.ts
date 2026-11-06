import { describe, expect, test } from 'claude-code/testing'

import { DONE_HOLD_MS, nudgeFor, PLAN_PROMPT, PLAN_TOOL_NAME, planFromCall, planPath } from './plan'
import type { Plan } from './plan'

const T0 = '2026-10-23T10:00:00.000Z'
const T1 = '2026-10-23T10:05:00.000Z'

describe('board plan', () => {
  test('planPath is the shared mods-state file', () => {
    expect(planPath('/home/u', 's1')).toBe('/home/u/.claude/mods-state/plan-s1.json')
  })

  test('prompt names the board tool, not the old one', () => {
    expect(PLAN_TOOL_NAME).toBe('plan')
    expect(PLAN_PROMPT).toContain('mcp__board__plan')
    expect(PLAN_PROMPT).not.toContain('mcp__helper-desk__plan')
    expect(DONE_HOLD_MS).toBe(20_000)
  })

  test('the plan tool takes title and steps, stamps done times', () => {
    const p = planFromCall('mcp__board__plan', { title: ' 活 ', steps: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }] }, null, T0)
    expect(p).toEqual({ title: '活', steps: [{ text: 'a', status: 'completed', doneAt: T0 }, { text: 'b', status: 'in_progress' }], updatedAt: T0 })
    const q = planFromCall('plan', { steps: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'completed' }] }, p, T1)
    expect(q?.title).toBe('活')
    expect(q?.steps.map(s => s.doneAt)).toEqual([T0, T1])
  })

  test('a list with work left after a finished plan is a new plan', () => {
    const done: Plan = { title: '旧', steps: [{ text: 'a', status: 'completed' }], updatedAt: T0 }
    const p = planFromCall('plan', { steps: [{ text: 'x', status: 'pending' }] }, done, T1)
    expect(p?.title).toBe('计划')
  })

  test('TodoWrite is mirrored', () => {
    const p = planFromCall('TodoWrite', { todos: [{ content: 'one\n two', status: 'in_progress' }, { content: 'b', status: 'weird' }, { content: '' }] }, null, T0)
    expect(p?.steps).toEqual([{ text: 'one two', status: 'in_progress' }, { text: 'b', status: 'pending' }])
    expect(p?.updatedAt).toBe(T0)
  })

  test('TaskCreate appends, TaskUpdate edits and deletes by id', () => {
    const a = planFromCall('TaskCreate', { subject: 'first', taskId: '1' }, null, T0)
    const b = planFromCall('TaskCreate', { subject: 'second', taskId: '2' }, a, T0)
    expect(b?.steps.map(s => s.text)).toEqual(['first', 'second'])
    const c = planFromCall('TaskUpdate', { taskId: '1', status: 'completed' }, b, T1)
    expect(c?.steps[0]).toEqual({ text: 'first', status: 'completed', id: '1', doneAt: T1 })
    const d = planFromCall('TaskUpdate', { taskId: '2', status: 'deleted' }, c, T1)
    expect(d?.steps.map(s => s.text)).toEqual(['first'])
    const e = planFromCall('TaskUpdate', { taskId: '9', subject: 'late', status: 'in_progress' }, d, T1)
    expect(e?.steps.map(s => s.text)).toEqual(['late'])
    expect(e?.title).toBe('计划')
    expect(planFromCall('TaskUpdate', { taskId: '9' }, null, T1)).toBeNull()
  })

  test('other tools give null', () => {
    expect(planFromCall('mcp__helper-desk__plan', { steps: [] }, null, T0)).toBeNull()
    expect(planFromCall('Bash', {}, null, T0)).toBeNull()
  })

  test('nudge only for long work: 12 calls without a plan, never on a plain turn after an old plan, stale after 8', () => {
    expect(nudgeFor({ turnCalls: 11, planned: false, sinceUpdate: 11, live: false })).toBeNull()
    expect(nudgeFor({ turnCalls: 12, planned: false, sinceUpdate: 12, live: false })).toContain('no plan')
    expect(nudgeFor({ turnCalls: 12, planned: false, sinceUpdate: 3, live: true })).toBeNull()
    expect(nudgeFor({ turnCalls: 3, planned: true, sinceUpdate: 7, live: true })).toBeNull()
    const s = nudgeFor({ turnCalls: 3, planned: true, sinceUpdate: 8, live: true })
    expect(s).toContain('in a while')
    expect(s).toContain('mcp__board__plan')
    expect(nudgeFor({ turnCalls: 9, planned: true, sinceUpdate: 9, live: false })).toBeNull()
  })

  test('the prompt keeps plain questions and short fixes off the plan tool', () => {
    expect(PLAN_PROMPT).not.toContain('2 or more steps')
    expect(PLAN_PROMPT).toContain('Do not use it for questions')
  })
})
