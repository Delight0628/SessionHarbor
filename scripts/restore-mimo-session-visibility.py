import json
import sqlite3
from pathlib import Path

db = Path(r"C:\Users\tc032353\.local\share\mimocode\mimocode.db")
conn = sqlite3.connect(str(db))
conn.row_factory = sqlite3.Row

for sid in (
    "ses_469F438DD75A4346ADE5",
    "ses_ffe5f228290c4ffe1C3W6tb4e8",
):
    r = conn.execute("SELECT * FROM session WHERE id=?", (sid,)).fetchone()
    print(sid, dict(r) if r else "MISSING from session table")

# 真实项目 UUID
proj = conn.execute(
    "SELECT id, worktree, name FROM project WHERE worktree LIKE '%butheis%'"
).fetchall()
print("projects", [dict(p) for p in proj])

# 修正 project_id 为真实 UUID，并去掉 external_import 里的“导入”身份，
# 让 UI 当作普通会话列出
REAL = "ff33a399-6940-422c-8466-99e667ac8f43"
conn.execute("BEGIN")
conn.execute(
    "UPDATE session SET project_id=? WHERE id IN (?, ?)",
    (REAL, "ses_469F438DD75A4346ADE5", "ses_ffe5f228290c4ffe1C3W6tb4e8"),
)
# 从 external_import 移除，避免进“导入会话”隐藏列表
conn.execute(
    "DELETE FROM external_import WHERE session_id IN (?, ?)",
    ("ses_469F438DD75A4346ADE5", "ses_ffe5f228290c4ffe1C3W6tb4e8"),
)
# 确保 fork 会话存在且有消息
n = conn.execute(
    "SELECT COUNT(*) FROM message WHERE session_id='ses_ffe5f228290c4ffe1C3W6tb4e8'"
).fetchone()[0]
print("fork msgs", n)
if n == 0:
    print("fork empty - leave as is")
conn.execute("COMMIT")

r = conn.execute(
    "SELECT id, title, project_id, directory FROM session WHERE title LIKE '%语音%'"
).fetchall()
print("after fix", [dict(x) for x in r])
conn.close()
