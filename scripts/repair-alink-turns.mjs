/**
 * 重写领慧 user/messages JSONL：补 result 轮事件 + prompt-navigation.json
 * 用法: node scripts/repair-alink-turns.mjs <sessionId>
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "D:/SessionHarbor";
const sid = process.argv[2];
if (!sid) {
  console.error("用法: node scripts/repair-alink-turns.mjs <sessionId>");
  process.exit(2);
}

const { createAlinkAdapter } = await import(
  pathToFileURL(path.join(ROOT, "packages/adapters/alink/dist/index.js")).href
);

const alink = createAlinkAdapter();
const ir = await alink.readSession(sid);
// overwrite 会重写 user/messages + CC 转录，并写入 result/nav
const result = await alink.writeSession(ir, { overwrite: true });
console.log(JSON.stringify(result, null, 2));

const msg = path.join(
  process.env.APPDATA || "",
  "alink",
  "user",
  "messages",
  `${sid}.jsonl`,
);
const nav = msg.replace(/\.jsonl$/, "") + ".prompt-navigation.json";
if (fs.existsSync(msg)) {
  const text = fs.readFileSync(msg, "utf-8");
  const types = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      types[o.type] = (types[o.type] || 0) + 1;
    } catch {}
  }
  console.log("types", types);
  console.log("nav exists", fs.existsSync(nav));
}
