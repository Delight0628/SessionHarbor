import json
import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
print("=== fork/parent sessions ===")
for r in conn.execute(
    "SELECT id, title, parent_id, directory FROM session "
    "WHERE title LIKE '%fork%' OR parent_id IS NOT NULL OR title LIKE '%语音%' "
    "LIMIT 20"
):
    print(dict(r))
print("=== 469F messages ===")
for r in conn.execute(
    "SELECT id, data, time_created FROM message WHERE session_id LIKE 'ses_469F%' "
    "ORDER BY time_created LIMIT 8"
):
    d = json.loads(r["data"] or "{}")
    print(r["id"][:24], "role", d.get("role"), "parent", str(d.get("parentID"))[:24], "ts", d.get("time"))
conn.close()
