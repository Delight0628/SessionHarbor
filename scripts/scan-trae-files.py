import os
from pathlib import Path

needles = ["qwen omni", "Qwen2.5", "模型放", "gemini/code", "beatbox"]
roots = [
    Path(r"d:\user\tc032353\Application Data\Trae CN"),
    Path(r"d:\user\tc032353\Application Data\TRAE SOLO CN"),
]

for root in roots:
    print("====", root)
    if not root.exists():
        continue
    for dirpath, dirnames, filenames in os.walk(root):
        # skip huge caches
        dirnames[:] = [d for d in dirnames if d.lower() not in ("cache", "code cache", "gpucache", "dawngraphitecache", "cachestorage")]
        for fn in filenames:
            p = Path(dirpath) / fn
            try:
                sz = p.stat().st_size
            except OSError:
                continue
            if sz > 80_000_000 or sz < 20:
                continue
            if p.suffix.lower() in (".pak", ".dll", ".exe", ".pak", ".bin", ".dat"):
                continue
            try:
                raw = p.read_bytes()
            except Exception:
                continue
            for n in needles:
                b = n.encode("utf-8")
                if b in raw:
                    print(" HIT", p, "size", sz, "needle", n)
                    break
