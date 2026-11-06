// 生成文件，别手改:python3 -I board/scripts/gen-pen.py —— docs/design/term/fixture/pen.json 原样。
export const PEN_FIXTURE: unknown = {
  "card": {
    "repo": "claude-mods",
    "pct": "68%",
    "live": "活 · 2s 前 · master 12cc7ee",
    "now": "现在在 §2 factory · 下一步:wt-reap 接 disk-watch",
    "bar": { "done": 31, "running": 9, "planned": 16 }
  },
  "who": {
    "title": "谁在跑 · 3",
    "source": "delegate + 子 agent",
    "helpers": [
      { "costume": "heavy", "name": "审 relay 切片 1", "meta": "heavy · 62k · 2m10s", "fill": 0.41, "tail": "ctx 41%" },
      { "costume": "medium", "name": "写 board 合并", "meta": "medium · 31k · 58s", "fill": 0.41, "tail": "ctx 41%" },
      { "costume": "minimax", "name": "mcode · 片 2", "meta": "MiniMax · 4m", "fill": 0.375, "tail": "3/8 轮" }
    ]
  },
  "plan": { "title": "任务条 · 本会话计划", "source": "", "fill": 0.4839, "line": "▶ 片 5(含 GWT-7 先红)· 3/6" },
  "blocks": [
    { "key": "下一步", "title": "下一步", "source": "_NEXT.md · 1h 前",
      "rows": [{ "bullet": "wt-reap 接 disk-watch" }, { "bullet": "vhdx 稀疏化停机前排雷" }, { "bullet": "relay 切片 1 收片" }] },
    { "key": "GOAL", "title": "GOAL · 17/25", "source": "GOAL.md · 3m 前",
      "rows": [
        { "bar": "§1 relay", "done": 25, "running": 6, "planned": 17 },
        { "bar": "§2 factory", "done": 18, "running": 9, "planned": 21 },
        { "bar": "§3 board", "done": 8, "running": 5, "planned": 35 }
      ] },
    { "key": "待拍板", "title": "待拍板 · 2", "source": "DECISIONS-PENDING.md",
      "rows": [{ "warn": "vhdx 停机授权谁来记" }, { "warn": "终端 reduced-motion 要不要做" }] },
    { "key": "TODO", "title": "TODO · 11 未勾", "source": "TODO.md",
      "rows": [{ "left": "§ relay", "right": "4 未勾" }, { "left": "§ factory", "right": "5 未勾" }, { "left": "§ 杂项", "right": "2 未勾" }] },
    { "key": "ROADMAP", "title": "ROADMAP · 进行 2 · 排 3 · 待 1", "source": "ROADMAP.md",
      "rows": [{ "run": "孤儿 GOAL 复活" }, { "run": "board 合并" }, { "alert": "Blocked:WSL 稀疏 VHD" }] },
    { "key": "最近提交", "title": "最近提交 · 5", "source": "git log",
      "rows": [{ "text": "adbb633 merge: board 切片 s4" }, { "text": "04a0ecb docs(board): 合并契约" }, { "text": "12cc7ee docs: vhdx 排雷" }] },
    { "key": "今日用量", "title": "今日用量 · 42.1M / 300M", "source": "usage",
      "rows": [{ "left": "MiniMax-M2", "right": "31.0M" }, { "left": "deepseek", "right": "8.4M" }, { "left": "sol", "right": "2.7M" }] }
  ],
  "hud": {
    "model": "Opus 5.5", "effort": "low",
    "repo": "claude-mods", "branch": "master", "dirty": true, "ahead": 417,
    "ctx": 24, "fiveH": { "pct": 44, "reset": "59m" }, "week": 30, "remote": true,
    "task": { "done": 3, "n": 6, "text": "GWT-7 先红" },
    "dots": ["heavy", "medium", "minimax"],
    "cacheMin": 58
  }
}
// docs/design/term/fixture/longest.json 原样：第 2 行取最长前缀与最长 ◷ 段，"line2" 是 board 该画的整行(≤ 98 格)。
// tools/screenshot/tui-judge.py --palette:闸认得的 D 第 2 行颜色(提案 2 的块色 + 豁免放行色,取自 docs/design/term/base/D.html)。
export const PEN_D_ROW2_COLORS: string[] = ["#0c0c0c", "#1d9e75", "#1f1e1d", "#22c55e", "#2a2640", "#378add", "#3a3a3c", "#3f3f46", "#7a4a26", "#7f77dd", "#8b5cf6", "#ba7517", "#c4b5fd", "#c9ccd2", "#d4537e", "#d85a30", "#d97757", "#ece9fb", "#f23f5d", "#f5b731", "#f5c542", "#f8f6f1", "#ff6b4a", "#ff9a3c", "#ffffff"]
export const PEN_LONGEST: unknown = {
 "card": {
  "repo": "claude-mods",
  "pct": "68%",
  "live": "活 · 2s 前 · master 12cc7ee · 预设 board.json",
  "now": "现在在 §2 factory · 下一步:wt-reap 接 disk-watch",
  "bar": {
   "done": 31,
   "running": 9,
   "planned": 16
  }
 },
 "who": {
  "title": "谁在跑 · 3",
  "source": "delegate + 子 agent",
  "helpers": [
   {
    "costume": "heavy",
    "name": "审 relay 切片 1",
    "meta": "3/7 · 62k · 2m10s"
   },
   {
    "costume": "medium",
    "name": "写 board 合并",
    "meta": "5/6 · 31k · 58s"
   },
   {
    "costume": "minimax",
    "name": "mcode · 片 2",
    "meta": "3/8 轮 · gate:test · 4m"
   }
  ]
 },
 "plan": {
  "title": "任务条 · 本会话计划",
  "source": "",
  "fill": 0.4839,
  "line": "▶ 片 5(含 GWT-7 先红)· 3/6"
 },
 "blocks": [
  {
   "key": "下一步",
   "title": "下一步",
   "source": "_NEXT.md · 1h 前",
   "rows": [
    {
     "bullet": "wt-reap 接 disk-watch"
    },
    {
     "bullet": "vhdx 稀疏化停机前排雷"
    },
    {
     "bullet": "relay 切片 1 收片"
    }
   ]
  },
  {
   "key": "GOAL",
   "title": "GOAL · 17/25",
   "source": "docs/plan/0.9/GOAL.md · 3m 前",
   "rows": [
    {
     "bar": "§1 relay",
     "done": 25,
     "running": 6,
     "planned": 17
    },
    {
     "bar": "§2 factory",
     "done": 18,
     "running": 9,
     "planned": 21
    },
    {
     "bar": "§3 board",
     "done": 8,
     "running": 5,
     "planned": 35
    }
   ]
  },
  {
   "key": "待拍板",
   "title": "待拍板 · 2",
   "source": "DECISIONS-PENDING.md",
   "rows": [
    {
     "warn": "vhdx 停机授权谁来记"
    },
    {
     "warn": "终端 reduced-motion 要不要做"
    }
   ]
  },
  {
   "key": "TODO",
   "title": "TODO · 11 未勾",
   "source": "docs/plan/TODO.md",
   "rows": [
    {
     "left": "§ relay",
     "right": "4 未勾"
    },
    {
     "left": "§ factory",
     "right": "5 未勾"
    },
    {
     "left": "§ 杂项",
     "right": "2 未勾"
    }
   ]
  },
  {
   "key": "ROADMAP",
   "title": "ROADMAP · 在进行 2 · 已排 3 · 待 owner 1",
   "source": "docs/ROADMAP.md",
   "rows": [
    {
     "run": "孤儿 GOAL 复活"
    },
    {
     "run": "board 合并"
    },
    {
     "alert": "Blocked:WSL 稀疏 VHD"
    }
   ]
  },
  {
   "key": "最近提交",
   "title": "最近提交 · 5",
   "source": "git log",
   "rows": [
    {
     "text": "adbb633 merge: board 切片 s4"
    },
    {
     "text": "04a0ecb docs(board): 合并契约"
    },
    {
     "text": "12cc7ee docs: vhdx 排雷"
    }
   ]
  },
  {
   "key": "今日用量",
   "title": "今日用量 · 42.1M / 300M",
   "source": "~/.omd-lite/usage/<日期>.jsonl",
   "rows": [
    {
     "left": "MiniMax-M2",
     "right": "31.0M"
    },
    {
     "left": "deepseek",
     "right": "8.4M"
    },
    {
     "left": "sol",
     "right": "2.7M"
    }
   ]
  }
 ],
 "hud": {
  "model": "Opus 5.5",
  "effort": "low",
  "repo": "claude-mods",
  "branch": "master",
  "dirty": true,
  "ahead": 417,
  "ctx": 24,
  "fiveH": {
   "pct": 44,
   "reset": "59m"
  },
  "week": 30,
  "remote": true,
  "task": {
   "done": 100,
   "n": 100,
   "text": "relay-coldhandoff-flush-start-and-wait"
  },
  "dots": [
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax",
   "heavy",
   "medium",
   "minimax"
  ],
  "cacheMin": 58,
  "cache": {
   "state": "warming",
   "leftMs": 28800000,
   "windowMs": 28800000,
   "pings": 30,
   "maxPings": 30,
   "usd": 99.99
  }
 },
 "line2": " ▶ 任务 ▆▆▆▆▆▆▆▆ 99+/99+ relay-coldha… │ 🬫🬵🬹🬗🬂 🬫🬹🬹🬗🬋 🬋🬊🬌🬰🬹 99+ 在跑 │ ◷ 保温 ▆▆▆▆ 8h00m  停 "
}
