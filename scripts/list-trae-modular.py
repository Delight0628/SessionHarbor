from pathlib import Path

# list ModularData structure
for brand in ("Trae CN", "TRAE SOLO CN"):
    root = Path(rf"d:\user\tc032353\Application Data\{brand}\ModularData")
    print("====", root, root.exists())
    if not root.exists():
        continue
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(root)
        if len(rel.parts) > 4:
            continue
        if p.suffix.lower() in (".pak", ".dll", ".exe", ".dat"):
            continue
        try:
            sz = p.stat().st_size
        except OSError:
            continue
        if sz < 50:
            continue
        print(f"  {rel} {sz}")
