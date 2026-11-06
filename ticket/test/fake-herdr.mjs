#!/usr/bin/env node
// Stand-in for herdr. FAKE_HERDR_LOG: one JSON line per call (argv, plus the ticket's last event at call time).
// FAKE_HERDR_SCRIPT: JSON {"<sub> <cmd>": response | [response, …]}; response = {result} | {error:{code,message}}.
// An array is consumed in order by call count of that key; the last element repeats.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const key = argv.slice(0, 2).join(' ');
const logFile = process.env.FAKE_HERDR_LOG;
const prior = logFile && fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.key === key).length
  : 0;

let lastEvent = null;
const m = argv.join(' ').match(/\bt\d{4}-\d+\b/);
if (m && process.env.TICKET_ROOT) {
  for (const repo of fs.readdirSync(process.env.TICKET_ROOT)) {
    const f = path.join(process.env.TICKET_ROOT, repo, `${m[0]}.events.jsonl`);
    if (fs.existsSync(f)) lastEvent = JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop());
  }
}
if (logFile) fs.appendFileSync(logFile, JSON.stringify({ key, argv, lastEvent }) + '\n');

const defaults = {
  'tab create': { result: { tab: { tab_id: 'wZ:t9' }, root_pane: { pane_id: 'wZ:p50' } } },
  'agent start': { result: { agent: { name: argv[2], pane_id: 'wZ:p50' } } },
  'agent prompt': { result: {} },
  'agent get': { result: { agent: { name: argv[2], agent: 'claude', agent_status: 'idle', pane_id: 'wZ:p50' } } },
  'agent list': { result: { agents: [] } },
  'pane close': { result: {} },
};
const script = process.env.FAKE_HERDR_SCRIPT ? JSON.parse(fs.readFileSync(process.env.FAKE_HERDR_SCRIPT, 'utf8')) : {};
let resp = script[key] ?? defaults[key] ?? { result: {} };
if (Array.isArray(resp)) resp = resp[Math.min(prior, resp.length - 1)];
if (resp.delayMs) { // a slow answer, to test what happens while herdr is busy
  const until = Date.now() + Number(resp.delayMs);
  while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}
if (resp.error) {
  process.stderr.write(JSON.stringify({ error: resp.error, id: `cli:${key}` }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ id: `cli:${key}`, result: resp.result }));
