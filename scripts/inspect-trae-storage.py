import json
import sqlite3
from pathlib import Path

roots = [
    Path(r"d:\user\tc032353\Application Data\Trae CN\User\workspaceStorage"),
    Path(r"d:\user\tc032353\Application Data\TRAE SOLO CN\User\workspaceStorage"),
]
sid = "6abb57b82a802cb29fde5f72"

for r in roots:
    print("====", r, r.exists())
    if not r.exists():
        continue
    for d in sorted(r.iterdir()):
        db = d / "state.vscdb"
        if not db.exists():
            continue
        try:
            c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            c.row_factory = sqlite3.Row
            keys = [x[0] for x in c.execute("SELECT key FROM ItemTable")]
            hit = [k for k in keys if "agent" in k.lower() or "icube" in k.lower() or "chat" in k.lower() or "session" in k.lower()]
            # any value contains session id
            has_sid = False
            for k in keys:
                row = c.execute("SELECT value FROM ItemTable WHERE key=?", (k,)).fetchone()
                val = row[0] if row else None
                s = val if isinstance(val, str) else (
                    "".join(chr(b) for b in val) if isinstance(val, (bytes, memoryview)) else str(val)
                )
                if sid in str(s):
                    has_sid = True
                    print("  HIT", d.name, k, "len", len(str(s)))
            print(" ", d.name, "keys", hit[:15], "sid", has_sid)
            c.close()
        except Exception as e:
            print(" ", d.name, e)

# also global drafts
for brand in ("Trae CN", "TRAE SOLO CN"):
    g = Path(rf"d:\user\tc032353\Application Data\{brand}\User\globalStorage\state.vscdb")
    if not g.exists():
        continue
    c = sqlite3.connect(f"file:{g}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    print("global", brand)
    for row in c.execute("SELECT key, length(value) n FROM ItemTable WHERE key LIKE '%session%' OR key LIKE '%agent%' OR key LIKE '%draft%'"):
        print(" ", row[0], row[1])
    c.close()
