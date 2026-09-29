import json
from pathlib import Path

for brand in ("Trae CN", "TRAE SOLO CN"):
    d = Path(rf"d:\user\tc032353\Application Data\{brand}\ModularData\ai-agent\sandbox")
    print("====", brand, d.exists())
    if not d.exists():
        continue
    for p in sorted(d.glob("*.json"))[:6]:
        print(" file", p.name, p.stat().st_size)
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            print("  keys", list(data)[:20] if isinstance(data, dict) else type(data))
            s = json.dumps(data, ensure_ascii=False)
            print("  sample", s[:300])
        except Exception as e:
            print("  err", e)
