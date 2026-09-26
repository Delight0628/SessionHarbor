import json
import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

for sid in (
    "ses_469F438DD75A4346ADE5",
    "ses_ffe5f228290c4ffe1C3W6tb4e8",
    "ses_ffe5f5bf1b9feffehxcYazJp7L",
):
    print("====", sid)
    r = conn.execute("SELECT * FROM session WHERE id=?", (sid,)).fetchone()
    if not r:
        print("missing")
        continue
    print("title", r["title"], "parent_id", r["parent_id"], "cwd", r["directory"])
    msgs = list(
        conn.execute(
            "SELECT id, data, time_created FROM message WHERE session_id=? ORDER BY time_created, id",
            (sid,),
        )
    )
    print("msg count", len(msgs))
    for i, m in enumerate(msgs[:6]):
        d = json.loads(m["data"] or "{}")
        print(f"  [{i}]", m["id"][:22], "role", d.get("role"), "parent", str(d.get("parentID"))[:22])
    if len(msgs) > 6:
        print("  ...")
        for m in msgs[-2:]:
            d = json.loads(m["data"] or "{}")
            print("  [end]", m["id"][:22], "role", d.get("role"), "parent", str(d.get("parentID"))[:22])
    # parts count
    pc = conn.execute(
        "SELECT COUNT(*) FROM part WHERE session_id=?", (sid,)
    ).fetchone()[0]
    print("parts", pc)
conn.close()
