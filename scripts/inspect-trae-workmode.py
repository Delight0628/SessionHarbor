from pathlib import Path

roots = [
    Path(r"d:\user\tc032353\Application Data\Trae CN\ModularData\ai-agent\work-mode-projects"),
    Path(r"d:\user\tc032353\Application Data\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects"),
    Path(r"c:\Users\tc032353\.trae-cn"),
]
for r in roots:
    print("====", r, r.exists())
    if not r.exists():
        continue
    for p in r.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(r)
        if len(rel.parts) > 5:
            continue
        try:
            sz = p.stat().st_size
        except OSError:
            continue
        if sz < 20:
            continue
        print(f"  {rel} {sz}")
        if sz < 2000 and p.suffix in (".json", ".jsonl", ".txt", ".md"):
            try:
                print("   ", p.read_text(encoding="utf-8", errors="replace")[:150])
            except Exception:
                pass
