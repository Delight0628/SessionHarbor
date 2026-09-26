import json
import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(str(db))
conn.row_factory = sqlite3.Row

for sid in [
    "ses_469F438DD75A4346ADE5",
    "ses_57A16DA0441B40048A05",
    "ses_ffe5f2246d130ffevOIlY6Msuh",
]:
    n = conn.execute("SELECT COUNT(*) FROM message WHERE session_id=?", (sid,)).fetchone()[0]
    t = conn.execute("SELECT title FROM session WHERE id=?", (sid,)).fetchone()
    print(sid, "msgs", n, "title", t[0] if t else None)

print("\n--- find 结论/模型放 in all parts ---")
for r in conn.execute(
    "SELECT session_id, message_id, substr(data,1,120) d FROM part "
    "WHERE data LIKE '%模型放%' OR data LIKE '%最适合放模型%' LIMIT 10"
):
    print(dict(r))

print("\n--- assistant texts around 50-70 of source ---")
msgs = list(
    conn.execute(
        "SELECT id, data FROM message WHERE session_id='ses_469F438DD75A4346ADE5' ORDER BY time_created, id"
    )
)
print("src count", len(msgs))
for i, m in enumerate(msgs):
    d = json.loads(m["data"])
    if d.get("role") == "assistant" and i > 40:
        # first text part
        for p in conn.execute("SELECT data FROM part WHERE message_id=?", (m["id"],)):
            pd = json.loads(p["data"] or "{}")
            if pd.get("type") == "text" and pd.get("text"):
                print(i, m["id"], pd["text"][:80].replace("\n", " "))
                break
conn.close()
