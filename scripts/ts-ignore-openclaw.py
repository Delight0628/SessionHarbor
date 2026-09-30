from pathlib import Path

p = Path(r"D:\SessionHarbor\apps\desktop\src\main.ts")
t = p.read_text(encoding="utf-8")
t = t.replace(
    'import { createOpenClawAdapter, discoverOpenClaw } from "@sessionharbor/adapter-openclaw";',
    '// @ts-ignore\nimport { createOpenClawAdapter, discoverOpenClaw } from "@sessionharbor/adapter-openclaw";',
)
p.write_text(t, encoding="utf-8")
print("ok")
