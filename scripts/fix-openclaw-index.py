from pathlib import Path

p = Path(r"D:\SessionHarbor\packages\adapters\openclaw")
(p / "index.js").write_text('export * from "./dist/index.js";\n', encoding="utf-8")
(p / "index.d.ts").write_text('export * from "./dist/index.js";\n', encoding="utf-8")
print("created root index.js")
