import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const sqlPath = "D:/SessionHarbor/vendor-sqlcipher/signalapp/package/dist/index.mjs";
const { default: Database } = await import(pathToFileURL(sqlPath).href);

const dbPath = process.argv[2];
const tmp = path.join(process.env.TEMP || "/tmp", "trae-dec.db");
fs.copyFileSync(dbPath, tmp);
for (const ext of ["-wal", "-shm"]) {
  const s = dbPath + ext;
  if (fs.existsSync(s)) fs.copyFileSync(s, tmp + ext);
}

const key = process.argv[3];
const attempts = [
  `PRAGMA key = '${key}'`,
  `PRAGMA key = "${key}"`,
  `PRAGMA key = "x'${Buffer.from(key, "utf8").toString("hex")}"`,
  `PRAGMA key = '${key}'`,
  `PRAGMA cipher_compatibility = 3; PRAGMA key = '${key}'`,
  `PRAGMA cipher_compatibility = 4; PRAGMA key = '${key}'`,
  `PRAGMA key = '${key}'; PRAGMA cipher_page_size = 4096;`,
  `PRAGMA key = '${key}'; PRAGMA cipher_hmac_algorithm = HMAC_SHA512;`,
  `PRAGMA key = '${key}'; PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512;`,
  `PRAGMA hexkey = '${Buffer.from(key, "utf8").toString("hex")}'`,
];

for (const stmt of attempts) {
  const db = new Database(tmp, { readonly: true });
  try {
    db.exec(stmt);
    const rows = db.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
    console.log("SUCCESS", stmt.slice(0, 80), "->", rows);
    db.close();
    process.exit(0);
  } catch (e) {
    console.log("fail", stmt.slice(0, 70), "|", e.message.slice(0, 60));
    try {
      db.close();
    } catch {}
  }
}
console.log("all attempts failed");
