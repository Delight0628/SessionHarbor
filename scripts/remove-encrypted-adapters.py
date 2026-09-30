"""移除 trae-solo / devin / deepseek-harness 适配器及引用。"""
import json
import re
import shutil
from pathlib import Path

ROOT = Path(r"D:\SessionHarbor")

# 1) 删除适配器目录
for name in ("trae-solo", "devin", "deepseek-harness"):
    p = ROOT / "packages" / "adapters" / name
    if p.exists():
        shutil.rmtree(p)
        print("rmtree", p)

# 2) 清理 CLI bin.ts
cli = ROOT / "packages" / "cli" / "src" / "bin.ts"
text = cli.read_text(encoding="utf-8")
# remove imports
text = re.sub(
    r'import\s*\{[^}]*createDeepseekHarnessAdapter[^}]*\}\s*from\s*"@sessionharbor/adapter-deepseek-harness";\s*\n',
    "",
    text,
)
text = re.sub(
    r'import\s*\{[^}]*createDevinAdapter[^}]*\}\s*from\s*"@sessionharbor/adapter-devin";\s*\n',
    "",
    text,
)
text = re.sub(
    r'import\s*\{[^}]*createTraeSoloAdapter[^}]*\}\s*from\s*"@sessionharbor/adapter-trae-solo";\s*\n',
    "",
    text,
)
# remove from CLIENTS array
text = text.replace('"deepseek-harness",\n', "").replace('"devin",\n', "").replace('"trae-solo",\n', "")
# remove case blocks
text = re.sub(
    r'\s*case "deepseek-harness":\s*\n\s*return discoverDsh\([^;]*\);',
    "",
    text,
)
text = re.sub(
    r'\s*case "devin":\s*\n\s*return discoverDevin\([^;]*\);',
    "",
    text,
)
text = re.sub(
    r'\s*case "trae-solo":\s*\n\s*return discoverTrae\([^;]*\);',
    "",
    text,
)
text = re.sub(r'\s*if \(id === "deepseek-harness"\) return createDeepseekHarnessAdapter\([^;]*\);', "", text)
text = re.sub(r'\s*if \(id === "devin"\) return createDevinAdapter\([^;]*\);', "", text)
text = re.sub(r'\s*if \(id === "trae-solo"\) return createTraeSoloAdapter\([^;]*\);', "", text)
# help text
text = text.replace("cursor|vscode|trae-solo|hermes", "cursor|vscode|hermes")
text = re.sub(r"\s*--trae-root PATH[^\n]*\n", "\n", text)
cli.write_text(text, encoding="utf-8")
print("patched bin.ts")

# 3) 清理 desktop main.ts
main = ROOT / "apps" / "desktop" / "src" / "main.ts"
text = main.read_text(encoding="utf-8")
text = re.sub(
    r'import\s*\{[^}]*createDeepseekHarnessAdapter[^}]*\}\s*from\s*"@sessionharbor/adapter-deepseek-harness";\s*\n',
    "",
    text,
)
text = re.sub(
    r'import\s*\{[^}]*createDevinAdapter[^}]*\}\s*from\s*"@sessionharbor/adapter-devin";\s*\n',
    "",
    text,
)
text = re.sub(
    r'import\s*\{[^}]*createTraeSoloAdapter[^}]*\}\s*from\s*"@sessionharbor/adapter-trae-solo";\s*\n',
    "",
    text,
)
text = text.replace('  | "deepseek-harness"\n', "")
text = text.replace('  | "devin"\n', "")
text = text.replace('  | "trae-solo"\n', "")
text = text.replace('"deepseek-harness",\n', "").replace('"devin",\n', "").replace('"trae-solo",\n', "")
# CLIENT_META entries
text = re.sub(
    r"\s*\{\s*\n\s*id: \"deepseek-harness\",\s*\n[^}]*\},",
    "",
    text,
)
text = re.sub(
    r"\s*\{\s*\n\s*id: \"devin\",\s*\n[^}]*\},",
    "",
    text,
)
text = re.sub(
    r"\s*\{\s*\n\s*id: \"trae-solo\",\s*\n[^}]*\},",
    "",
    text,
)
text = re.sub(r'\s*case "deepseek-harness":\s*\n\s*return createDeepseekHarnessAdapter\([^;]*\);', "", text)
text = re.sub(r'\s*case "devin":\s*\n\s*return createDevinAdapter\([^;]*\);', "", text)
text = re.sub(r'\s*case "trae-solo":\s*\n\s*return createTraeSoloAdapter\([^;]*\);', "", text)
main.write_text(text, encoding="utf-8")
print("patched main.ts")

# 4) app.js
appjs = ROOT / "apps" / "desktop" / "renderer" / "app.js"
text = appjs.read_text(encoding="utf-8")
text = text.replace('    "deepseek-harness": "#6eb6ff",\n', "")
text = text.replace('    devin: "#f0a0c8",\n', "")
text = text.replace('    "trae-solo": "#5ad4a0",\n', "")
# remove trae special-case block
text = re.sub(
    r"\s*// 目标：可写客户端 \+ 只读的 Trae[^\n]*\n\s*const dstList = \[...writable\];\n\s*if \(readInstalled\.some\(\(c\) => c\.id === \"trae-solo\"\)[^}]*\}\n",
    "\n    const dstList = [...writable];\n",
    text,
)
# simpler: replace trae block
text = text.replace(
    """    const dstList = [...writable];
    if (readInstalled.some((c) => c.id === "trae-solo") && !dstList.some((c) => c.id === "trae-solo")) {
      dstList.push({ id: "trae-solo", displayName: "Trae（只读迁出）", canWrite: false });
    }""",
    "    const dstList = [...writable];",
)
appjs.write_text(text, encoding="utf-8")
print("patched app.js")

# 5) package.json deps
for pj in (
    ROOT / "packages" / "cli" / "package.json",
    ROOT / "apps" / "desktop" / "package.json",
):
    data = json.loads(pj.read_text(encoding="utf-8"))
    for k in list(data.get("dependencies", {})):
        if any(x in k for x in ("trae-solo", "adapter-devin", "deepseek-harness")):
            del data["dependencies"][k]
            print("dep rm", pj.name, k)
    pj.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

print("done")
