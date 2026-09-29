from pathlib import Path

needles = ["你好", "Qwen", "omini", "模型", "beatbox"]
roots = [
    Path(r"d:\user\tc032353\Application Data\Trae CN\User\IndexedDB"),
    Path(r"d:\user\tc032353\Application Data\Trae CN\User\workspaceStorage"),
    Path(r"d:\user\tc032353\Application Data\TRAE SOLO CN\User\IndexedDB"),
]
for root in roots:
    print("====", root, root.exists())
    if not root.exists():
        continue
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        try:
            sz = p.stat().st_size
        except OSError:
            continue
        if sz < 30 or sz > 20_000_000:
            continue
        if p.suffix.lower() in (".pak", ".dll", ".exe"):
            continue
        try:
            raw = p.read_bytes()
        except Exception:
            continue
        for n in needles:
            if n.encode("utf-8") in raw:
                print(" HIT", p, sz, n)
                break
        if b"6abb57b82a802cb29fde5f72" in raw:
            print(" SID", p, sz)
