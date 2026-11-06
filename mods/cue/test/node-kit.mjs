// `node --test cue/cue.test.ts` resolves 'claude-code/testing' here (cue/package.json names this folder
// claude-code and exports ./testing); `claude plugin test cue` gives the same file the engine's own kit.
// Only what cue.test.ts uses: pure tests, no `$`.
export { describe, test } from 'node:test'
import assert from 'node:assert/strict'
export function expect(actual) {
  const is = {
    toBe: (v) => assert.equal(actual, v),
    toEqual: (v) => assert.deepEqual(actual, v),
    toContain: (v) => assert.ok(actual.includes(v), `${JSON.stringify(actual).slice(0, 200)} 不含 ${JSON.stringify(v)}`),
    toBeNull: () => assert.equal(actual, null),
    toBeGreaterThan: (v) => assert.ok(actual > v, `${actual} 不大于 ${v}`),
    toHaveLength: (n) => assert.equal(actual.length, n),
  }
  is.not = {
    toBe: (v) => assert.notEqual(actual, v),
    toContain: (v) => assert.ok(!actual.includes(v), `含 ${JSON.stringify(v)}`),
    toBeNull: () => assert.notEqual(actual, null),
  }
  return is
}
