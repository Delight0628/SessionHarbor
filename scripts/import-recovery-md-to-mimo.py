"""Parse recovery markdown and write into MiMo mimocode.db with parentID chain."""
import json
import re
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

MD = Path(r"D:\SessionHarbor\恢复会话_01a0a096_语音电子音乐模型.md")
DB = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
CWD = r"D:\butheisDelight"
TITLE = "语音电子音乐模型（恢复会话）"
SOURCE_ID = "01a0a096-a029-7e12-a198-cc55e2b40bb1"

header_re = re.compile(r"^##\s+(👤\s*用户|🤖\s*助手)\s*·\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*$")


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
        # strip thinking details / mcp blocks for cleaner chat? keep body but drop <details> noise optionally
        # Keep full body as text for fidelity; collapse whitespace-only
        if content:
            msgs.append({"role": role, "ts": ts, "text": content})
    return msgs


def new_msg_id():
    return "msg_" + uuid.uuid4().hex[:20].upper()


def new_prt_id():
    return "prt_" + uuid.uuid4().hex[:20].upper()


def to_ms(ts: str) -> int:
    dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
    return int(dt.timestamp() * 1000)


def ensure_schema(conn: sqlite3.Connection):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS session (
          id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT,
          directory TEXT, title TEXT, version TEXT, share_url TEXT,
          summary_additions INTEGER, summary_deletions INTEGER,
          summary_files INTEGER, summary_diffs TEXT, revert TEXT, permission TEXT,
          time_created INTEGER, time_updated INTEGER, time_compacting INTEGER,
          time_archived INTEGER, workspace_id TEXT, context_from TEXT,
          context_watermark TEXT, last_checkpoint_message_id TEXT, prompt TEXT,
          auto_worktree_hint_sent INTEGER
        );
        CREATE TABLE IF NOT EXISTS message (
          id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT,
          time_created INTEGER, time_updated INTEGER, data TEXT
        );
        CREATE TABLE IF NOT EXISTS part (
          id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
          time_created INTEGER, time_updated INTEGER, data TEXT
        );
        CREATE TABLE IF NOT EXISTS project (
          id TEXT PRIMARY KEY, worktree TEXT, vcs TEXT, name TEXT,
          icon_url TEXT, icon_color TEXT, time_created INTEGER,
          time_updated INTEGER, time_initialized INTEGER, sandboxes TEXT, commands TEXT
        );
        """
    )


def main():
    text = MD.read_text(encoding="utf-8")
    msgs = parse_messages(text)
    print("parsed messages", len(msgs))
    for m in msgs[:3]:
        print(m["role"], m["ts"], m["text"][:60].replace("\n", " "))
    print("...")
    for m in msgs[-2:]:
        print(m["role"], m["ts"], m["text"][:60].replace("\n", " "))

    session_id = "ses_" + uuid.uuid4().hex[:20].upper()
    project_id = "butheisDelight"
    now = int(datetime.now().timestamp() * 1000)
    t0 = to_ms(msgs[0]["ts"]) if msgs else now
    t1 = to_ms(msgs[-1]["ts"]) if msgs else now

    conn = sqlite3.connect(str(DB))
    ensure_schema(conn)
    conn.execute("BEGIN")
    conn.execute(
        "INSERT OR IGNORE INTO project (id, worktree, name, time_created, time_updated, sandboxes) "
        "VALUES (?, ?, ?, ?, ?, '[]')",
        (project_id, CWD, "butheisDelight", now, now),
    )
    conn.execute(
        "INSERT OR REPLACE INTO session "
        "(id, project_id, slug, directory, title, version, time_created, time_updated) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            session_id,
            project_id,
            "yuyin-dianzi-yinyue-mohu",
            CWD,
            TITLE,
            "sessionharbor-import-0.1",
            t0,
            t1,
        ),
    )

    last_id = None
    n = 0
    for m in msgs:
        ts = to_ms(m["ts"])
        msg_id = new_msg_id()
        role = m["role"]
        data = {
            "role": role,
            "time": {"created": ts},
            "agent": "migrate",
        }
        if last_id:
            data["parentID"] = last_id
        if role == "user":
            data["system"] = f"导入自恢复会话 {SOURCE_ID}"
        conn.execute(
            "INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data) "
            "VALUES (?, ?, 'main', ?, ?, ?)",
            (msg_id, session_id, ts, ts, json.dumps(data, ensure_ascii=False)),
        )
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                new_prt_id(),
                msg_id,
                session_id,
                ts,
                ts,
                json.dumps({"type": "text", "text": m["text"], "synthetic": False}, ensure_ascii=False),
            ),
        )
        last_id = msg_id
        n += 1

    conn.execute("COMMIT")
    conn.close()
    print("session_id", session_id)
    print("wrote messages", n)
    print("title", TITLE)
    print("directory", CWD)


if __name__ == "__main__":
    main()
