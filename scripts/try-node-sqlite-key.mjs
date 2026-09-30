import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dbPath = process.argv[2];
const key = process.argv[3];
const tmp = path.join(os.tmpdir(), "trae-test.db");
fs.copyFileSync(dbPath, tmp);
for (const ext of ["-wal", "-shm"]) {
  const s = dbPath + ext;
  if (fs.existsSync(s)) fs.copyFileSync(s, tmp + ext);
}

const db = new DatabaseSync(tmp, { readOnly: true });
try {
  db.exec(`PRAGMA key = '${key}'`);
  console.log("key applied");
} catch (e) {
  console.log("key err", e);
}
try {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log("tables", rows);
} catch (e) {
  console.log("query err", e.message);
}
db.close();
