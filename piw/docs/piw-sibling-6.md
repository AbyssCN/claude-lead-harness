---
级别: L2
允许改动: bin/piw lib/piw.js test/piw-sibling.test.mjs
依赖: 无
---

# 额度自管 · 切片 6:piw 撞额度时立刻换同模型的兄弟坐标续跑(MiniMax 任务书 · 契约 docs/plan/11.01/quota-autopilot-contract.md D-8)

**执行仓 = /home/user/repos/piw**(不是 myapp)。任务书放在 myapp 仓 `docs/plan/11.02/briefs/` 只是登记处;起片时 `--repo /home/user/repos/piw`,下面所有路径都相对 piw 仓根。契约在 myapp 仓 `docs/plan/11.01/quota-autopilot-contract.md`,执行体在 piw 仓里读不到它——D-8 的全文已抄在「要做什么」里,不用去找。

**原始目标原文(owner 1.11,逐字)**:「第二个 MiniMax 套餐我来开。你把额度这件事做成机器自己管:……MiniMax 一个号没额度,工厂自动换到下一个号。我要的是到下周一,没有一次因为额度停工。」

**类:** G
**账:** 影响分 —(G 类:owner 点名的目标;今天 piw 撞 MiniMax 额度只会在原坐标上最多等 330 分钟,第二套餐开了也闲着)· 预估 1 片 · 复核 1 份(MiniMax + sol,sol 不可用由 Opus 顶)
**不做会怎样:** 开关打开后(条件见「零」),没有这一片的话 owner 开了第二个 MiniMax 套餐,撞额度的那片仍在原坐标上等最多 5.5 小时,另一个套餐的额度闲置;工厂因额度停下的片数没法降到 0(契约目标 3)。

**允许改动:** bin/piw lib/piw.js test/piw-sibling.test.mjs

`test/piw-sibling.test.mjs` 新建;`bin/piw` 与 `lib/piw.js` 已在仓里。除这三个文件外一字不动。

**阻塞于:** 无

不许改:`lib/cron-report.js`(piw 主 worktree 里它有别人未提交的改动,与本片无关,不要带进你的提交)· `ext/` · 其他 `test/` 文件 · 任何真实的 `~/.pi/` · `~/.config/piw/` · `~/.cache/piw/`(测试只用临时 HOME)。

## 本仓的约定(piw 仓没有 `docs/process/executor-brief.md`,以下就是规矩)

- 测试:`node --test test/piw-sibling.test.mjs`(新文件);回归:`node --test test/piw-ask-run.test.mjs test/piw-yield.test.mjs`。全量 `node --test test/` 约 200 条,已知有一条 `gc 按名字判活` 在 piw main 上同样红,与本片无关——你的改动不许让红的条数变多。README 第 244 行有测试命令原文。
- 测试先行:先写会失败的测试,看它红,再改代码;报告里贴「改之前失败的那句断言」。
- 只 `git add` 显式路径;不用 `git stash`;不加 `--no-verify`;不 push、不合并、不删分支;提交说明用中文、不带 `Co-Authored-By` 署名行,写「执行者:MiniMax」。
- 同一个问题试了 3 次还不过:停下报告,写清楚试过什么、卡在哪。
- 任务书与代码现状对不上的地方,先停下写出来,不要自己猜一个做下去。
- 报告用中文:提交 SHA 与文件清单 · 各条测试命令的读数 · 红 → 绿证据 · 与任务书不同的地方 · 拿不准的点(带 file:line)。

## 已就绪的事实(不用再查)

