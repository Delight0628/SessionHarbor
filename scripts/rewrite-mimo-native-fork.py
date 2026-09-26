"""
把导入会话改写成 MiMo 原生消息格式，并在指定边界做真 fork。
原生 ID 形如 msg_g001a09f5b1f74001LHSKYDej0
"""
import json
import re
import sqlite3
import time
from pathlib import Path

DB = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
SRC = "ses_469F438DD75A4346ADE5"
REAL_PROJECT = "ff33a399-6940-422c-8466-99e667ac8f43"
CWD = "D:\\butheisDelight"
# 边界：包含「结论: 模型放 /gemini/code/models」的那条 assistant
BOUNDARY_SNIPPET = "结论: 模型放 /gemini/code/models"


def ulid_msg(ts_ms: int, n: int) -> str:
    # msg_g001 + 12hex + 4hex + 10alnum
    h = f"{ts_ms:012x}"[-12:]
    mid = f"{n:04x}"
    tail = f"{(ts_ms * 31 + n * 17) % (36 ** 10):010x}"[-10:]
    return f"msg_g001{h}{mid}{tail}"


def ulid_prt(ts_ms: int, n: int) -> str:
    h = f"{ts_ms:012x}"[-12:]
    return f"prt_g001{h}{n:04x}{(n * 7919) % (36 ** 8):08x}"


def load_chain(conn, sid):
    msgs = list(
        conn.execute(
            "SELECT id, data, time_created, time_updated FROM message WHERE session_id=? "
            "ORDER BY time_created, id",
            (sid,),
        )
    )
    parts = {}
    for p in conn.execute(
        "SELECT message_id, data, time_created, time_updated FROM part WHERE session_id=? "
        "ORDER BY time_created, id",
        (sid,),
    ):
        parts.setdefault(p["message_id"], []).append(p)
    return msgs, parts


def rewrite_session(conn, sid, project_id, title=None):
    msgs, parts = load_chain(conn, sid)
    print(f"rewrite {sid}: {len(msgs)} msgs")
    idmap = {}
    conn.execute("DELETE FROM part WHERE session_id=?", (sid,))
    conn.execute("DELETE FROM message WHERE session_id=?", (sid,))
    conn.execute("DELETE FROM history_fts WHERE session_id=?", (sid,))

    last = None
    for i, m in enumerate(msgs):
        old = json.loads(m["data"] or "{}")
        role = old.get("role") or "user"
        ts = m["time_created"] or int(time.time() * 1000)
        new_id = ulid_msg(ts, i + 1)
        idmap[m["id"]] = new_id
        parent = idmap.get(old.get("parentID")) or last
        data = {
            "role": role,
            "time": {"created": ts},
            "agent": "build",
            "model": {"providerID": "xiaomi", "modelID": "mimo-x-pro-preview"},
        }
        if parent:
            data["parentID"] = parent
        if role == "user":
            data["system"] = "You are MiMo agent, built on MiMo's Desktop."
        conn.execute(
            "INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data) "
            "VALUES (?, ?, 'main', ?, ?, ?)",
            (new_id, sid, ts, ts, json.dumps(data, ensure_ascii=False)),
        )
        for j, p in enumerate(parts.get(m["id"], [])):
            pid = ulid_prt(ts, i * 10 + j + 1)
            try:
                pd = json.loads(p["data"] or "{}")
            except json.JSONDecodeError:
                pd = {"type": "text", "text": ""}
            pd.setdefault("type", "text")
            pd.setdefault("synthetic", False)
            conn.execute(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (pid, new_id, sid, p["time_created"] or ts, p["time_updated"] or ts,
                 json.dumps(pd, ensure_ascii=False)),
            )
            conn.execute(
                "INSERT INTO history_fts (part_id, session_id, message_id, project_id, tool_name, body, time_created) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (pid, sid, new_id, project_id, None, pd.get("text") or "", p["time_created"] or ts),
            )
        last = new_id

    if title:
        conn.execute("UPDATE session SET title=?, project_id=?, directory=? WHERE id=?",
                     (title, project_id, CWD, sid))
    else:
        conn.execute("UPDATE session SET project_id=?, directory=? WHERE id=?",
                     (project_id, CWD, sid))
    return idmap, msgs


