import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

print("tables", [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")])

for table in ("event", "event_sequence", "message", "part", "session"):
    try:
        n = conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE "
            + (
                "session_id LIKE 'ses_469F%'"
                if table != "session"
                else "id LIKE 'ses_469F%'"
            )
        ).fetchone()[0]
        n2 = conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE "
            + (
                "session_id LIKE 'ses_ffe5f60a%'"
                if table != "session"
                else "id LIKE 'ses_ffe5f60a%'"
            )
        ).fetchone()[0]
        print(table, "imported", n, "native-fork", n2)
    except Exception as e:
        print(table, e)

print("\nevent schema")
for r in conn.execute("PRAGMA table_info(event)"):
    print(r["name"], r["type"])

print("\nevents for imported vs native")
for sid in ("ses_469F438DD75A4346ADE5", "ses_ffe5f60a4e090ffepSd2fmw3bA"):
    rows = list(conn.execute("SELECT * FROM event WHERE session_id=? LIMIT 3", (sid,)))
    print(sid, "events", len(rows))
    for r in rows:
        print(" ", {k: str(r[k])[:60] for k in r.keys()})

conn.close()
