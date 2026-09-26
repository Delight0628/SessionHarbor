import sqlite3
from pathlib import Path

c = sqlite3.connect(Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db"))
c.row_factory = sqlite3.Row
for r in c.execute("SELECT id, title, parent_id FROM session WHERE title LIKE '%语音%'"):
    n = c.execute("SELECT COUNT(*) FROM message WHERE session_id=?", (r["id"],)).fetchone()[0]
    print(r["id"], n, r["parent_id"], r["title"])
c.close()
