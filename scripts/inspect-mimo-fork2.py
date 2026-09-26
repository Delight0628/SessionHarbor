import json
import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

# 生成一个猫在沙发上的图片 (fork #1) and #2 - look for base session
print("=== 猫 sessions ===")
for r in conn.execute(
    "SELECT id, title, parent_id, project_id, version, directory FROM session WHERE title LIKE '%猫%'"
):
    n = conn.execute("SELECT COUNT(*) FROM message WHERE session_id=?", (r["id"],)).fetchone()[0]
    print(dict(r), "msgs", n)

# compare first message ids of a native fork vs its likely source
print("\n=== fork #1 猫 first msgs ===")
sid = "ses_ffe5f60a4e090ffepSd2fmw3bA"
for m in conn.execute(
    "SELECT id, data FROM message WHERE session_id=? ORDER BY time_created, id LIMIT 5",
    (sid,),
):
    d = json.loads(m["data"] or "{}")
    print(m["id"], d.get("role"), d.get("parentID"), d.get("time"))

print("\n=== fork #2 猫 first msgs ===")
sid2 = "ses_ffe5f5be55800ffewI2SpwcsB1"
for m in conn.execute(
    "SELECT id, data FROM message WHERE session_id=? ORDER BY time_created, id LIMIT 5",
    (sid2,),
):
    d = json.loads(m["data"] or "{}")
    print(m["id"], d.get("role"), d.get("parentID"), d.get("time"))

# Does any session share message ids with fork? (copy vs move)
print("\n=== message id overlap between fork and others ===")
for fork_id in (sid, sid2, "ses_ffe5f5bf1b9feffehxcYazJp7L"):
    fids = set(
        r[0]
        for r in conn.execute("SELECT id FROM message WHERE session_id=?", (fork_id,))
    )
    print("fork", fork_id[:24], "n", len(fids))
    if not fids:
        continue
    # find other sessions containing same ids
    for r in conn.execute("SELECT session_id, COUNT(*) n FROM message GROUP BY session_id"):
        if r["session_id"] == fork_id:
            continue
    # query overlap
    placeholders = ",".join("?" * min(len(fids), 5))
    sample = list(fids)[:5]
    rows = list(
        conn.execute(
            f"SELECT session_id, COUNT(*) n FROM message WHERE id IN ({placeholders}) GROUP BY session_id",
            sample,
        )
    )
    print("  overlap sample", rows)

# check context_from / workspace fields
print("\n=== session columns with context ===")
for r in conn.execute("PRAGMA table_info(session)"):
    if any(k in r["name"].lower() for k in ("parent", "context", "fork", "origin", "from")):
        print(r["name"])

print("\n=== context_from values ===")
for r in conn.execute(
    "SELECT id, context_from, parent_id, title FROM session WHERE context_from IS NOT NULL OR parent_id IS NOT NULL LIMIT 10"
):
    print(dict(r))

conn.close()
