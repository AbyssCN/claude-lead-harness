# 生成两个常量文件(别手改):
#   board/hooks/pen-sprites.ts:谁在跑的 7×8 精灵像素表(契约 D-7);
#   board/hooks/pen-fixture.ts:docs/design/term/fixture/pen.json 与 longest.json 原样包成模块，给测试用(测试不能读插件目录外的文件)。
# 采样规则不另写：直接执行 docs/design/term/tui.py 里画侧栏之前的那段(T 色板、_rects、sprite_px),
# 像素来自 docs/design/term/base/E1.html(Pencil 从 board-unified.pen 导出)。
# 用法：python3 -I board/scripts/pen-sprites.py > board/hooks/pen-sprites.ts
import os, sys, json, subprocess
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
path = os.path.join(root, 'docs', 'design', 'term', 'tui.py')
src = open(path, encoding='utf-8').read()
src = src[:src.index('# ── 顶部卡片')]
g = {'__file__': path, '__name__': 'tui'}
exec(compile(src, path, 'exec'), g)
# 侧栏示例只画了 heavy / medium / MiniMax;其余 5 种在 .pen 的「侧栏小人表」(base/E1-sprites.html),同一取样。
g['_E1'] += open(os.path.join(root, 'docs', 'design', 'term', 'base', 'E1-sprites.html'), encoding='utf-8').read()
out = {}
for kind in ('heavy', 'medium', 'minimax'):
    out[kind] = [[c for c in row] for row in g['sprite_px']('sp ' + kind, g['T']['helper'])]
# 小人表里的 5 种按 heavy 的取样框取(同一造型坐标系):sprite_px 默认裁到像素实际范围，没帽子的造型框矮，身子会被撑满、裁掉。
_hr = g['_rects']('sp heavy')
_box = [(min(r[0] for r in _hr), min(r[1] for r in _hr), .01, .01, '#00000000'), (max(r[0] + r[2] for r in _hr) - .01, max(r[1] + r[3] for r in _hr) - .01, .01, .01, '#00000000')]
_orig = g['_rects']
for kind in ('fable', 'careful', 'light', 'explore', 'other'):
    g['_rects'] = lambda name, k=kind: _orig('sp ' + k) + _box
    out[kind] = [[c for c in row] for row in g['sprite_px']('sp ' + kind, g['T']['helper'])]
g['_rects'] = _orig
lines = ['// 生成文件，别手改:python3 -I board/scripts/gen-pen.py',
'// 7×8 像素(null = 透明),来自 board-unified.pen 的 sp heavy / medium / minimax(E1)与侧栏小人表里的其余 5 种(E1-sprites),采样同 docs/design/term/tui.py sprite_px。',
'export const PEN_SPRITES: Record<string, ReadonlyArray<ReadonlyArray<string | null>>> = ' + json.dumps(out, separators=(',', ':'))]
hooks = os.path.join(root, 'board', 'hooks')
open(os.path.join(hooks, 'pen-sprites.ts'), 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
fx = open(os.path.join(root, 'docs', 'design', 'term', 'fixture', 'pen.json'), encoding='utf-8').read()
json.loads(fx)
open(os.path.join(hooks, 'pen-fixture.ts'), 'w', encoding='utf-8').write(
    '// 生成文件，别手改:python3 -I board/scripts/gen-pen.py —— docs/design/term/fixture/pen.json 原样。\n'
    'export const PEN_FIXTURE: unknown = ' + fx.rstrip() + '\n'
    + '// docs/design/term/fixture/longest.json 原样：第 2 行取最长前缀与最长 ◷ 段，"line2" 是 board 该画的整行(≤ 98 格)。\n'
    + '// tools/screenshot/tui-judge.py --palette:闸认得的 D 第 2 行颜色(提案 2 的块色 + 豁免放行色,取自 docs/design/term/base/D.html)。\n'
    + 'export const PEN_D_ROW2_COLORS: string[] = ' + subprocess.run([sys.executable, '-I', os.path.join(root, 'tools', 'screenshot', 'tui-judge.py'), '--palette'], cwd=root, capture_output=True, text=True, check=True).stdout.strip() + '\n'
    + 'export const PEN_LONGEST: unknown = ' + open(os.path.join(root, 'docs', 'design', 'term', 'fixture', 'longest.json'), encoding='utf-8').read().rstrip() + '\n')
