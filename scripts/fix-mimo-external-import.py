import json
import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(str(db))
conn.row_factory = sqlite3.Row

print("history_fts cols", [r["name"] for r in conn.execute("PRAGMA table_info(history_fts)")])
print("external_import cols", [r["name"] for r in conn.execute("PRAGMA table_info(external_import)")])

# 若无 kind 则 ALTER
cols = [r["name"] for r in conn.execute("PRAGMA table_info(history_fts)")]
if "kind" not in cols:
    conn.execute("ALTER TABLE history_fts ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'")
    print("added kind column")

# 回填 kind
conn.execute("UPDATE history_fts SET kind='text' WHERE kind IS NULL OR kind=''")

SRC = "ses_469F438DD75A4346ADE5"
FORK = "ses_ffe5f228290c4ffe1C3W6tb4e8"

# 注册为 external_import，让 UI 走 imported 通道
now = 1790422380348
for sid, key in ((SRC, "01a0a096-a029-7e12-a198-cc55e2b40bb1"), (FORK, "01a0a096-fork-1")):
    conn.execute(
        "INSERT OR REPLACE INTO external_import "
        "(source, source_key, session_id, source_path, source_mtime, time_imported, message_ids) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            "manual",
            key,
            sid,
            r"D:\SessionHarbor\恢复会话_01a0a096_语音电子音乐模型.md",
            now,
            now,
            json.dumps([]),
        ),
    )
    print("external_import", sid)

conn.commit()

print("history_fts kind sample")
for r in conn.execute(
    "SELECT part_id, kind, tool_name, substr(body,1,40) b FROM history_fts WHERE session_id LIKE 'ses_469F%' LIMIT 3"
):
    print(dict(r))
print("external_import count", conn.execute("SELECT COUNT(*) FROM external_import").fetchone()[0])
conn.close()
