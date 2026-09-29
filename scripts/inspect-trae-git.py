import zlib
from pathlib import Path

snap = Path(r"d:\user\tc032353\Application Data\Trae CN\ModularData\ai-agent\snapshot")
# find largest git objects
objs = []
for p in snap.rglob(".git/objects/**/*"):
    if p.is_file() and len(p.name) == 38:
        objs.append((p.stat().st_size, p))
objs.sort(reverse=True)
print("top objects")
for sz, p in objs[:10]:
    print(" ", sz, p)
    try:
        raw = zlib.decompress(p.read_bytes())
        print("   decomp", len(raw), raw[:120])
    except Exception as e:
        print("   err", e)

# also try reading git log messages for chat-turn commits
import subprocess
for d in sorted(snap.iterdir())[:3]:
    gitdir = d / "v2" / ".git"
    if not gitdir.exists():
        continue
    print("====", d.name)
    r = subprocess.run(
        ["git", "--git-dir", str(gitdir), "log", "--all", "--oneline"],
        capture_output=True,
        text=True,
    )
    print(r.stdout[:500])
