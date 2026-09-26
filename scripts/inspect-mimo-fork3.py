import json
import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

def dump(sid, label):
    print("====", label, sid)
    row = conn.execute("SELECT * FROM message WHERE session_id=? ORDER BY time_created, id LIMIT 1", (sid,)).fetchone()
    if not row:
        print("  no messages")
        return
    print("  message cols:", {k: row[k] for k in row.keys()})
    print("  data:", row["data"])
    p = conn.execute("SELECT * FROM part WHERE message_id=?", (row["id"],)).fetchone()
    if p:
        print("  part cols:", {k: p[k] for k in p.keys()})
        print("  part.data:", p["data"])

dump("ses_ffe5f60a4e090ffepSd2fmw3bA", "native fork cat")
dump("ses_469F438DD75A4346ADE5", "our import")
dump("ses_ffe5f228290c4ffe1C3W6tb4e8", "empty fork")

print("\n=== project table for butheisDelight ===")
for r in conn.execute("SELECT id, name, worktree FROM project"):
    if "buth" in str(r["name"]).lower() or "buth" in str(r["worktree"]).lower() or "buth" in str(r["id"]).lower():
        print(dict(r))
print("projects sample:")
for r in conn.execute("SELECT id, name, worktree FROM project LIMIT 10"):
    print(dict(r))

conn.close()
