import hashlib
import json
import sqlite3
import time
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(str(db))
conn.row_factory = sqlite3.Row

# 修正 watermark：按 time_created 最大的消息
for sid in (
    "ses_469F438DD75A4346ADE5",
    "ses_ffe5f228290c4ffe1C3W6tb4e8",
):
    last = conn.execute(
        "SELECT id, time_created FROM message WHERE session_id=? ORDER BY time_created ASC, id ASC",
        (sid,),
    ).fetchall()
    print(sid, "msgs", len(last), "first", last[0]["id"] if last else None, "last", last[-1]["id"] if last else None)
    watermark = last[-1]["id"] if last else None
    system = json.dumps(
        ["You are MiMo agent, built on MiMo's Desktop."],
        ensure_ascii=False,
    )
    tools = "[]"
    system_hash = hashlib.sha256(system.encode()).hexdigest()
    tools_hash = hashlib.sha256(tools.encode()).hexdigest()
    profile = hashlib.sha256(system.encode()).hexdigest()
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT OR REPLACE INTO session_prefix_snapshot "
        "(session_id, profile_key, system, system_hash, tools_hash, watermark_message_id, revision, created_at, updated_at, tools) "
        "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
        (sid, profile, system, system_hash, tools_hash, watermark, now, now, tools),
    )
    print("  watermark", watermark)

conn.commit()
conn.close()
print("ok")
