import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CueSet } from '../types'
import type { Cue, ForkLog, PickLog } from './seat'
import { clip, editKind, editRatio, enhancePrompt, oneLine, parseCues, seatPrompt, stats } from './seat'

const current = atom({ plugin: 'cue', key: 'current' } as const, null)
const relayMode = { plugin: 'relay', key: 'mode' } as const

const KEEP = 2000 // log entries kept per kind
const PREVIEW = 60

// C-4: silent while relay drives. Relay not installed / unreadable → idle.
async function relayRunning($: EngineInterface): Promise<boolean> {
  try {
    const { value } = await $.state.get(relayMode)
    return value === 'running'
  } catch {
    return false
  }
}

async function commands($: EngineInterface) {
  const all = await $.command.list()
  const known = new Set(all.map(c => c.name))
  const menu = all.filter(c => c.source !== 'mcp' && c.source !== 'builtin').map(c => c.name)
  return { known, menu }
}

async function append<T>($: EngineInterface, key: string, entry: T) {
  const list = ((await $.store.get(key)) as T[] | undefined) ?? []
  list.push(entry)
  await $.store.set(key, list.slice(-KEEP))
}

/** One generation: fork (or haiku), usage logged, reply parsed. */
async function generate($: EngineInterface, engine: string, kind: ForkLog['kind'], prompt: string, known: Set<string>, max: number) {
  const useHaiku = engine === 'haiku'
  const reply = useHaiku
    ? await $.model.complete({ model: 'haiku', prompt, maxTokens: 1500 })
    : await $.model.fork({ prompt })
  if ('usage' in reply) {
    const u = reply.usage
    const entry: ForkLog = {
      ts: await $.clock.now(),
      kind,
      engine: useHaiku ? 'haiku' : 'fork',
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens,
    }
    await append($, 'forks', entry)
  }
  return reply.isAnswered ? parseCues(reply.text, known, max) : []
}

async function fillAndLog($: EngineInterface, slot: PickLog['slot'], text: string) {
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  if (!filled.isFilled) return false
  await append<PickLog>($, 'picks', { ts: await $.clock.now(), slot, text })
  return true
}

export const register: Register = (on, options) => {
  const engine = String(options.engine ?? 'fork')
  const minChars = Number(options.minChars ?? 80)
  // The turn whose cues are wanted; a newer prompt makes older work stale.
  let wanted = ''
  let lastAnswer = ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'enhance', description: 'cue:把输入框里的粗稿改写成完整 prompt(空输入框则给下一步),写回输入框不发送' })
    await $.command.register({ name: 'cue', description: 'cue:用量与按下统计', argumentHint: '[stats]' })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    wanted = ''
    await update($, current, () => null)
    // Resolve the last unresolved pick against what was actually sent.
    if (e.origin.kind === 'composer') {
      const picks = ((await $.store.get('picks')) as PickLog[] | undefined) ?? []
      const last = picks[picks.length - 1]
      if (last && !last.edited) {
        const ratio = Number(editRatio(last.text, e.text).toFixed(3))
        last.edited = editKind(ratio)
        last.ratio = ratio
        await $.store.set('picks', picks)
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || e.reason !== 'answer') return result
    lastAnswer = e.answer
    if (engine === 'off' || e.answer.trim().length < minChars) return result
    if (await relayRunning($)) return result

    wanted = e.turnId
    const { known, menu } = await commands($)
    const items = await generate($, engine, 'answer', seatPrompt(e.answer, menu), known, 2)
    if (wanted !== e.turnId || items.length === 0) return result
    if (await relayRunning($)) return result
    const fresh: CueSet = { turnId: e.turnId, items }
    await update($, current, () => fresh)
    return result
  })

  on('command.run', { command: 'enhance' }, async $ => {
    const { text: draft } = await $.prompt.read()
    let pick: Cue | undefined
    let slot: PickLog['slot'] = 'enhance'
    if (draft.trim()) {
      const { known, menu } = await commands($)
      pick = (await generate($, engine, 'enhance', enhancePrompt(draft, menu), known, 1))[0]
    } else {
      // Empty draft: the post-answer cue, reused if it is already on the band.
      const shown = await read($, current)
      pick = shown?.items[0]
      if (pick) slot = '1'
      else {
        const { known, menu } = await commands($)
        const answer = lastAnswer || '(见上文主 session 的最后一条回答)'
        pick = (await generate($, engine, 'answer', seatPrompt(answer, menu), known, 1))[0]
      }
    }
    if (!pick) return { text: 'cue:这次没生成出可用的 prompt,输入框未改动。' }
    const ok = await fillAndLog($, slot, pick.prompt)
    await update($, current, () => null)
    return { text: ok ? `cue:已写入输入框(未发送)· ${pick.title}` : 'cue:输入框不可写(对话框打开中或无输入框)。' }
  })

  on('command.run', { command: 'cue' }, async $ => {
    const forks = ((await $.store.get('forks')) as ForkLog[] | undefined) ?? []
    const picks = ((await $.store.get('picks')) as PickLog[] | undefined) ?? []
    return { text: stats(forks, picks) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const shown = await read($, current)
    if (!shown || shown.items.length === 0) return next(e)
    if (await relayRunning($)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns - 4
    const press = (slot: '1' | '2', text: string) => async () => {
      await fillAndLog($, slot, text)
      await update($, current, () => null)
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>cue · 空输入框按数字或点击,写进草稿(不会发送)</Text>
        {shown.items.map((c, i) => {
          const slot = i === 0 ? '1' : '2'
          const name = `${i === 0 ? 'Enhance' : '方向 B'} · ${c.title}`
          const room = Math.max(0, Math.min(PREVIEW, width - name.length - 6))
          return (
            <Button key={`s${slot}`} plain hotkey={slot} label={name} onPress={press(slot, c.prompt)}>
              {name}
              {room > 8 ? <Text dimColor>{'  ' + clip(oneLine(c.prompt), room)}</Text> : null}
            </Button>
          )
        })}
      </Box>
    )
  })
}
