const fs = require("fs");
const p = "D:/SessionHarbor/packages/adapters/openclaw/package.json";
const content = JSON.stringify(
  {
    name: "@sessionharbor/adapter-openclaw",
    version: "0.1.0",
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: { ".": "./dist/index.js" },
    scripts: { build: "tsc -p tsconfig.json" },
    dependencies: { "@sessionharbor/core": "workspace:*" },
    devDependencies: { "@types/node": "^24.0.0", typescript: "^5.7.0" },
  },
  null,
  2,
);
try {
  fs.writeFileSync(p, content + "\n");
  console.log("wrote", fs.statSync(p).size);
  console.log("read", JSON.parse(fs.readFileSync(p, "utf8")).name);
} catch (e) {
  console.log("err", e.message);
}
