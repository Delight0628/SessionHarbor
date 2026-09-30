"""恢复 openclaw 适配器引用并修复 package.json EPERM。"""
from pathlib import Path
import json
import os

# 1) 修复 package.json 权限（写新文件替换）
pkg = Path(r"D:\SessionHarbor\packages\adapters\openclaw\package.json")
data = json.loads(pkg.read_text(encoding="utf-8"))
tmp = pkg.parent / "package.json.new"
tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
os.replace(tmp, pkg)
print("package.json rewritten")

# 2) 恢复 CLI 引用
p = Path(r"D:\SessionHarbor\packages\cli\src\bin.ts")
t = p.read_text(encoding="utf-8")
if "openclaw" not in t:
    t = t.replace(
        'import { createMimoAdapter, discoverMimo } from "@sessionharbor/adapter-mimo";',
        'import { createMimoAdapter, discoverMimo } from "@sessionharbor/adapter-mimo";\nimport { createOpenClawAdapter, discoverOpenClaw } from "@sessionharbor/adapter-openclaw";',
    )
    t = t.replace('  "deepseek-harness",\n', '  "deepseek-harness",\n  "openclaw",\n')
    t = t.replace(
        '    case "deepseek-harness":\n      return discoverDsh(args["dsh-root"] as string | undefined);',
        '    case "deepseek-harness":\n      return discoverDsh(args["dsh-root"] as string | undefined);\n    case "openclaw":\n      return discoverOpenClaw();',
    )
    t = t.replace(
        '  if (id === "deepseek-harness") return createDeepseekHarnessAdapter(paths as never);',
        '  if (id === "deepseek-harness") return createDeepseekHarnessAdapter(paths as never);\n  if (id === "openclaw") return createOpenClawAdapter(paths as never);',
    )
    t = t.replace(
        "deepseek-harness|cursor",
        "deepseek-harness|openclaw|cursor",
    )
    p.write_text(t, encoding="utf-8")
    print("bin.ts restored")
else:
    print("bin.ts already has openclaw")

# 3) 恢复 Desktop 引用
p = Path(r"D:\SessionHarbor\apps\desktop\src\main.ts")
t = p.read_text(encoding="utf-8")
if "openclaw" not in t:
    t = t.replace(
        'import { createDeepseekHarnessAdapter, discoverDsh } from "@sessionharbor/adapter-deepseek-harness";',
        'import { createDeepseekHarnessAdapter, discoverDsh } from "@sessionharbor/adapter-deepseek-harness";\nimport { createOpenClawAdapter, discoverOpenClaw } from "@sessionharbor/adapter-openclaw";',
    )
    t = t.replace('  | "deepseek-harness"', '  | "deepseek-harness"\n  | "openclaw"')
    t = t.replace('  "deepseek-harness",\n', '  "deepseek-harness",\n  "openclaw",\n')
    t = t.replace(
        '  { id: "deepseek-harness", displayName: "DeepSeek Harness", discover: () => discoverDsh() },',
        '  { id: "deepseek-harness", displayName: "DeepSeek Harness", discover: () => discoverDsh() },\n  { id: "openclaw", displayName: "OpenClaw", discover: () => discoverOpenClaw(), canWrite: false },',
    )
    t = t.replace(
        '    case "deepseek-harness":\n      return createDeepseekHarnessAdapter(paths as never);',
        '    case "deepseek-harness":\n      return createDeepseekHarnessAdapter(paths as never);\n    case "openclaw":\n      return createOpenClawAdapter(paths as never);',
    )
    p.write_text(t, encoding="utf-8")
    print("main.ts restored")
else:
    print("main.ts already has openclaw")

# 4) 恢复 package.json 依赖
for pj in [
    Path(r"D:\SessionHarbor\packages\cli\package.json"),
    Path(r"D:\SessionHarbor\apps\desktop\package.json"),
]:
    d = json.loads(pj.read_text(encoding="utf-8"))
    d.setdefault("dependencies", {})["@sessionharbor/adapter-openclaw"] = "workspace:*"
    pj.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("deps ok", pj.parent.parent.name)

print("done")
