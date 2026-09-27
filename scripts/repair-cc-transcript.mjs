/**
 * 补写已迁入会话的 Claude Code 转录（修复 resume 报 No conversation found）
 * 用法: node scripts/repair-cc-transcript.mjs <sessionId>
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "D:/SessionHarbor";
const sid = process.argv[2];
if (!sid) {
  console.error("用法: node scripts/repair-cc-transcript.mjs <sessionId>");
  process.exit(2);
}

const { createAlinkAdapter } = await import(
  pathToFileURL(path.join(ROOT, "packages/adapters/alink/dist/index.js")).href
);
const { claudeCwdEncode } = await import(
  pathToFileURL(path.join(ROOT, "packages/core/dist/index.js")).href
);

const alink = createAlinkAdapter();
const ir = await alink.readSession(sid);
const cwd = ir.header.session.cwd || "";
const home = process.env.USERPROFILE || process.env.HOME;
const enc = claudeCwdEncode(cwd);
const outDir = path.join(home, ".claude", "projects", enc);
const outFile = path.join(outDir, `${sid}.jsonl`);

// 直接调用 writeSession repair 路径：overwrite=false 且 CC 缺失时会补写
const result = await alink.writeSession(ir, { overwrite: false });
console.log(JSON.stringify(result, null, 2));
console.log("期望 CC 文件:", outFile, "exists=", fs.existsSync(outFile), fs.existsSync(outFile) ? fs.statSync(outFile).size : 0);
