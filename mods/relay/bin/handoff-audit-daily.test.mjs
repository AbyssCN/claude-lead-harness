import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { daily } from './handoff-audit-daily.mjs'

const report = (pass) => ({ verdict: { pass, over400: pass ? [] : ['aaaaaaaa'], over550: [], compacts: 0, goalRate: 1, stuck: 0, lost: 0 }, crossTail: { sessions: 1, median: 3, p90: 3, max: 3, over20: 0 } })

function deps(pass, { leadAlive = false } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'hdaily-'))
  const launched = []
  return {
    out,
    launched,
    d: {
      out,
      now: () => '2026-10-24T03:13:00.000Z',
      sessions: () => ['aaaaaaaa'],
      audit: () => report(pass),
      leadAlive: () => leadAlive,
      launch: (prompt) => launched.push(prompt),
    },
  }
}

test('判据全过:写当天读数和 jsonl 一行,不叫 lead', () => {
  const { out, launched, d } = deps(true)
  const r = daily(d)
  assert.equal(r, 'pass')
  assert.equal(launched.length, 0)
  assert.ok(existsSync(join(out, '2026-10-24.json')))
  const row = JSON.parse(readFileSync(join(out, 'daily.jsonl'), 'utf8').trim())
  assert.equal(row.pass, true)
  assert.equal(row.crossTail.p90, 3)
})

test('写进 daily.jsonl 的那行多 orphans、orphanBlind、orphanFalse、orphanMaxS 四个键(⑦ 孤儿 GOAL 的读数)', () => {
  const out = mkdtempSync(join(tmpdir(), 'hdaily-'))
  const read = {
    verdict: { pass: false, over400: [], over550: [], compacts: 0, goalRate: 1, stuck: 0, lost: 0, orphans: 2, orphanBlind: 3, orphanFalse: 1, orphanMaxS: 900 },
    crossTail: { sessions: 1, median: 3, p90: 3, max: 3, over20: 0 },
  }
  daily({
    out,
    now: () => '2026-10-24T03:13:00.000Z',
    sessions: () => ['aaaaaaaa'],
    audit: () => read,
    leadAlive: () => false,
    launch: () => {},
  })
  const row = JSON.parse(readFileSync(join(out, 'daily.jsonl'), 'utf8').trim())
  assert.equal(row.orphans, 2)
  assert.equal(row.orphanBlind, 3)
  assert.equal(row.orphanFalse, 1)
  assert.equal(row.orphanMaxS, 900)
})

test('有判据没到:叫醒一个 lead,prompt 带读数文件路径、判官命令和先写失败测试的要求', () => {
  const { out, launched, d } = deps(false)
  assert.equal(daily(d), 'woke')
  assert.equal(launched.length, 1)
  assert.ok(launched[0].includes(join(out, '2026-10-24.json')))
  assert.ok(launched[0].includes('node relay/bin/handoff-audit.mjs --since 2026-10-23T02:18:00Z --sessions'))
  assert.ok(launched[0].includes('先写失败测试'))
})

test('上一个 lead 还在跑:不再叫第二个', () => {
  const { launched, d } = deps(false, { leadAlive: true })
  assert.equal(daily(d), 'lead-busy')
  assert.equal(launched.length, 0)
})

test('handoff.log 里还没有新版会话的 start 行:记 no-data,不叫 lead;有就只把这些会话交给判官', () => {
  const { launched, d } = deps(false)
  let asked = null
  assert.equal(daily({ ...d, sessions: () => [], audit: (only) => ((asked = only), report(false)) }), 'no-data')
  assert.equal(launched.length, 0)
  assert.equal(asked, null)
  daily({ ...d, sessions: () => ['bbbbbbbb'], audit: (only) => ((asked = only), report(true)) })
  assert.deepEqual(asked, ['bbbbbbbb'])
})

test('newSessions:从 handoff.log 取 start relay 版本 ≥ 0.6.0 的会话 id', async () => {
  const { newSessions } = await import('./handoff-audit-daily.mjs')
  const log = [
    '2026-10-23T05:00:00.000Z 3573d133 start relay 0.5.0',
    '2026-10-23T06:00:00.000Z 4eda7dbc start relay 0.6.0',
    '2026-10-23T06:01:00.000Z 4eda7dbc armed idle 412k /h/x.md',
    '2026-10-24T06:00:00.000Z 01d4eade start relay 0.10.1',
  ].join('\n')
  assert.deepEqual(newSessions(log, '0.6.0'), ['4eda7dbc', '01d4eade'])
})

test('⑦ 只量 0.8.0 起的会话:读数取 orphanAudit 的,不取主读数里的(主读数照旧量 0.6.4 起的会话)', () => {
  const out = mkdtempSync(join(tmpdir(), 'hdaily-'))
  let asked = null
  const main = { verdict: { pass: true, over400: [], over550: [], compacts: 0, goalRate: 1, stuck: 0, lost: 0, orphans: 0, orphanBlind: 0, orphanFalse: 0, orphanMaxS: 0 }, crossTail: report(true).crossTail }
  const seven = { verdict: { pass: false, orphans: 0, orphanBlind: 1, orphanFalse: 0, orphanMaxS: 700 }, orphans: [{ session: 'cccccccc', kind: 'blind' }] }
  const launched = []
  const r = daily({
    out,
    now: () => '2026-10-24T03:13:00.000Z',
    sessions: () => ['aaaaaaaa', 'bbbbbbbb'],
    orphanSessions: () => ['bbbbbbbb'],
    audit: () => main,
    orphanAudit: (only) => ((asked = only), seven),
    leadAlive: () => false,
    launch: (p) => launched.push(p),
  })
  assert.deepEqual(asked, ['bbbbbbbb'])
  const row = JSON.parse(readFileSync(join(out, 'daily.jsonl'), 'utf8').trim())
  assert.equal(row.orphanBlind, 1)
  assert.equal(row.orphanMaxS, 700)
  assert.equal(row.orphanSessions, 1)
  assert.equal(row.pass, false)
  assert.equal(r, 'woke')
  assert.match(launched[0], /⑦/)
})

test('⑦ 还没有 0.8.0 起的会话:不跑 orphanAudit,⑦ 记 0、orphanSessions 记 0,不因 ⑦ 叫 lead', () => {
  const out = mkdtempSync(join(tmpdir(), 'hdaily-'))
  let called = false
  const r = daily({
    out,
    now: () => '2026-10-24T03:13:00.000Z',
    sessions: () => ['aaaaaaaa'],
    orphanSessions: () => [],
    audit: () => report(true),
    orphanAudit: () => ((called = true), report(false)),
    leadAlive: () => false,
    launch: () => {},
  })
  assert.equal(called, false)
  assert.equal(r, 'pass')
  const row = JSON.parse(readFileSync(join(out, 'daily.jsonl'), 'utf8').trim())
  assert.equal(row.orphans, 0)
  assert.equal(row.orphanBlind, 0)
  assert.equal(row.orphanSessions, 0)
})
