import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

print("=== sessions like 语音 / 01a0 / 469F ===")
for r in conn.execute(
    "SELECT id, title, directory, time_created, time_archived FROM session "
    "WHERE title LIKE '%语音%' OR id LIKE '%469F%' OR id LIKE '%ffe5f228%' "
    "ORDER BY time_created DESC LIMIT 20"
):
    n = conn.execute(
        "SELECT COUNT(*) FROM message WHERE session_id=?", (r["id"],)
    ).fetchone()[0]
    print(dict(r), "msgs", n)

print("\n=== external_import ===")
for r in conn.execute("SELECT * FROM external_import"):
    print(dict(r))

print("\n=== butheisDelight sessions ===")
for r in conn.execute(
    "SELECT id, title, directory FROM session WHERE directory LIKE '%butheis%' LIMIT 15"
):
    print(dict(r))

conn.close()
