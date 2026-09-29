import json
import sqlite3
from pathlib import Path

def decode(v):
    if v is None:
        return None
    if isinstance(v, (bytes, memoryview)):
        b = bytes(v)
        try:
            return json.loads(b.decode("utf-8"))
        except Exception:
            try:
                return b.decode("utf-8", "replace")[:200]
            except Exception:
                return b[:80]
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return v[:200]
    return v

# search ALL workspaceStorage item values for known Chinese chat text
needles = ["Qwen", "omini", "模型放", "gemini/code", "你好"]
ws_roots = [
    Path(r"d:\user\tc032353\Application Data\Trae CN\User\workspaceStorage"),
    Path(r"d:\user\tc032353\Application Data\TRAE SOLO CN\User\workspaceStorage"),
]
for wr in ws_roots:
    print("ROOT", wr)
    if not wr.exists():
        continue
    for d in wr.iterdir():
        db = d / "state.vscdb"
        if not db.exists():
            continue
        try:
            c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            c.row_factory = sqlite3.Row
            for row in c.execute("SELECT key, value FROM ItemTable"):
                val = decode(row[1])
                s = val if isinstance(val, str) else json.dumps(val, ensure_ascii=False)
                for n in needles:
                    if n in s:
                        print(" HIT", d.name, row[0][:80], "len", len(s), "needle", n)
                        break
            c.close()
        except Exception as e:
            print(" err", d.name, e)

# also search indexeddb / leveldb-ish files
for wr in ws_roots:
    for p in wr.rglob("*"):
        if p.is_file() and p.suffix in (".log", ".ldb", ".sqlite", ".db", "") and p.stat().st_size < 50_000_000:
            if p.name.endswith("state.vscdb") or p.name.endswith(".log"):
                continue
            try:
                raw = p.read_bytes()[:200000]
            except Exception:
                continue
            for n in needles:
                if n.encode("utf-8") in raw:
                    print("FILE", p, "has", n)
                    break
