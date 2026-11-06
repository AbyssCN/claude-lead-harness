# herdr 启动后核对：每个 agent pane 续回的会话，是不是 herdr 记的那个、是不是最新的那个。
# 由 herdr-plugin.toml 的 [[startup]] 起;server 恢复完会话就跑，agent 要等客户端 attach 后才续起，所以这里轮询等。
# 结论一行：写日志 + herdr 通知;有对不上的再推手机。
import datetime as dt
import glob
import json
import os
import re
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
SOCK = os.environ.get("HERDR_SOCKET_PATH", "")
HERDR = os.environ.get("HERDR_BIN_PATH", "herdr")
SESSION_JSON = os.path.join(os.path.dirname(SOCK), "session.json")
STATE = os.environ.get("HERDR_PLUGIN_STATE_DIR") or os.path.join(HOME, ".local/state/herdr-resume-check")
LOG = os.path.join(HOME, ".local/state/herdr-resume-check.log")
DEADLINE_S = int(os.environ.get("RESUME_CHECK_DEADLINE_S", "270"))
POLL_S = 3


def refs():
    """herdr 记的会话引用:{公开 pane id: (agent, value)}"""
    try:
        s = json.load(open(SESSION_JSON))
    except Exception:
        return {}
    out = {}
    for w in s.get("workspaces", []):
        pub = w.get("public_pane_numbers", {})
        for t in w.get("tabs", []):
            for k, v in t.get("panes", {}).items():
                a = v.get("agent_session")
                if a:
                    out[f'{w["id"]}:p{pub.get(k, k)}'] = (a.get("agent"), a.get("value"))
    return out


def environ(pid):
    try:
        raw = open(f"/proc/{pid}/environ", "rb").read().decode(errors="ignore")
    except Exception:
        return {}
    return dict(x.split("=", 1) for x in raw.split("\0") if "=" in x)


def pi_session(pane):
    # pi 改写了自己的 argv、也不常开着 session 文件;真实会话读它 HUD 上自己报的那行「resume: pi --session <id>」
    r = subprocess.run([HERDR, "pane", "read", pane], capture_output=True, text=True)
    m = re.findall(r"pi --session (\S+)", r.stdout)
    return m[-1] if m else None


def live():
    """本 server 里在跑的 agent:{公开 pane id: (agent, 真实会话)}"""
    out = {}
    for f in glob.glob("/proc/[0-9]*/comm"):
        pid = f.split("/")[2]
        try:
            comm = open(f).read().strip()
        except Exception:
            continue
        if comm not in ("claude", "pi"):
            continue
        env = environ(pid)
        pane = env.get("HERDR_PANE_ID")
        if not pane or env.get("HERDR_SOCKET_PATH") != SOCK:
            continue
        if comm == "claude":
            try:
                sid = json.load(open(f"{HOME}/.claude/sessions/{pid}.json"))["sessionId"]
            except Exception:
                sid = None
            out[pane] = ("claude", sid)
        else:
            out[pane] = ("pi", pi_session(pane))
    return out


def relay_successor(sid):
    """relay 交接后的新会话:第一条消息点名 handoffs/<repo>-<sid 前 8 位>.md"""
    tag = f"-{sid[:8]}.md"
    for f in glob.glob(f"{HOME}/.claude/projects/*/{sid}.jsonl"):
        for g in glob.glob(os.path.join(os.path.dirname(f), "*.jsonl")):
            if g == f or os.path.getmtime(g) < os.path.getmtime(f) - 60:
                continue
            try:
                with open(g, errors="ignore") as h:
                    for _, line in zip(range(40), h):
                        if "[relay]" in line and tag in line:
                            return os.path.basename(g)[:-6]
            except Exception:
                pass
    return None


def same(agent, ref, real):
    if agent == "pi" and ref and real:
        return real in os.path.basename(ref)
    return ref == real


def judge(expected, now_refs, now_live, successor=lambda sid: None):
    """按会话 id 对,不按 pane id:server 久了公开编号(session.json)与进程里的 HERDR_PANE_ID 会分叉,
    10-28 那次 w0:p33 记的会话在 w0:p11 里续上了,按 pane 对报成「没续起来」(假 MISMATCH)。"""
    bad = []
    live_by = {}
    for pane, (agent, real) in now_live.items():
        live_by.setdefault(agent, []).append((pane, real))
    claimed = set()
    for pane, (agent, ref) in sorted(expected.items()):
        hit = next((p for p, real in live_by.get(agent, []) if same(agent, ref, real)), None)
        if hit is None:
            bad.append(f"{pane} 没续起来 herdr={ref}")
            continue
        claimed.add(hit)
        if agent == "claude" and (succ := successor(ref)):
            bad.append(f"{pane} 续的是交接前的 {ref},relay 已接到 {succ}")
    known = {v for v in list(now_refs.values()) + list(expected.values())}
    for pane, (agent, real) in sorted(now_live.items()):
        if pane in claimed or any(a == agent and same(agent, r, real) for a, r in known):
            continue
        bad.append(f"{pane} {agent} 在跑但 herdr 没有会话引用 真实={real}")
    return bad


def verdict(expected):
    now_live = live()
    return judge(expected, refs(), now_live, relay_successor), now_live


def push(text):
    # Optional: RESUME_CHECK_NOTIFY is a command that receives the message as its last argument (ntfy, Telegram, ...).
    cmd = os.environ.get("RESUME_CHECK_NOTIFY", "")
    if not cmd:
        return "push skipped (RESUME_CHECK_NOTIFY not set)"
    try:
        r = subprocess.run([*cmd.split(), text], capture_output=True, text=True, timeout=120)
        return f"push rc={r.returncode}"
    except Exception as e:
        return f"push failed {e}"


def main():
    started = time.time()
    expected = {p: v for p, v in refs().items() if v[0] in ("claude", "pi")}
    session = os.path.basename(os.path.dirname(SOCK)) if "/sessions/" in SOCK else "default"
    stable = 0
    bad, now_live = verdict(expected)
    while time.time() - started < DEADLINE_S:
        time.sleep(POLL_S)
        bad, now_live = verdict(expected)
        # 预期的 pane 全都续起来、都读得到真实会话、连着两轮才收。
        # claude 刚起来时 ~/.claude/sessions/<pid>.json 还没写，只看进程在不在会报「真实=None」的误报
        if not any("没续起来" in b for b in bad) and all(r for _, r in now_live.values()):
            stable += 1
            if stable >= 2:
                break
        else:
            stable = 0
    stamp = dt.datetime.now().strftime("%m-%d %H:%M:%S")
    took = int(time.time() - started)
    if not bad:
        line = f"{stamp} [{session}] resume-check ALL MATCH {len(expected)} 个 agent pane ({took}s)"
    else:
        line = f"{stamp} [{session}] resume-check MISMATCH {len(bad)}/{len(expected)}: " + " | ".join(bad) + f" ({took}s)"
    with open(LOG, "a") as f:
        f.write(line + "\n")
    subprocess.run([HERDR, "notification", "show", "resume-check", "--body", line], capture_output=True)
    if bad:
        res = push(line)
        with open(LOG, "a") as f:
            f.write(f"{stamp} [{session}] {res}\n")
    print(line)


if __name__ == "__main__":
    sys.exit(main())
