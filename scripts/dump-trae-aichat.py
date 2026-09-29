import json
import sqlite3
from pathlib import Path

p = Path(r"d:\user\tc032353\Application Data\Trae CN\User\workspaceStorage\3887508c4602438de5ce5346e5d9ba4e\state.vscdb")
c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
c.row_factory = sqlite3.Row


def dec(v):
    if isinstance(v, (bytes, memoryview)):
        b = bytes(v)
        try:
            return json.loads(b.decode("utf-8"))
        except Exception:
            try:
                return b.decode("utf-8", "replace")
            except Exception:
                return b
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return v
    return v


for row in c.execute("SELECT key, value FROM ItemTable ORDER BY length(value) DESC"):
    k = row[0]
    val = dec(row[1])
    s = val if isinstance(val, str) else json.dumps(val, ensure_ascii=False)
    if k.startswith("ai-chat") or "session" in k.lower() or "turn" in k.lower():
        print(f"{k} len={len(s)}")
        print(s[:350])
        print("---")
c.close()
