import { spawnSync } from 'node:child_process';

// herdr: success = exit 0 + JSON {result} on stdout; failure = exit 1 + JSON {error:{code,message}} on stderr.
export function herdr(args, { timeoutMs = 120000 } = {}) {
  const cmd = process.env.TICKET_HERDR || 'herdr';
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, env: process.env });
  if (r.error) return { ok: false, code: r.error.code === 'ETIMEDOUT' ? 'timeout' : 'spawn_failed', message: String(r.error.message) };
  if (r.status === 0) {
    try { return { ok: true, result: JSON.parse(r.stdout).result ?? {} }; } catch { return { ok: true, result: {}, raw: r.stdout }; }
  }
  try {
    const e = JSON.parse(r.stderr).error;
    return { ok: false, code: e.code, message: e.message };
  } catch {
    return { ok: false, code: `exit_${r.status}`, message: (r.stderr || r.stdout || '').trim().slice(0, 500) };
  }
}

export const agentGet = (target) => herdr(['agent', 'get', target]);
export const agentList = () => herdr(['agent', 'list']);
export const paneClose = (pane) => herdr(['pane', 'close', pane]);

export function agentWait(target, { until = [], timeoutMs }) {
  const a = ['agent', 'wait', target];
  for (const u of until) a.push('--until', u);
  a.push('--timeout', String(timeoutMs));
  return herdr(a, { timeoutMs: timeoutMs + 15000 });
}

export function agentPrompt(target, text, { wait = false, until = [], timeoutMs } = {}) {
  const a = ['agent', 'prompt', target, text];
  if (wait) a.push('--wait');
  for (const u of until) a.push('--until', u);
  if (timeoutMs) a.push('--timeout', String(timeoutMs));
  return herdr(a, { timeoutMs: (timeoutMs ?? 60000) + 15000 });
}

export function tabCreate({ workspace, cwd, label, env }) {
  const a = ['tab', 'create'];
  if (workspace) a.push('--workspace', workspace);
  a.push('--cwd', cwd, '--label', label);
  for (const [k, v] of Object.entries(env)) a.push('--env', `${k}=${v}`);
  a.push('--no-focus');
  return herdr(a);
}

// owner 6.11: ticket sessions default to Opus at low effort. Not set in settings.json because effort there also reaches Opus review subagents.
const claudeArgs = () => (process.env.TICKET_CLAUDE_ARGS ?? '--model opus --effort low').split(/\s+/).filter(Boolean);

export function agentStart(name, pane, timeoutMs) {
  const args = claudeArgs();
  return herdr(['agent', 'start', name, '--kind', 'claude', '--pane', pane, '--timeout', String(timeoutMs), ...(args.length ? ['--', ...args] : [])], { timeoutMs: timeoutMs + 15000 });
}

export const tabList = (workspace) => herdr(['tab', 'list', ...(workspace ? ['--workspace', workspace] : [])]);
export const paneList = (workspace) => herdr(['pane', 'list', ...(workspace ? ['--workspace', workspace] : [])]);

export function paneSplit({ pane, cwd, env, direction }) {
  const a = ['pane', 'split', pane, '--direction', direction, '--cwd', cwd];
  for (const [k, v] of Object.entries(env)) a.push('--env', `${k}=${v}`);
  a.push('--no-focus');
  return herdr(a);
}
