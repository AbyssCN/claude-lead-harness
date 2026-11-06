// Sprites copied from savvy-progress/hooks/register.tsx: desktop SVG crabs and the terminal 8×6 pixels.

export type CostumeKey = 'other' | 'fable' | 'heavy' | 'careful' | 'medium' | 'light' | 'explore' | 'minimax'
export const COSTUME_KEYS: readonly CostumeKey[] = ['other', 'fable', 'heavy', 'careful', 'medium', 'light', 'explore', 'minimax']
export type Px = { x: number; y: number; w: number; h: number; c: string; cls: string }

const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  other: '#888780',
}
const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
export const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-fable.run{animation:float 1s ease-in-out infinite}
.c-fable.run .la,.c-fable.run .lb,.c-fable.run .bd{animation:none}
.c-fable.run .ant{animation:blink 1s steps(1) infinite}
.c-fable.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-heavy.run .it{animation:scan 1s steps(1) infinite}
.c-heavy.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-careful.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-medium.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-medium.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-light.run .la{animation-duration:.25s}.c-light.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-light.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
.c-minimax.run .e0,.c-minimax.run .e1,.c-minimax.run .e2,.c-minimax.run .e3,.c-minimax.run .e4{transform-origin:50% 100%;animation:eq .5s ease-in-out infinite}
.c-minimax.run .e1{animation-delay:-.1s}.c-minimax.run .e2{animation-delay:-.2s}.c-minimax.run .e3{animation-delay:-.3s}.c-minimax.run .e4{animation-delay:-.4s}
.c-minimax.run .arm{transform-origin:0 100%;animation:tilt 1s ease-in-out infinite}
@keyframes eq{50%{transform:scaleY(.35)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Fable: astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  fable: (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Heavy: detective with a deerstalker; the magnifier sweeps and glints.
  heavy: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Careful: engineer in a hard hat; the wrench turns a bolt.
  careful: (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Medium: chef, the toque traced from DockCrab's Sprites.chefHat; tosses the omelette.
  medium: (f, t) => {
    crabBody(f, -4, 'pan')
    stamp(f, 6, 0, ['........lll.......', '.......lllll......', '.wwwwgwwwwwwgwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwgwwwwwggwwwww', '.wwwwgwwwwwggwwwww', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.'], { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: t, d: '#B45F43' })
    f(22, 8, 7, 2, '#4A4A48', 'pan'); f(26, 10, 1, 1, '#4A4A48', 'pan'); f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  // Light: racer in a helmet; runs at double pace, the checkered flag flutters.
  light: (f, t) => {
    crabBody(f, -4)
    stamp(f, 6, 5, ['....rrrrrrrrrr....', '..rrrrrrwwrrrrrr..', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.kkkkkkkkkkkkkkkkr'], { r: t, w: '#F8F6F1', k: INK })
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: f => crabBody(f),
  // MiniMax (mcode): a peach blob in the brand's pink-to-orange, the logo's waveform as its crest;
  // the bars pump like an equalizer while it works and the right arm types.
  minimax: f => {
    MM_WAVE.forEach(([x, h, c], i) => f(x, 10 - h, 2, h, c, `e${i}`))
    f(8, 10, 14, 1, MM.pink); f(7, 11, 16, 1, MM.pink); f(6, 12, 18, 6, MM.pink)
    f(6, 18, 18, 3, MM.coral); f(7, 21, 16, 1, MM.orange)
    f(9, 13, 4, 4, '#FFFFFF'); f(17, 13, 4, 4, '#FFFFFF'); f(11, 14, 2, 2, INK); f(19, 14, 2, 2, INK)
    f(8, 17, 2, 1, MM.cheek); f(20, 17, 2, 1, MM.cheek); f(14, 18, 2, 1, MM.deep)
    f(3, 15, 3, 3, MM.pink); f(24, 14, 3, 3, MM.pink, 'arm')
    f(9, 22, 3, 3, MM.deep, 'la'); f(18, 22, 3, 3, MM.deep, 'lb')
  },
}
// --- MiniMax: the same character for the desktop (SVG) and the terminal (half blocks).

const MM = { pink: '#F23F5D', coral: '#FF6B4A', orange: '#FF9A3C', deep: '#B81E4B', cheek: '#FFC2CC' }
// Crest bars: x, height, colour, from pink to orange like the logo's gradient.
const MM_WAVE: [number, number, string][] = [
  [8, 3, '#F23F5D'],
  [11, 6, '#F5505A'],
  [14, 8, '#F96650'],
  [17, 6, '#FC7D46'],
  [20, 3, '#FF9A3C'],
]

// 7×6 pixels, two per terminal cell row: crest, face, belly, feet. The crest has two frames.
const MM_PIXELS = (frame: number): string[] => [
  frame % 2 ? 'a.b.c.d' : '.a.b.c.',
  '.ppppp.',
  'pwkpwkp',
  'pppdppp',
  'ooooooo',
  frame % 2 ? '..d.d..' : '.d...d.',
]
const MM_COLORS: Record<string, string> = {
  a: '#F23F5D', b: '#F96650', c: '#FF9A3C', d: MM.deep, p: MM.pink, w: '#FFFFFF', k: INK, o: MM.coral,
}

// Clawd for the terminal: 8×6 pixels, a hat in the tier's colour (none for plain subagents), legs that step.
const CRAB_PIXELS = (frame: number, hasHat: boolean): string[] => [
  hasHat ? '..tttt..' : '........',
  '.cccccc.',
  '.ckccck.',
  'cccccccc',
  '.cccccc.',
  frame % 2 ? 'c.c..c.c' : '.c.cc.c.',
]
const CRAB_COLORS: Record<string, string> = { c: CLAY, k: INK }


export function costumePixels(c: CostumeKey): Px[] {
  const px: Px[] = []
  COSTUMES[c]?.((x, y, w, h, col, cls = 'bd') => px.push({ x, y, w, h, c: col, cls }), colorOf(c))
  return px
}

// Body and props nest inside `bd` so a prop rides the bob; legs stay outside and step on their own.
export function spriteSvg(c: CostumeKey, running: boolean, scale = 1): string {
  const groups = new Map<string, string[]>([['bd', []]])
  for (const p of costumePixels(c)) {
    if (!groups.has(p.cls)) groups.set(p.cls, [])
    groups.get(p.cls)?.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="${p.c}"/>`)
  }
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  const size = 30 * scale
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${28 * scale}" viewBox="0 0 30 28">${CRAB_CSS}<g shape-rendering="crispEdges"><g class="c-${c}${running ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g></svg>`
}

export const TERM_PROP: Record<'heavy' | 'careful' | 'medium' | 'light' | 'explore' | 'fable', [string[], string[]]> = {
  heavy: [['kk', 'kg', '.b', '..', '..', '..'], ['..', 'kk', 'kg', '.b', '..', '..']],
  careful: [['..', '..', 's.', 'ss', '..', '..'], ['..', '.s', 'ss', '..', '..', '..']],
  medium: [['..', '..', 'ee', 'nn', '..', '..'], ['ee', '..', '..', 'nn', '..', '..']],
  light: [['wk', 'kw', 's.', 's.', '..', '..'], ['kw', 'wk', 's.', 's.', '..', '..']],
  explore: [['.s', '.s', '.s', 'b.', '..', '..'], ['..', 'ss', '.s', 'b.', '..', '..']],
  fable: [['y.', 'yy', '..', '..', '..', '..'], ['..', '..', '..', '..', '..', '..']],
}
// The crab's own `k` is its ink eye, so the prop's dark grey travels as `K` in the rows.
const PROP_COLORS: Record<string, string> = { K: '#3A3A3C', g: '#A9D6F5', b: '#7A4A26', s: '#C9CCD2', e: '#F5B731', n: '#4A4A48', w: '#F8F6F1', y: '#F5C542' }

export function termSprite(c: CostumeKey, frame: number): { rows: string[]; colors: Record<string, string> } {
  if (c === 'minimax') return { rows: MM_PIXELS(frame), colors: { ...MM_COLORS } }
  if (c === 'other') return { rows: CRAB_PIXELS(frame, false), colors: { ...CRAB_COLORS } }
  const body = CRAB_PIXELS(frame, c !== 'explore')
  const prop = TERM_PROP[c][frame % 2]
  const rows = body.map((r, i) => r + (prop[i] ?? '..').replace(/k/g, 'K'))
  const colors = { ...CRAB_COLORS, ...PROP_COLORS, ...(c === 'explore' ? {} : { t: colorOf(c) }) }
  return { rows, colors }
}
