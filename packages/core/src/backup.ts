/** 写前备份：文件 + WAL/SHM，时间戳后缀 */

import fs from "node:fs";
import path from "node:path";
import { timestampTag } from "./time.js";

export function backupFile(src: string, destDir: string, ts?: string): string {
  const tag = ts ?? timestampTag();
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `${path.basename(src)}.${tag}.bak`);
  fs.copyFileSync(src, dest);
  for (const ext of ["-wal", "-shm"]) {
    const side = src + ext;
    if (fs.existsSync(side)) fs.copyFileSync(side, dest + ext);
  }
  return dest;
}

export function backupMany(sources: (string | undefined)[], destDir: string, ts?: string): string[] {
  const tag = ts ?? timestampTag();
  const out: string[] = [];
  for (const src of sources) {
    if (src && fs.existsSync(src)) out.push(backupFile(src, destDir, tag));
  }
  return out;
}
