import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

print("history_fts imported", conn.execute("SELECT COUNT(*) FROM history_fts WHERE session_id LIKE 'ses_469F%'").fetchone()[0])
print("history_fts native fork", conn.execute("SELECT COUNT(*) FROM history_fts WHERE session_id LIKE 'ses_ffe5f60a%'").fetchone()[0])
print("history_fts empty fork", conn.execute("SELECT COUNT(*) FROM history_fts WHERE session_id LIKE 'ses_ffe5f228%'").fetchone()[0])

print("\nsession_prefix_snapshot")
for r in conn.execute("SELECT session_id, profile_key, watermark_message_id, revision FROM session_prefix_snapshot LIMIT 8"):
    print(dict(r))
print("for imported", list(conn.execute("SELECT * FROM session_prefix_snapshot WHERE session_id='ses_469F438DD75A4346ADE5'")))
print("for native", list(conn.execute("SELECT session_id FROM session_prefix_snapshot WHERE session_id LIKE 'ses_ffe5f60a%'")))

print("\nhistory_fts rows for one native")
for r in conn.execute(
    "SELECT part_id, message_id, tool_name, substr(body,1,60) b FROM history_fts WHERE session_id LIKE 'ses_ffe5f60a%' LIMIT 3"
):
    print(dict(r))

print("\nmessage id format comparison in history_fts")
for r in conn.execute("SELECT message_id FROM history_fts LIMIT 5"):
    print(r[0])
for r in conn.execute("SELECT id FROM message WHERE session_id LIKE 'ses_469F%' LIMIT 3"):
    print("import msg", r[0])

conn.close()