def fork_at_boundary(conn, src_sid, boundary_snippet):
    msgs, parts = load_chain(conn, src_sid)
    # 找边界：正文含 snippet 的 message 的 part
    target_idx = None
    target_msg_id = None
    for i, m in enumerate(msgs):
        for p in parts.get(m["id"], []):
            pd = json.loads(p["data"] or "{}")
            if boundary_snippet in (pd.get("text") or ""):
                target_idx = i
                target_msg_id = m["id"]
                break
        if target_idx is not None:
            break
    print("boundary idx", target_idx, "msg", target_msg_id)
    if target_idx is None:
        # 默认取前 60%
        target_idx = max(0, int(len(msgs) * 0.55))
        target_msg_id = msgs[target_idx]["id"]
        print("fallback boundary idx", target_idx)

    fork_sid = "ses_" + ulid_msg(int(time.time() * 1000), 999)[4:24].upper()
    # 更像原生 ses_ffe5... 的 ID
    fork_sid = f"ses_ffe5f{int(time.time() * 1000) % 0xFFFFFFFF:08x}ffe{target_idx:08x}"[:28]
    # 简化：随机 ses_
    import uuid
    fork_sid = "ses_" + uuid.uuid4().hex[:20].upper()

    # 拷贝 0..target_idx（含边界）
    idmap = {}
    last = None
    conn.execute(
        "INSERT OR REPLACE INTO session "
        "(id, project_id, slug, directory, title, version, time_created, time_updated, title_source) "
        "VALUES (?, ?, ?, ?, ?, 'desktop-1579e7d', ?, ?, 'user')",
        (
            fork_sid,
            REAL_PROJECT,
            "fork-recovery",
            CWD,
            "语音电子音乐模型（恢复会话） (fork #1)",
            msgs[0]["time_created"] if msgs else int(time.time() * 1000),
            msgs[target_idx]["time_created"] if msgs else int(time.time() * 1000),
        ),
    )
    for i in range(target_idx + 1):
        m = msgs[i]
        old = json.loads(m["data"] or "{}")
        role = old.get("role") or "user"
        ts = m["time_created"]
        new_id = ulid_msg(ts, i + 1)
        idmap[m["id"]] = new_id
        parent = idmap.get(old.get("parentID")) or last
        data = {
            "role": role,
            "time": {"created": ts},
            "agent": "build",
            "model": {"providerID": "xiaomi", "modelID": "mimo-x-pro-preview"},
        }
        if parent:
            data["parentID"] = parent
        if role == "user":
            data["system"] = "You are MiMo agent, built on MiMo's Desktop."
        conn.execute(
            "INSERT OR REPLACE INTO message (id, session_id, agent_id, time_created, time_updated, data) "
            "VALUES (?, ?, 'main', ?, ?, ?)",
            (new_id, fork_sid, ts, ts, json.dumps(data, ensure_ascii=False)),
        )
        for j, p in enumerate(parts.get(m["id"], [])):
            pid = ulid_prt(ts, i * 10 + j + 1)
            pd = json.loads(p["data"] or "{}")
            pd.setdefault("type", "text")
            conn.execute(
                "INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (pid, new_id, fork_sid, p["time_created"], p["time_updated"], json.dumps(pd, ensure_ascii=False)),
            )
            conn.execute(
                "INSERT OR REPLACE INTO history_fts (part_id, session_id, message_id, project_id, tool_name, body, time_created) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (pid, fork_sid, new_id, REAL_PROJECT, None, pd.get("text") or "", p["time_created"]),
            )
        last = new_id
    print("fork_sid", fork_sid, "copied", target_idx + 1, "messages")
    return fork_sid


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    conn.execute("BEGIN")
    rewrite_session(conn, SRC, REAL_PROJECT, title="语音电子音乐模型（恢复会话）")
    fork_sid = fork_at_boundary(conn, SRC, BOUNDARY_SNIPPET)
    conn.execute("COMMIT")
    conn.close()
    print("done src", SRC, "fork", fork_sid)


if __name__ == "__main__":
    main()
