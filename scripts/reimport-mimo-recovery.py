"""从恢复 md 重新完整导入 MiMo，并生成边界 fork。"""
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
        content = "\n".join(body).strip()
        if content:
            msgs.append({"role": role, "ts": ts, "text": content})
    return msgs


def to_ms(ts: str) -> int:
    return int(datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").timestamp() * 1000)


def ulid_msg(ts: int, n: int, salt: str = "s") -> str:
    # salt 防止 fork/源会话 ID 冲突（PRIMARY KEY 会互相覆盖）
    tail = f"{(ts + n * 9973 + (abs(hash(salt)) % 100000)) % (36 ** 10):010x}"
    return f"msg_g001{ts:012x}"[-12:] + f"{n:04x}" + tail


def ulid_prt(ts: int, n: int, salt: str = "s") -> str:
    tail = f"{(n * 7919 + (abs(hash(salt)) % 100000)) % (36 ** 8):08x}"
    return f"prt_g001{ts:012x}"[-12:] + f"{n:04x}" + tail


def insert_session(conn, sid, title, parent_id, t0, t1, project=REAL_PROJECT):
    conn.execute(
        "INSERT OR REPLACE INTO session "
        "(id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, title_source) "
        "VALUES (?, ?, ?, ?, ?, ?, 'desktop-1579e7d', ?, ?, 'user')",
        (sid, project, parent_id, "recovery-voice", CWD, title, t0, t1),
    )


def insert_chain(conn, sid, msgs_slice, ts_list, salt="s"):
    last = None
    n = 0
    for i, m in enumerate(msgs_slice):
        ts = ts_list[i]
        mid = ulid_msg(ts, i + 1, salt)
        data = {
            "role": m["role"],
            "time": {"created": ts},
            "agent": "build",
            "model": {"providerID": "xiaomi", "modelID": "mimo-x-pro-preview"},
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
        pd = {"type": "text", "text": m["text"], "synthetic": False}
        conn.execute(
            "INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (pid, mid, sid, ts, ts, json.dumps(pd, ensure_ascii=False)),
        )
        conn.execute(
            "INSERT OR REPLACE INTO history_fts (part_id, session_id, message_id, project_id, tool_name, body, time_created) "
            "VALUES (?, ?, ?, ?, NULL, ?, ?)",
            (pid, sid, mid, REAL_PROJECT, m["text"], ts),
        )
        last = mid
        n += 1
    return n


def main():
    msgs = parse_messages(MD.read_text(encoding="utf-8"))
    print("parsed", len(msgs), "messages")
    ts_list = [to_ms(m["ts"]) for m in msgs]

    # 边界：含 结论: 模型放 的 assistant
    bidx = None
    for i, m in enumerate(msgs):
        if BOUNDARY in m["text"] or "模型放 /gemini" in m["text"]:
            bidx = i
            print("boundary", i, m["role"], m["text"][:60].replace("\n", " "))
            break
    if bidx is None:
        bidx = len(msgs) // 2
        print("fallback boundary", bidx)

    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    conn.execute("BEGIN")
    # 清旧
    for sid in (SRC,):
        conn.execute("DELETE FROM part WHERE session_id=?", (sid,))
        conn.execute("DELETE FROM message WHERE session_id=?", (sid,))
        conn.execute("DELETE FROM history_fts WHERE session_id=?", (sid,))
        conn.execute("DELETE FROM session WHERE id=?", (sid,))
    # 清空我们的 fork
    for r in conn.execute(
        "SELECT id FROM session WHERE title LIKE '语音电子音乐模型（恢复会话） (fork%'"
    ):
        conn.execute("DELETE FROM part WHERE session_id=?", (r["id"],))
        conn.execute("DELETE FROM message WHERE session_id=?", (r["id"],))
        conn.execute("DELETE FROM history_fts WHERE session_id=?", (r["id"],))
        conn.execute("DELETE FROM session WHERE id=?", (r["id"],))

    insert_session(conn, SRC, TITLE, None, ts_list[0], ts_list[-1])
    n1 = insert_chain(conn, SRC, msgs, ts_list, salt="src")
    print("src written", n1)

    fork_sid = "ses_" + uuid.uuid4().hex[:20].upper()
    insert_session(
        conn,
        fork_sid,
        TITLE + " (fork #1)",
        SRC,
        ts_list[0],
        ts_list[bidx],
    )
    n2 = insert_chain(
        conn, fork_sid, msgs[: bidx + 1], ts_list[: bidx + 1], salt="fork1"
    )
    print("fork written", n2, "sid", fork_sid)

    conn.execute("COMMIT")
    conn.close()
    print("done")


if __name__ == "__main__":
    main()
