from pathlib import Path
import re

p = Path(r"D:\SessionHarbor\packages\cli\src\bin.ts")
t = p.read_text(encoding="utf-8")
t = re.sub(r'\s*case "openclaw":\s*\n\s*return discoverOpenClaw\([^;]*\);', "", t)
t = re.sub(r'\s*if \(id === "openclaw"\) return createOpenClawAdapter\([^;]*\);', "", t)
p.write_text(t, encoding="utf-8")
print("cleaned")
