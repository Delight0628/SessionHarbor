import os
from pathlib import Path

pkg = Path(r"D:\SessionHarbor\packages\adapters\openclaw\package.json")
try:
    os.unlink(pkg)
    print("deleted")
except Exception as e:
    print("unlink", e)

content = """{
  "name": "@sessionharbor/adapter-openclaw",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": { "@sessionharbor/core": "workspace:*" },
  "devDependencies": { "@types/node": "^24.0.0", "typescript": "^5.7.0" }
}
"""
pkg.write_text(content, encoding="utf-8")
print("created", pkg.stat().st_size)
