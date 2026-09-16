import sqlite3
from pathlib import Path

p = Path(r"d:\user\tc032353\Application Data\alink\messages_tc032353_PROD.sqlite")
conn = sqlite3.connect(str(p))
conn.execute(
    """
CREATE TRIGGER IF NOT EXISTS trg_alink_session_agent_engine_immutable
         BEFORE UPDATE OF agentEngine ON alink_session
         FOR EACH ROW
         WHEN NEW.agentEngine IS NOT OLD.agentEngine
         BEGIN
           SELECT RAISE(ABORT, 'AGENT_ENGINE_IMMUTABLE');
         END
"""
)
conn.commit()
for r in conn.execute(
    "SELECT sessionId, name, agentEngine FROM alink_session "
    "WHERE sessionId LIKE 'aed1%' OR name LIKE '%运力%' OR agentEngine='local-agent-harness' LIMIT 10"
):
    print(r)
conn.close()
print("trigger restored")
