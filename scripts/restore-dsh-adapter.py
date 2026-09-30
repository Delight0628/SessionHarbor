"""把 deepseek-harness 适配器接回 CLI / Desktop。"""
from pathlib import Path

# --- cli bin.ts ---
p = Path(r"D:\SessionHarbor\packages\cli\src\bin.ts")
t = p.read_text(encoding="utf-8")
if "deepseek-harness" not in t:
    t = t.replace(
        'import { createMimoAdapter, discoverMimo } from "@sessionharbor/adapter-mimo";',
        'import { createMimoAdapter, discoverMimo } from "@sessionharbor/adapter-mimo";\nimport { createDeepseekHarnessAdapter, discoverDsh } from "@sessionharbor/adapter-deepseek-harness";',
    )
    t = t.replace("  \"mimo\",\n", "  \"mimo\",\n  \"deepseek-harness\",\n")
    t = t.replace(
        '    case "mimo":\n      return discoverMimo(args["mimo-db"] as string | undefined);',
        '    case "mimo":\n      return discoverMimo(args["mimo-db"] as string | undefined);\n    case "deepseek-harness":\n      return discoverDsh(args["dsh-root"] as string | undefined);',
    )
    t = t.replace(
        '  if (id === "mimo") return createMimoAdapter(paths);',
        '  if (id === "mimo") return createMimoAdapter(paths);\n  if (id === "deepseek-harness") return createDeepseekHarnessAdapter(paths as never);',
    )
    t = t.replace(
        "codex|mimo|cursor",
        "codex|mimo|deepseek-harness|cursor",
    )
    t = t.replace(
        "  --mimo-db PATH",
        "  --dsh-root PATH       指定 DeepSeek Harness 根目录\n  --mimo-db PATH",
    )
    p.write_text(t, encoding="utf-8")
    print("bin.ts patched")
else:
    print("bin.ts already")

# --- desktop main.ts ---
p = Path(r"D:\SessionHarbor\apps\desktop\src\main.ts")
t = p.read_text(encoding="utf-8")
if "deepseek-harness" not in t:
    t = t.replace(
        'import { createMimoAdapter, discoverMimo } from "@sessionharbor/adapter-mimo";',
        'import { createMimoAdapter, discoverMimo } from "@sessionharbor/adapter-mimo";\nimport { createDeepseekHarnessAdapter, discoverDsh } from "@sessionharbor/adapter-deepseek-harness";',
    )
    t = t.replace('  | "mimo"', '  | "mimo"\n  | "deepseek-harness"', 1)
    t = t.replace('  "mimo",\n', '  "mimo",\n  "deepseek-harness",\n')
    t = t.replace(
        '  { id: "mimo", displayName: "MiMo Desktop", discover: () => discoverMimo() },',
        '  { id: "mimo", displayName: "MiMo Desktop", discover: () => discoverMimo() },\n  { id: "deepseek-harness", displayName: "DeepSeek Harness", discover: () => discoverDsh() },',
    )
    t = t.replace(
        '    case "mimo":\n      return createMimoAdapter(paths);',
        '    case "mimo":\n      return createMimoAdapter(paths);\n    case "deepseek-harness":\n      return createDeepseekHarnessAdapter(paths as never);',
    )
    p.write_text(t, encoding="utf-8")
    print("main.ts patched")
else:
    print("main.ts already")

# --- app.js ---
p = Path(r"D:\SessionHarbor\apps\desktop\renderer\app.js")
t = p.read_text(encoding="utf-8")
if "deepseek-harness" not in t:
    t = t.replace(
        '    mimo:',
        '    "deepseek-harness": "#4db6ff",\n    mimo:',
    )
    p.write_text(t, encoding="utf-8")
    print("app.js patched")
else:
    print("app.js already")

print("done")
