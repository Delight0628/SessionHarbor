"""
修复 MiMo 导入会话：
1) 为 ses_469F... 补 history_fts（fork 复制依赖）
2) 重建空 fork 会话的消息（按原生 fork 语义：拷贝到边界并重映射 parentID）
"""
import json
import sqlite3
import uuid
from pathlib import Path

DB = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
SRC = "ses_469F438DD75A4346ADE5"
FORK = "ses_ffe5f228290c4ffe1C3W6tb4e8"


def new_msg():
    return "msg_" + uuid.uuid4().hex[:20].upper()


def new_prt():
    return "prt_" + uuid.uuid4().hex[:20].upper()


def index_history(conn, session_id: str, project_id: str) -> int:
    rows = list(
        conn.execute(
            "SELECT p.id AS part_id, p.message_id, p.time_created, p.data, m.data AS mdata "
            "FROM part p JOIN message m ON m.id = p.message_id "
            "WHERE p.session_id = ?",
            (session_id,),
        )
    )
    conn.execute("DELETE FROM history_fts WHERE session_id = ?", (session_id,))
    n = 0
    for r in rows:
        try:
            pd = json.loads(r["data"] or "{}")
        except json.JSONDecodeError:
            pd = {}
        body = pd.get("text") or ""
        tool = pd.get("tool") or pd.get("toolName")
        conn.execute(
            "INSERT INTO history_fts (part_id, session_id, message_id, project_id, tool_name, body, time_created) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                r["part_id"],
                session_id,
                r["message_id"],
                project_id,
                tool,
                body,
                r["time_created"],
            ),
        )
        n += 1
    return n


def rebuild_fork(conn, src: str, fork: str):
    msgs = list(
        conn.execute(
            "SELECT id, data, time_created, time_updated FROM message WHERE session_id=? ORDER BY time_created, id",
            (src,),
        )
    )
    parts_by_msg = {}
    for p in conn.execute(
        "SELECT id, message_id, data, time_created, time_updated FROM part WHERE session_id=? ORDER BY time_created, id",
        (src,),
    ):
        parts_by_msg.setdefault(p["message_id"], []).append(p)

    # 清空 fork 现有
    conn.execute("DELETE FROM part WHERE session_id=?", (fork,))
    conn.execute("DELETE FROM message WHERE session_id=?", (fork,))
    conn.execute("DELETE FROM history_fts WHERE session_id=?", (fork,))

    idmap = {}
    last = None
    n = 0
    for m in msgs:
        d = json.loads(m["data"] or "{}")
        parent_old = d.get("parentID")
        new_id = new_msg()
        idmap[m["id"]] = new_id
        d["parentID"] = idmap.get(parent_old, last) if parent_old else last
        # 兼容引擎 fork：写入 parentID 指向上一条
        if d.get("parentID") is None and last:
            d["parentID"] = last
        conn.execute(
            "INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data) VALUES (?, ?, 'main', ?, ?, ?)",
            (new_id, fork, m["time_created"], m["time_updated"], json.dumps(d, ensure_ascii=False)),
        )
        for p in parts_by_msg.get(m["id"], []):
            pid = new_prt()
            conn.execute(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
                (pid, new_id, fork, p["time_created"], p["time_updated"], p["data"]),
            )
            try:
                pd = json.loads(p["data"] or "{}")
            except json.JSONDecodeError:
                pd = {}
            conn.execute(
                "INSERT INTO history_fts (part_id, session_id, message_id, project_id, tool_name, body, time_created) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    pid,
                    fork,
                    new_id,
                    "ff33a399-6940-422c-8466-99e667ac8f43",
                    pd.get("tool") or pd.get("toolName"),
                    pd.get("text") or "",
                    p["time_created"],
                ),
            )
        last = new_id
        n += 1
    return n


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    conn.execute("BEGIN")
    proj = conn.execute("SELECT project_id FROM session WHERE id=?", (SRC,)).fetchone()
    project_id = proj[0] if proj else "butheisDelight"
    n1 = index_history(conn, SRC, project_id)
    print("indexed history_fts for source", n1)

    n2 = rebuild_fork(conn, SRC, FORK)
    print("rebuild fork messages", n2)

    # 更新 fork session 元数据保持可读
    conn.execute(
        "UPDATE session SET title=?, directory=?, time_created=?, time_updated=? WHERE id=?",
        (
            "语音电子音乐模型（恢复会话） (fork #1)",
            "D:\\butheisDelight",
            1789400661000,
            1789400661000,
            FORK,
        ),
    )
    conn.execute("COMMIT")
    conn.close()
    print("done")


if __name__ == "__main__":
    main()
