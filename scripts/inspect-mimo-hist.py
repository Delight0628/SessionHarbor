import json
import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

for t in (
    "history_fts",
    "session_prefix_snapshot",
    "external_import",
    "claude_import",
    "event",
):
    print("====", t)
    try:
        cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({t})")]
        n = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print("cols", cols, "n", n)
    except Exception as e:
        print(e)
        continue

print("\n--- session_prefix_snapshot for our and native ---")
for sid in (
    "ses_469F438DD75A4346ADE5",
    "ses_ffe5f60a4e090ffepSd2fmw3bA",
    "ses_ffe5f228290c4ffe1C3W6tb4e8",
):
    rows = list(
        conn.execute(
            "SELECT * FROM session_prefix_snapshot WHERE session_id=? OR id LIKE ?",
            (sid, f"%{sid[-12:]}%"),
        )
    )
    print(sid, "rows", len(rows))
    for r in rows[:2]:
        d = dict(r)
        for k, v in d.items():
            print(" ", k, str(v)[:120])

print("\n--- history_fts sample ---")
for r in conn.execute("SELECT * FROM history_fts LIMIT 2"):
    print({k: str(r[k])[:80] for k in r.keys()})

print("\n--- event by aggregate for imported ---")
for r in conn.execute(
    "SELECT aggregate_id, type, COUNT(*) n FROM event GROUP BY aggregate_id, type LIMIT 20"
):
    print(dict(r))

print("\n--- claude_import / external_import ---")
for t in ("claude_import", "external_import"):
    for r in conn.execute(f"SELECT * FROM {t} LIMIT 5"):
        print(t, {k: str(r[k])[:80] for k in r.keys()})

conn.close()
