import json
import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
sid = "ses_469F438DD75A4346ADE5"
print("session:")
for r in conn.execute(
    "SELECT id, title, directory, parent_id, project_id, time_created FROM session WHERE id=?",
    (sid,),
):
    print(dict(r))
rows = list(
    conn.execute(
        "SELECT id, data FROM message WHERE session_id=? ORDER BY time_created, id",
        (sid,),
    )
)
print("messages", len(rows))
with_parent = 0
chain_ok = 0
prev = None
for i, r in enumerate(rows):
    d = json.loads(r["data"] or "{}")
    parent = d.get("parentID")
    if parent:
        with_parent += 1
        if parent == prev:
            chain_ok += 1
    prev = r["id"]
print("parentID", with_parent, "chain_ok", chain_ok)
# first/last text
parts = list(
    conn.execute(
        "SELECT message_id, data FROM part WHERE session_id=? ORDER BY time_created LIMIT 2",
        (sid,),
    )
)
for p in parts:
    d = json.loads(p["data"] or "{}")
    print("part", (d.get("text") or "")[:50])
conn.close()
