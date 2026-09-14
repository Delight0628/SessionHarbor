/** SQLite 只读打开：复制到临时文件避免源库锁冲突；写打开直接连 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openRo(dbPath: string): DatabaseSync {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-"));
  const tmp = path.join(dir, path.basename(dbPath));
  fs.copyFileSync(dbPath, tmp);
  for (const ext of ["-wal", "-shm"]) {
    const side = dbPath + ext;
    if (fs.existsSync(side)) fs.copyFileSync(side, tmp + ext);
  }
  const db = new DatabaseSync(tmp, { readOnly: true });
  // 关闭时清理由调用方负责；我们挂一个包装
  const origClose = db.close.bind(db);
  (db as DatabaseSync & { close: () => void }).close = () => {
    origClose();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  return db;
}

export function openRw(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath);
}

export function rowsToObjects<T = Record<string, unknown>>(
  stmt: { all: (...args: unknown[]) => unknown[] },
  ...params: unknown[]
): T[] {
  return stmt.all(...params) as T[];
}
