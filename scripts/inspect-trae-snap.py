from pathlib import Path

snap = Path(r"d:\user\tc032353\Application Data\Trae CN\ModularData\ai-agent\snapshot")
print("snap", snap.exists())
if snap.exists():
    for d in sorted(snap.iterdir())[:15]:
        print(" dir", d.name)
        v2 = d / "v2"
        if v2.exists():
            for p in v2.rglob("*"):
                if p.is_file() and p.stat().st_size > 10:
                    print("  ", p.relative_to(v2), p.stat().st_size)

# alaudalog sample
log = Path(r"d:\user\tc032353\Application Data\Trae CN\logs\20260928T164435\Modular\ai_agent-0-2026-9-28.alaudalog")
print("\nlog exists", log.exists(), log.stat().st_size if log.exists() else 0)
if log.exists():
    raw = log.read_bytes()
    # find chinese
    for n in ["你好", "Qwen", "模型", "你这是啥情况"]:
        i = raw.find(n.encode("utf-8"))
        print(" needle", n, i)
    # print some utf8 fragments
    try:
        s = raw.decode("utf-8", "replace")
        print(s[:400])
    except Exception as e:
        print(e)
