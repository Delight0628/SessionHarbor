"""移除损坏的 openclaw 适配器引用（package.json EPERM）。"""
from pathlib import Path
import json

for fp in [
    Path(r"D:\SessionHarbor\packages\cli\src\bin.ts"),
    Path(r"D:\SessionHarbor\apps\desktop\src\main.ts"),
]:
    t = fp.read_text(encoding="utf-8")
    t = t.replace(
        'import { createOpenClawAdapter, discoverOpenClaw } from "@sessionharbor/adapter-openclaw";\n',
        "",
    )
    t = t.replace('  "openclaw",\n', "")
    t = t.replace('  | "openclaw"\n', "")
    t = t.replace(
        '    case "openclaw":\n      return discoverOpenClaw();\n',
        "",
    )
    t = t.replace(
        '    case "openclaw":\n      return createOpenClawAdapter(paths as never);\n',
        "",
    )
    t = t.replace('  if (id === "openclaw") return createOpenClawAdapter(paths as never);\n', "")
    t = t.replace(
        '  { id: "openclaw", displayName: "OpenClaw", discover: () => discoverOpenClaw(), canWrite: false },\n',
        "",
    )
    t = t.replace("|openclaw", "")
    fp.write_text(t, encoding="utf-8")
    print("patched", fp.name)

print("done")
