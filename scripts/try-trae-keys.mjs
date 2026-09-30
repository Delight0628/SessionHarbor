import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sqlPath = "D:/SessionHarbor/vendor-sqlcipher/signalapp/package/dist/index.mjs";
const { default: Database } = await import(pathToFileURL(sqlPath).href);

const dbPath = process.argv[2];
const keysFile = process.argv[3];
const tmp = path.join(process.env.TEMP || "/tmp", "trae-try.db");
fs.copyFileSync(dbPath, tmp);
for (const ext of ["-wal", "-shm"]) {
  const s = dbPath + ext;
  if (fs.existsSync(s)) fs.copyFileSync(s, tmp + ext);
}

const keys = fs.readFileSync(keysFile, "utf-8").split("\n").filter(Boolean);
console.log("trying", keys.length, "keys");

// suppress sqlcipher errors
const origErr = console.error;
console.error = () => {};

for (const key of keys) {
  const db = new Database(tmp, { readonly: true });
  try {
    db.exec(`PRAGMA key = '${key}'`);
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
    console.error = origErr;
    console.log("FOUND KEY:", key);
    db.close();
    process.exit(0);
  } catch {
    try {
      db.close();
    } catch {}
  }
}
console.error = origErr;
console.log("no key matched");
