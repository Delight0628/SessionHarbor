/** SQLite 只读打开：复制到临时文件避免源库锁冲突；写打开直接连 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 大库阈值：超过则跳过整库拷贝，优先只读直开 */
const LARGE_DB_BYTES = 64 * 1024 * 1024;

export function openRo(dbPath: string): DatabaseSync {
  // 优先只读直开（避免 Cursor 等数百 MB 库整文件拷贝）
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    /* fall through to temp copy */
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-"));
  const tmp = path.join(dir, path.basename(dbPath));
  try {
    const st = fs.statSync(dbPath);
    if (st.size > LARGE_DB_BYTES) {
      // 超大库仍整拷贝可能拖垮启动；再次尝试 immutable 只读
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        fs.rmSync(dir, { recursive: true, force: true });
        return db;
      } catch {
        /* continue copy */
      }
    }
    fs.copyFileSync(dbPath, tmp);
    for (const ext of ["-wal", "-shm"]) {
      const side = dbPath + ext;
      if (fs.existsSync(side)) fs.copyFileSync(side, tmp + ext);
    }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const db = new DatabaseSync(tmp, { readOnly: true });
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
