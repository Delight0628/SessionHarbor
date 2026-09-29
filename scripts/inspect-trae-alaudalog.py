from pathlib import Path

log = Path(r"d:\user\tc032353\Application Data\Trae CN\logs\20260928T164435\Modular\ai_agent-0-2026-9-28.alaudalog")
print("size", log.stat().st_size)
raw = log.read_bytes()
# try utf-8
try:
    s = raw.decode("utf-8", "replace")
except Exception:
    s = raw.decode("latin1", "replace")
print("len", len(s))
print(s[:800])
print("...")
# find session id
sid = "6abb57b82a802cb29fde5f72"
i = s.find(sid)
print("sid idx", i)
if i > 0:
    print(s[max(0, i - 100) : i + 400])
# find chinese chat
for n in ["你这是啥情况", "Qwen", "omni", "你好", "user", "assistant"]:
    j = s.find(n)
    print("needle", n, j)
