from pathlib import Path

# ForespaceNext and any chat-store files
roots = [
    Path(r"d:\user\tc032353\Application Data\Trae CN"),
    Path(r"d:\user\tc032353\Application Data\TRAE SOLO CN"),
    Path(r"d:\user\tc032353\Application Data\ForespaceNext"),
]
for root in roots:
    print("====", root, root.exists())
    if not root.exists():
        continue
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        name = p.name.lower()
        if any(
            x in name
            for x in (
                "chat",
                "session",
                "conversation",
                "message",
                "history",
                "store",
                "agent",
            )
        ):
            if p.suffix.lower() in (".js", ".map", ".css", ".html"):
                continue
            try:
                sz = p.stat().st_size
            except OSError:
                continue
            if sz > 50_000_000:
                continue
            print(" ", p.relative_to(root), sz)
