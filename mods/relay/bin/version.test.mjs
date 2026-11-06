import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('register.ts 的 RELAY_VERSION 与 plugin.json 的 version 一致(handoff.log 的 start 行靠它分新旧版会话)', () => {
  const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  const src = readFileSync(new URL('../hooks/register.ts', import.meta.url), 'utf8')
  assert.equal(src.match(/export const RELAY_VERSION = '([^']+)'/)?.[1], manifest.version)
})