- `bin/piw` 约 440–495 行是 run 的主跑与额度处理:`runPi({ ..., model: o.model, cont: true })` 在原会话上用 `--continue` 续跑;`quota` 判为 `err` 匹配 `/\b(2056|429)\b/` 且 `qi < quotaBackoff.length`;第一次撞额度(`qi === 0`)用 `piw.setCooldown(o.model, …)` 写冷却;等待表默认 33 × 600 秒,测试里用环境变量 `PIW_QUOTA_BACKOFF` 覆盖;续跑目录叫 `quota-resume-<qi>`。
- `lib/piw.js`:`coordBase(c)` 去掉坐标末尾的 `:off|minimal|low|medium|high|xhigh|max`;`sameCoord(a, b)`;`isCooling(coord, env, now)`;`setCooldown(coord, text, cfg, env, now)`;`expandChain(role, cfg, { skip, env })` 返回 `{ chain, cooling, skipped, budget, full }`,`chain` 已剔除冷却中与 `skip` 里的坐标;导出表在文件末尾的 `module.exports`。
- `lib/yield.js` 按目录名正则 `^(fallback|resume-\d+|quota-resume-\d+)$` 数续跑目录的用量——所以**续跑目录名不许新增别的写法**,继续叫 `quota-resume-<序号>`。
- 测试世界:`test/piw-ask-run.test.mjs` 的 `world()` / `repoWorld()`(临时 HOME、`PIW_PI_BIN=test/fixtures/pi-stub.mjs` 替身)是现成的写法,照它写本片的世界。替身按 `--model` 里的子串查 `STUB_PLAN`(`"quota1"` = 同一坐标第一次调用报 2056、之后 ok;`"ok"`;`"2056"` = 一直报 2056),每次调用把 argv 追加进 `STUB_LOG`。坐标 `minimax-cp/…` 与 `minimax-cp2/…` 用子串 `minimax-cp/` 和 `minimax-cp2/` 区分(`minimax-cp/` 不是 `minimax-cp2/` 的子串)。临时 HOME 里要写角色表(照 `repoWorld` 现有写法给 `worker` 角色的 chain 里放两个兄弟坐标)和让两个供应商都能起的 models.json / 环境(照现有用例怎么给 `minimax-cp` 做的做)。

## 要做什么

D-8 要改的一处(**默认关的开关**,见「零」):开关打开时,撞额度时,若 chain 里有**同模型、不在冷却**的兄弟坐标,立刻在原会话、兄弟坐标上续跑,不等;没有兄弟才照旧等;开关关着(缺省)就是今天的行为。

### 零、开关:默认关(lead 1.11 裁定)

「撞额度后换到兄弟坐标续跑」是**默认关**的开关,关着时行为与今天逐字一致(仍在原坐标上按等待表等)。开关名与读取位置照 piw 现有配置的写法(`fallbackCap(cfg, env)` 那一套:环境变量 → 配置文件 → 默认):

- 配置文件 `~/.config/piw/config.json` 顶层布尔键 **`quotaSiblingSwitch`**(缺省 `false`);`loadConfig` 把它读进 `cfg.quotaSiblingSwitch`(缺省值加进 `DEFAULT_CONFIG`)。
- 环境变量 **`PIW_QUOTA_SIBLING`**:`"1"` 开、`"0"` 关,给了就优先于配置文件(与 `PIW_DAILY_FALLBACK_TOKEN_CAP` 同一优先级写法)。
- 导出 `siblingSwitchOn(cfg, env = process.env) → boolean`(加进 `module.exports`),`bin/piw` 的额度循环只通过它判开关。

打开的条件(**由 lead 在宿主做,执行体不做,也不去改任何真实配置**):chain 里确实有第二个坐标(契约切片 7 完成),并且实测换坐标后原会话上下文还在。

### 一、`lib/piw.js`:导出 `siblingCoord`

`siblingCoord(coord, candidates) → string | null`:`candidates` 是调用方给的、已剔除冷却中与 `skip` 里坐标的 chain(即 `expandChain(...).chain`)。返回其中第一个满足下面全部条件的坐标,没有返回 `null`:

1. 与 `coord` 的**供应商不同**(第一个 `/` 之前的部分不同);
2. 第一个 `/` 之后的部分**逐字相同**(模型 id 与 `:thinking` 后缀都相同,例如 `minimax-cp/MiniMax-M3.1-Flash:high` 与 `minimax-cp2/MiniMax-M3.1-Flash:high`;`:high` 对 `:xhigh` 不算兄弟);
3. 不是 `coord` 本身。

纯函数,不读文件、不碰环境。加进 `module.exports`。

### 二、`bin/piw`:额度循环里先找兄弟

在 run 的额度循环(`for (let ni = 0, qi = 0; ;)`)里,判到 `quota`(`err` 匹配 2056 / 429)之后、等待之前:

