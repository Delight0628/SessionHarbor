import json
import sqlite3
from pathlib import Path

def decode(v):
    if v is None:
        return None
    if isinstance(v, (bytes, memoryview)):
        b = bytes(v)
        try:
            s = b.decode("utf-8")
            return json.loads(s)
        except Exception:
            return b[:200]
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return v[:200]
    return v

roots = [
    Path(r"d:\user\tc032353\Application Data\Trae CN\User\workspaceStorage"),
]
for r in roots:
    for d in sorted(r.iterdir()):
        db = d / "state.vscdb"
        if not db.exists():
            continue
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        for key in (
            "ChatStore",
            "chat.ChatSessionStore.index",
            "memento/icube-ai-agent-storage",
            "currentAgentData_3850950341047163",
        ):
            row = c.execute("SELECT value FROM ItemTable WHERE key=?", (key,)).fetchone()
            if not row:
                continue
            val = decode(row[0])
            s = json.dumps(val, ensure_ascii=False)[:500] if not isinstance(val, str) else val[:500]
            print(f"\n== {d.name} :: {key} ==")
            print(s)
        # chatQueryCompletion sample
        for row in c.execute(
            "SELECT key, value FROM ItemTable WHERE key LIKE 'ai-chat.chatQueryCompletion%' LIMIT 2"
        ):
            val = decode(row[1])
            print(f"\n== {d.name} :: {row[0]} ==")
            print(json.dumps(val, ensure_ascii=False)[:400])
        c.close()
