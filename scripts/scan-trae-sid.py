from pathlib import Path

sid = "6abb57b82a802cb29fde5f72"
roots = [
    Path(r"d:\user\tc032353\Application Data\Trae CN"),
    Path(r"d:\user\tc032353\Application Data\TRAE SOLO CN"),
]
# shallow walk depth 4
for root in roots:
    print("====", root)
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        # depth limit
        rel = p.relative_to(root)
        if len(rel.parts) > 5:
            continue
        try:
            sz = p.stat().st_size
        except OSError:
            continue
        if sz < 20 or sz > 30_000_000:
            continue
        name = p.name.lower()
        if name.endswith((".pak", ".dll", ".exe", ".bin", ".dat", ".ico", ".png", ".jpg")):
            continue
        try:
            raw = p.read_bytes()
        except Exception:
            continue
        if sid.encode() in raw:
            print("SID HIT", p, sz)
        elif b"icube-ai-agent" in raw and b"sessionId" in raw:
            print("META HIT", p, sz)