1. **只在 `siblingSwitchOn(cfg, process.env)` 为真且 `o.role` 有值时**才找兄弟(开关关着、或显式 `--model` 没有 chain,整段跳过,走原路径)。候选 = `piw.expandChain(o.role, cfg, { skip: o.skip_coord, env: process.env }).chain`,其中 `cfg = piw.loadConfig({ repo })`。候选里**有兄弟**时,先对刚撞额度的这个坐标写冷却(`piw.setCooldown(当前坐标, err, cfg, process.env)`),这样之后的候选里不会再有它,新起的片也会跳过它;**没有兄弟时不新增写冷却**,保持原来只在 `qi === 0` 写一次的行为(每次撞额度都写会把 `until` 越推越晚)。
2. 取 `piw.siblingCoord(当前坐标, 候选)`。有兄弟 → **不等**:把当前坐标换成兄弟(`o.model` 不要被覆盖成别的类型;循环里用一个变量 `cur` 记当前坐标,`runPi` 的 `model` 取 `cur`),立刻 `runPi({ …, model: 兄弟, arm: "primary", sessionDir, cont: true, task: "继续。上一轮因模型额度用完停下,已换到同模型的另一个套餐坐标,接着做完。" })`——**同一个 `sessionDir`、`--continue`**,原会话上下文不丢。不消耗额度等待表的一格(`qi` 不加)。
3. 续跑目录名继续用 `quota-resume-<序号>`;为避免与按等待表续跑重名,用单独计数 `qd`(已建的 `quota-resume-*` 目录数)命名:没有兄弟切换时 `qd` 与原来的 `qi` 取值相同,既有用例的目录名不变。
4. `meta.attempts` 加一项 `{ model: 兄弟, pi_exit, resumed_after: err 前 300 字, switched_from: 原坐标, waited_s: 0 }`;`meta` 再加数组 `sibling_switches: [{ from, to }]`(没发生过也不写这个键)。
5. 兄弟也撞额度 → 回到第 1 步(它被写冷却,再找下一个兄弟);没有兄弟了 → 才按原来的等待表在**当前坐标**上等(原逻辑)。
6. 循环结束后的失败分类:本次 run 里撞过额度的**每个**坐标都进 `failedCoords`(只在 run 最终失败时;最终成功时 `failedCoords` 仍为 `[]`,与现有用例一致)。
7. 其余分支(连接断开退避、fallback 臂、预算判断)不动。

### 三、开关关着、没有兄弟时行为不变

**开关关着**(缺省)、没有 `--role`、chain 里没有兄弟、兄弟全在冷却中:行为与改之前相同(调用序列、目录名、冷却写入次数都不变)——既有的 `test/piw-ask-run.test.mjs` 里 `run:主跑额度用完(2056)…` 与 `额度表用完仍 2056…` 两条必须原样通过(含目录名 `quota-resume-1`、`failedCoords`、`attempts` 形状)。

## 调用方

- `siblingCoord`:调用方只有 `bin/piw` 的 run 额度循环与 `test/piw-sibling.test.mjs`。
- 额度循环的其余读取方:`lib/yield.js`(按目录名数用量,目录名不变)· `lib/report.js` / `lib/events.mjs`(若读 `meta.attempts`,新增的 `switched_from` 是可选键)。先 `rg -n "attempts|failedCoords" lib bin` 确认,读到新键会出错的地方停下报告。

期望值:无(坐标串由测试输入钉死)。

对外签名:`siblingCoord(coord: string, candidates: string[]): string | null`。`meta.json` 新增可选键 `sibling_switches`,`attempts[]` 新增可选键 `switched_from`。

## 八问

不适用:内部工具,没有店主 / 员工 / 会计界面。

## 脏场景

| 类 | 场景 | 怎么扛 |
|---|---|---|
| 数据对不上 | 兄弟的 `:thinking` 后缀与当前坐标不同 | 不算兄弟(后缀逐字相同才算),按原逻辑等 |
| 数据对不上 | 角色表里同一个坐标出现两次 | 第 3 条「不是 coord 本身」排除;不会换给自己 |
| 并发 | 同一时刻多片撞同一个额度 | 第一片写冷却后,后面的片起片时已跳过它;已在跑的片各自撞到各自换兄弟,冷却文件写入沿用 `setCooldown` 现有的整份重写,不新增写法 |
| 部分失败 | 兄弟坐标起不来(没有密钥 / 供应商报鉴权错) | 按现有分类处理:非额度错误走原来的连接 / fallback 分支,不当额度再换;`failedCoords` 带上它 |
| 部分失败 | 兄弟一续跑就又是 2056 | 写它的冷却,找下一个兄弟;没有了才进等待表 |
| 跨边界 | 显式 `--model`、没有 `--role` | 不找兄弟,行为不变 |
| 跨边界 | 重派带 `--skip-coord` 排除了兄弟 | `expandChain` 的 `skip` 同样传入,兄弟不会被选 |
| 生命周期末端 | 兄弟的冷却到期 | 到期后它重新出现在候选里,新起的片会用它;已在等待表上的片不回头 |
| 量级膨胀 | chain 里有 3 个以上兄弟 | 顺序取第一个可用,每次撞额度写一个冷却,最多换到没有兄弟为止,不会死循环(每个坐标撞一次就进冷却) |

## 测试(先红后绿,每条写「在 main 上红」)

`node --test test/piw-sibling.test.mjs`(`node:test`;临时 HOME,替身 pi,不调任何模型):

