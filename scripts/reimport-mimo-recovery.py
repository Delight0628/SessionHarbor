"""
从恢复 md 清洗后重导 MiMo：
- 去掉 <details> 推理摘要、MCP/命令块，只保留用户/助手正文
- 标注来源 codex
- 重建源会话 + 边界 fork（ID 带 salt 防覆盖）
"""
import json
import re
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

MD = Path(r"D:\SessionHarbor\恢复会话_01a0a096_语音电子音乐模型.md")
DB = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
SRC = "ses_469F438DD75A4346ADE5"
REAL_PROJECT = "ff33a399-6940-422c-8466-99e667ac8f43"
CWD = "D:\\butheisDelight"
TITLE = "语音电子音乐模型（恢复会话）"
BOUNDARY = "结论: 模型放"

header_re = re.compile(
    r"^##\s+(👤\s*用户|🤖\s*助手)\s*·\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*$"
)
# 块级噪音标题
noise_h = re.compile(
    r"^###\s+(🔧\s*MCP|⚙️\s*命令|💭|推理摘要).*$"
)


def strip_noise(text: str) -> str:
    # 1) 去掉 details/summary
    text = re.sub(r"<details>[\s\S]*?</details>", "", text, flags=re.I)
    text = re.sub(r"</?details[^>]*>", "", text, flags=re.I)
    text = re.sub(r"</?summary[^>]*>.*", "", text, flags=re.I)

    # 2) 去掉 fenced code 里的 MCP/命令整段（``` 包裹）
    text = re.sub(r"```[\s\S]*?```", "", text)

    # 3) 去掉内联 JSON 工具调用块
    text = re.sub(r"\{\s*\"type\":\s*\"mcpToolCall\"[\s\S]*?\n\}", "", text)
    text = re.sub(r"\{\s*\"type\":\s*\"[^\"]+\"[\s\S]*?\}\s*$", "", text, flags=re.M)

    # 4) 去掉工具/命令小节
    lines = text.splitlines()
    out = []
    skip = False
    for ln in lines:
        s = ln.strip()
        if (
            noise_h.match(ln)
            or s.startswith("### 🔧")
            or s.startswith("### ⚙️")
            or s.startswith("### 💭")
            or "mcpToolCall" in ln
            or "codex-runtimes" in ln
            or "powershell" in s.lower() and "curl" in s.lower()
        ):
            skip = True
            continue
        if skip:
            if ln.startswith("## ") or (
                ln.startswith("### ")
                and not s.startswith("### 🔧")
                and not s.startswith("### ⚙️")
                and not s.startswith("### 💭")
            ):
                skip = False
            else:
                continue
        out.append(ln)

    cleaned = "\n".join(out).strip()
    # 5) 去掉残留的空 JSON/命令行
    cleaned = re.sub(r'(?m)^\s*[\{\}\[\]]\s*$', "", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def parse_messages(text: str):
    lines = text.splitlines()
    msgs = []
    i = 0
    while i < len(lines):
        m = header_re.match(lines[i])
        if not m:
            i += 1
            continue
        role = "user" if "用户" in m.group(1) else "assistant"
        ts = m.group(2)
        i += 1
        body = []
        while i < len(lines) and not header_re.match(lines[i]):
            body.append(lines[i])
            i += 1
        content = strip_noise("\n".join(body))
        if content.strip():
            msgs.append({"role": role, "ts": ts, "text": content.strip()})
    return msgs


def to_ms(ts: str) -> int:
    return int(datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").timestamp() * 1000)


def ulid_msg(ts: int, n: int, salt: str) -> str:
    tail = f"{(ts + n * 9973 + (abs(hash(salt)) % 100000)) % (36 ** 10):010x}"
    return f"msg_g001{ts:012x}"[-12:] + f"{n:04x}" + tail


def ulid_prt(ts: int, n: int, salt: str) -> str:
    tail = f"{(n * 7919 + (abs(hash(salt)) % 100000)) % (36 ** 8):08x}"
    return f"prt_g001{ts:012x}"[-12:] + f"{n:04x}" + tail


def insert_session(conn, sid, title, parent_id, t0, t1):
    conn.execute(
        "INSERT OR REPLACE INTO session "
        "(id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, title_source) "
        "VALUES (?, ?, ?, ?, ?, ?, 'desktop-1579e7d', ?, ?, 'user')",
        (sid, REAL_PROJECT, parent_id, "recovery-voice", CWD, title, t0, t1),
    )


def insert_chain(conn, sid, msgs, ts_list, salt):
    last = None
    for i, m in enumerate(msgs):
        ts = ts_list[i]
        mid = ulid_msg(ts, i + 1, salt)
        data = {
            "role": m["role"],
            "time": {"created": ts},
            "agent": "build",
            "model": {"providerID": "xiaomi", "modelID": "mimo-x-pro-preview"},
            "sessionHarborSource": "codex",
        }
        if last:
            data["parentID"] = last
        if m["role"] == "user":
            data["system"] = "You are MiMo agent, built on MiMo's Desktop."
        conn.execute(
            "INSERT OR REPLACE INTO message (id, session_id, agent_id, time_created, time_updated, data) "
            "VALUES (?, ?, 'main', ?, ?, ?)",
            (mid, sid, ts, ts, json.dumps(data, ensure_ascii=False)),
        )
        pid = ulid_prt(ts, i + 1, salt)
        conn.execute(
            "INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                pid,
                mid,
                sid,
                ts,
                ts,
                json.dumps(
                    {"type": "text", "text": m["text"], "synthetic": False},
                    ensure_ascii=False,
                ),
            ),
        )
        conn.execute(
            "INSERT OR REPLACE INTO history_fts (part_id, session_id, message_id, project_id, tool_name, body, time_created) "
            "VALUES (?, ?, ?, ?, NULL, ?, ?)",
            (pid, sid, mid, REAL_PROJECT, m["text"], ts),
        )
        last = mid


def main():
    msgs = parse_messages(MD.read_text(encoding="utf-8"))
    print("parsed", len(msgs), "clean messages")
    for i, m in enumerate(msgs[:3]):
        print(i, m["role"], m["text"][:70].replace("\n", " / "))
    ts_list = [to_ms(m["ts"]) for m in msgs]

    bidx = None
    for i, m in enumerate(msgs):
        t = m["text"]
        if (
            "把模型放" in t
            or "结论: 模型放" in t
            or "结论：模型放" in t
            or ("模型放" in t and "gemini" in t.lower())
        ):
            bidx = i
            print("boundary", i, t[:80].replace("\n", " "))
            break
    if bidx is None:
        for i, m in enumerate(msgs):
            if "最适合" in m["text"] and "gemini" in m["text"]:
                bidx = i
                print("boundary via 最适合", i)
                break
    if bidx is None:
        bidx = max(0, int(len(msgs) * 0.55))
        print("fallback boundary", bidx)

    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    conn.execute("BEGIN")
    for sid in (SRC,):
        conn.execute("DELETE FROM part WHERE session_id=?", (sid,))
        conn.execute("DELETE FROM message WHERE session_id=?", (sid,))
        conn.execute("DELETE FROM history_fts WHERE session_id=?", (sid,))
        conn.execute("DELETE FROM session WHERE id=?", (sid,))
    for r in conn.execute(
        "SELECT id FROM session WHERE title LIKE '语音电子音乐模型（恢复会话） (fork%'"
    ):
        conn.execute("DELETE FROM part WHERE session_id=?", (r["id"],))
        conn.execute("DELETE FROM message WHERE session_id=?", (r["id"],))
        conn.execute("DELETE FROM history_fts WHERE session_id=?", (r["id"],))
        conn.execute("DELETE FROM session WHERE id=?", (r["id"],))

    insert_session(conn, SRC, TITLE, None, ts_list[0], ts_list[-1])
    insert_chain(conn, SRC, msgs, ts_list, "src")
    fork_sid = "ses_" + uuid.uuid4().hex[:20].upper()
    insert_session(
        conn, fork_sid, TITLE + " (fork #1)", SRC, ts_list[0], ts_list[bidx]
    )
    insert_chain(conn, fork_sid, msgs[: bidx + 1], ts_list[: bidx + 1], "fork")
    conn.execute("COMMIT")
    conn.close()
    print("src", SRC, len(msgs), "fork", fork_sid, bidx + 1)


if __name__ == "__main__":
    main()
