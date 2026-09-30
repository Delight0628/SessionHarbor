from pathlib import Path

p = Path(r"D:\SessionHarbor\apps\desktop\src\main.ts")
t = p.read_text(encoding="utf-8")
if "createOpenClawAdapter" not in t:
    t = t.replace(
        'import { createDeepseekHarnessAdapter, discoverDsh } from "@sessionharbor/adapter-deepseek-harness";',
        'import { createDeepseekHarnessAdapter, discoverDsh } from "@sessionharbor/adapter-deepseek-harness";\nimport { createOpenClawAdapter, discoverOpenClaw } from "@sessionharbor/adapter-openclaw";',
    )
    if "createOpenClawAdapter" not in t:
        t = t.replace(
            'import { createMimoAdapter, discoverMimo } from "@sessionharbor/adapter-mimo";',
            'import { createMimoAdapter, discoverMimo } from "@sessionharbor/adapter-mimo";\nimport { createOpenClawAdapter, discoverOpenClaw } from "@sessionharbor/adapter-openclaw";',
        )
    t = t.replace('  | "deepseek-harness"', '  | "deepseek-harness"\n  | "openclaw"', 1)
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
    print("patched")
else:
    print("already")