0. `siblingSwitchOn`:缺省 `false`;配置 `quotaSiblingSwitch: true` → `true`;环境 `PIW_QUOTA_SIBLING=0` 压过配置的 `true`;`=1` 压过配置的 `false`。
1. `siblingCoord`:同后缀不同供应商 → 返回它;`:high` 对 `:xhigh` → `null`;候选里只有自己 → `null`;候选空 → `null`;多个兄弟取第一个。
2. run 端到端(**开关打开**:`PIW_QUOTA_SIBLING=1`):chain 为 `[minimax-cp/X:high, minimax-cp2/X:high, deepseek/…]`,`minimax-cp/` 报 `quota1`、`minimax-cp2/` 为 `ok`,`PIW_QUOTA_BACKOFF` 设成一个会让测试超时的大数(如 `"3600"`)→ run 在很短时间内成功,替身调用的 `--model` 依次是 `minimax-cp/…`、`minimax-cp2/…`(**没有等**),第二次调用带 `--continue` 且 `--session-dir` 与第一次相同,续跑任务说明含「额度」;目录 `quota-resume-1/pi.jsonl` 存在;`meta.attempts[1].switched_from === 'minimax-cp/…'`;`meta.sibling_switches` 一项;`failedCoords` 为 `[]`;`minimax-cp/` 已写进冷却文件。
3. 兄弟也撞额度(开关打开):两个都 `2056`、`PIW_QUOTA_BACKOFF=0,0` → 两个坐标都进冷却,调用序列是 `cp, cp2`,然后进等待表在 `cp2` 上续跑 2 次(`--continue`),最终按原路径换 deepseek,`failedCoords` 含 `cp` 与 `cp2`。
4. **开关关着**(缺省,不设 `PIW_QUOTA_SIBLING`)、chain 里有兄弟,`minimax-cp/` 报 `quota1`:调用序列只有 `minimax-cp/…`(第二次仍是 `minimax-cp/…` 的 `--continue`,等待表给 `0,0,0`)、目录 `quota-resume-1`、`attempts` 形状、冷却写入次数(只在第一次撞额度写一次)、`failedCoords`、没有 `sibling_switches` 键,与既有用例 `run:主跑额度用完(2056)…` 逐项相同——用这条证明「开关关着与今天逐字一致」。另一条:开关关着、两个坐标都报 `2056` 时与既有用例 `额度表用完仍 2056…` 相同。
4b. 开关打开、没有兄弟(chain 里只有 `minimax-cp/` 和 deepseek):与既有用例 `额度用完仍 2056` 逐项相同(调用序列、目录名、`failedCoords`)。
5. 显式 `--model minimax-cp/X:high`(没有 `--role`,开关打开)撞 `quota1`:不找兄弟,按等待表在原坐标续跑,与改之前相同。
6. 兄弟在冷却中(开关打开,先往冷却文件写 `minimax-cp2` 的未来 `until`):不换,按原逻辑等。
7. `--skip-coord minimax-cp2/X:high` 重派(开关打开):不换给它。

修前红:`siblingCoord` 在 main 上不存在,用例 2 在 main 上会等待表而不是换兄弟;贴出红的读数再写实现。

## 成功判据

- `node --test test/piw-sibling.test.mjs` 退 0,贴出通过条数;在 main 上红。
- `node --test test/piw-ask-run.test.mjs test/piw-yield.test.mjs` 与改之前同样通过(贴条数)。
- 全量 `node --test test/`:红的条数不多于改之前(已知红一条 gc);贴改之前与改之后的总数与红数。
- 开关关着时的用例(4)与既有 `piw-ask-run` 额度用例逐项一致,是「默认行为不变」的证据。
- `git diff main --stat` 只含「允许改动」里的三个文件。
- 钱: 无。不碰生产、不碰数据库、不碰密钥。

## 拿不准、写进报告的点

- `pi --continue` 加 `--model <另一个供应商的坐标>` 在真 pi 上是否保留会话上下文,只有替身测过,**没有真 pi 实测**(待 lead 在宿主第一次真撞额度时看 `quota-resume-1/pi.jsonl`)。
- `--skip-coord` 存在 `o.skip_coord`(`bin/piw` 第 89 行,第 167 行传给 `expandChain`);额度循环里照同样的写法传 `{ skip: o.skip_coord }`。

## 宿主步骤(lead 做,执行体不做)

合入 piw 后,切片 7:在 `~/.pi/agent/models.json` 加 `minimax-cp2`,在 `~/.config/piw/config.json` 每条含 `minimax-cp/…` 的 chain 紧跟加同后缀的 `minimax-cp2/…`;`piw --role worker --dry-run` 的 chain 行含 `minimax-cp2/…`。
