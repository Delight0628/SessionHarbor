import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// use fzstd from dsh module fallback
const fzstdPath =
  "C:/Users/tc032353/.dsh/profiles/desktop/.dsh-module-fallback/node_modules/fzstd/lib/index.js";
const fzstd = require(fzstdPath);
console.log("fzstd keys", Object.keys(fzstd));

const file = process.argv[2];
const out = process.argv[3];
const buf = fs.readFileSync(file);
console.log("input", buf.length, "magic", buf.subarray(0, 4).toString("hex"));
const decompressed = fzstd.decompress(buf);
console.log("decompressed", decompressed.length);
if (out) fs.writeFileSync(out, decompressed);
// print first lines
const text = Buffer.from(decompressed).toString("utf-8");
const lines = text.split("\n").filter(Boolean);
console.log("lines", lines.length);
for (const line of lines.slice(0, 5)) {
  try {
    const o = JSON.parse(line);
    console.log("  type=", o.type, "keys=", Object.keys(o).slice(0, 10));
  } catch {
    console.log("  raw", line.slice(0, 100));
  }
}
