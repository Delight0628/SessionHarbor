import sqlite3, shutil, tempfile, os, json
from pathlib import Path

def dump_mimo():
    src = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
    fd, name = tempfile.mkstemp(suffix=".db"); os.close(fd)
    shutil.copy2(src, name)
    for ext in ("-wal", "-shm"):
        s = Path(str(src) + ext)
        if s.exists():
            shutil.copy2(s, name + ext)
    conn = sqlite3.connect(f"file:{name}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    print("=== MiMo forked sessions ===")
    for r in conn.execute(
        "SELECT id, title, parent_id, directory FROM session WHERE parent_id IS NOT NULL LIMIT 10"
    ):
        print(dict(r))
    print("=== MiMo message parentID ===")
    n = 0
    for r in conn.execute("SELECT id, session_id, data FROM message ORDER BY time_created LIMIT 200"):
        d = json.loads(r["data"] or "{}")
        if d.get("parentID"):
            print(r["id"][:24], "role", d.get("role"), "parent", str(d.get("parentID"))[:24])
            n += 1
            if n >= 8:
                break
    # count sessions with forks (title contains fork)
    c = conn.execute("SELECT COUNT(*) n FROM session WHERE title LIKE '%fork%' OR parent_id IS NOT NULL").fetchone()
    print("fork-like sessions", c[0])
    conn.close()
    for x in (name, name + "-wal", name + "-shm"):
        try:
            os.unlink(x)
        except OSError:
            pass

def dump_wb():
    roots = list(Path(r"C:\Users\tc032353\.workbuddy\projects").glob("*/*.jsonl"))
    print("=== WorkBuddy multi-child ===")
    found = 0
    for p in roots[:80]:
        parents = {}
        with p.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    o = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if o.get("type") == "message":
                    parents.setdefault(o.get("parentId"), []).append(o.get("id"))
        multi = {k: v for k, v in parents.items() if len(v) > 1}
        if multi:
            print(p.name, "multi parents", len(multi), list(multi.items())[:2])
            found += 1
            if found >= 3:
                break
    if not found:
        print("no multi-child in sample")

def dump_alink_uuid():
    p = Path(r"d:\user\tc032353\Application Data\alink\user\messages\98435023-e132-45d5-86a2-95c3b8a7b348.jsonl")
    # native alink may not have parentUuid at envelope level
    print("=== alink parent fields sample ===")
    with p.open(encoding="utf-8") as f:
        for i, line in enumerate(f):
            o = json.loads(line)
            if o.get("type") in ("user", "assistant", "prompt"):
                print(o.get("type"), "keys", list(o.keys()), "data keys", list((o.get("data") or {}).keys())[:12])
                break

if __name__ == "__main__":
    dump_mimo()
    dump_wb()
    dump_alink_uuid()
