import json
import sqlite3
from pathlib import Path

sid = "6abb57b82a802cb29fde5f72"

def decode(v):
    if v is None:
        return None
    if isinstance(v, (bytes, memoryview)):
        b = bytes(v)
        try:
            return json.loads(b.decode("utf-8"))
        except Exception:
            try:
                return b.decode("utf-8", "replace")[:300]
            except Exception:
                return b[:100]
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return v[:300]
    return v

for p in [
    Path(r"d:\user\tc032353\Application Data\Trae CN\User\globalStorage\state.vscdb"),
    Path(r"d:\user\tc032353\Application Data\Trae CN\User\workspaceStorage\3887508c4602438de5ce5346e5d9ba4e\state.vscdb"),
]:
    print("====", p)
    c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    for row in c.execute("SELECT key, value FROM ItemTable"):
        val = decode(row[1])
        s = val if isinstance(val, str) else json.dumps(val, ensure_ascii=False)
        if sid in s or (row[0] and sid in row[0]):
            print("KEY", row[0][:120], "len", len(s))
            print(s[:400])
            print("---")
    c.close()
