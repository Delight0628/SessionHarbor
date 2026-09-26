import json
import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

print("=== all fork sessions ===")
for r in conn.execute(
    "SELECT id, title, parent_id, directory, time_created FROM session "
    "WHERE title LIKE '%fork%' ORDER BY time_created DESC LIMIT 15"
):
    n = conn.execute(
        "SELECT COUNT(*) FROM message WHERE session_id=?", (r["id"],)
    ).fetchone()[0]
    print(f"{r['id'][:28]} parent={r['parent_id']} msgs={n} | {r['title'][:50]}")

print("\n=== native pair: 语音 electronic original + fork ===")
# find original 语音 that was forked
for r in conn.execute(
    "SELECT id, title, parent_id FROM session WHERE title LIKE '%语音%'"
):
    print(dict(r))

print("\n=== message data shape comparison ===")
for sid, label in [
    ("ses_469F438DD75A4346ADE5", "imported"),
    ("ses_ffe5f228290c4ffe1C3W6tb4e8", "fork-empty"),
    ("ses_ffe5f5bf1b9feffehxcYazJp7L", "fork-marle"),
]:
    print("--", label, sid)
    rows = list(
        conn.execute(
            "SELECT id, agent_id, data FROM message WHERE session_id=? ORDER BY time_created LIMIT 3",
            (sid,),
        )
    )
    for m in rows:
        d = json.loads(m["data"] or "{}")
        print("  agent", m["agent_id"], "keys", sorted(d.keys()), "role", d.get("role"))
        print("   parentID", d.get("parentID"), "id field", d.get("id"), "messageId", d.get("messageId"))

print("\n=== fork session full row ===")
r = conn.execute(
    "SELECT * FROM session WHERE id='ses_ffe5f228290c4ffe1C3W6tb4e8'"
).fetchone()
if r:
    print({k: r[k] for k in r.keys() if r[k] is not None})

conn.close()
