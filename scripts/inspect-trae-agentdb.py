import json
import sqlite3
from pathlib import Path

for brand in ("Trae CN", "TRAE SOLO CN"):
    db = Path(rf"d:\user\tc032353\Application Data\{brand}\ModularData\ai-agent\database.db")
    print("====", brand, db.exists())
    if not db.exists():
        continue
    # try sqlite
    try:
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        print(" tables", tables)
        for t in tables:
            n = c.execute(f"SELECT COUNT(*) FROM [{t}]").fetchone()[0]
            print(" ", t, n)
        c.close()
    except Exception as e:
        print(" not sqlite", e)
        raw = db.read_bytes()[:200]
        print(" header", raw[:20])
