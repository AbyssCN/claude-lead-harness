# judge() 的假数据测试:10-28 真实读数 + 几种该报 / 不该报的
import importlib.util, sys
spec = importlib.util.spec_from_file_location("check", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
A, B, C = "0af9d1b8", "18061c2f", "e5041fee"
cases = [
    ("10-28:同一会话换了 pane 号 → 不报", {"w0:p33": ("claude", A)}, {"w0:p33": ("claude", A)}, {"w0:p11": ("claude", A)}, []),
    ("真没续起来 → 报", {"wZ:p25": ("claude", B)}, {}, {}, ["没续起来"]),
    ("在跑但没有任何引用 → 报", {}, {}, {"wZ:pW": ("claude", C)}, ["没有会话引用"]),
    ("续上的是别的会话 → 报没续起来 + 无引用", {"w1:p1": ("claude", A)}, {"w1:p1": ("claude", A)}, {"w1:p1": ("claude", C)}, ["没续起来", "没有会话引用"]),
    ("新开的 pane 已有引用 → 不报", {}, {"w3:p1": ("claude", C)}, {"w3:p1": ("claude", C)}, []),
]
bad = 0
for name, exp, refs, live, want in cases:
    got = m.judge(exp, refs, live)
    ok = len(got) == len(want) and all(any(w in g for g in got) for w in want)
    print(("ok  " if ok else "BAD ") + name, "" if ok else got); bad |= not ok
sys.exit(bad)
