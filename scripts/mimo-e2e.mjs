import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "D:/SessionHarbor";
const SB = path.join(ROOT, "sandbox-mimo");

fs.rmSync(SB, { recursive: true, force: true });
const alinkDir = path.join(SB, "alink", "user", "messages");
fs.mkdirSync(alinkDir, { recursive: true });
fs.mkdirSync(path.join(SB, "workdir"), { recursive: true });
const srcDb = path.join(process.env.APPDATA, "alink", "messages_tc032353_PROD.sqlite");
const alinkDb = path.join(SB, "alink", "messages_tc032353_PROD.sqlite");
fs.copyFileSync(srcDb, alinkDb);
for (const ext of ["-wal", "-shm"]) {
  if (fs.existsSync(srcDb + ext)) fs.copyFileSync(srcDb + ext, alinkDb + ext);
}
const sampleId = "00609438-b872-4963-9873-21bd09140c04";
fs.copyFileSync(
  path.join(process.env.APPDATA, "alink", "user", "messages", `${sampleId}.jsonl`),
  path.join(alinkDir, `${sampleId}.jsonl`),
);
const mimoDb = path.join(SB, "mimocode.db");
fs.copyFileSync(
  path.join(process.env.USERPROFILE, ".local/share/mimocode/mimocode.db"),
  mimoDb,
);
for (const ext of ["-wal", "-shm"]) {
  const s = path.join(process.env.USERPROFILE, ".local/share/mimocode/mimocode.db") + ext;
  if (fs.existsSync(s)) fs.copyFileSync(s, mimoDb + ext);
}

const { createAlinkAdapter } = await import(
  pathToFileURL(path.join(ROOT, "packages/adapters/alink/dist/index.js")).href
);
const { createMimoAdapter } = await import(
  pathToFileURL(path.join(ROOT, "packages/adapters/mimo/dist/index.js")).href
);
const { migrate, formatReport } = await import(
  pathToFileURL(path.join(ROOT, "packages/core/dist/index.js")).href
);

const alink = createAlinkAdapter({
  id: "alink",
  dataRoot: path.join(SB, "alink"),
  primaryDb: alinkDb,
  jsonlDir: alinkDir,
  extraDbs: [],
});
const mimo = createMimoAdapter({
  id: "mimo",
  dataRoot: SB,
  primaryDb: mimoDb,
  extraDbs: [],
});

const r = await migrate({
  source: alink,
  target: mimo,
  workdir: path.join(SB, "workdir"),
  filter: { ids: [sampleId] },
  overwrite: true,
  backupPaths: [alinkDb, mimoDb],
});
console.log(formatReport(r));
if (r.failed) process.exit(1);

// verify
const sessions = await mimo.listSessions();
const hit = sessions.find((s) => s.id.includes("00609438") || s.title.includes("开发MiMo"));
console.log("mimo sessions after write:", sessions.length);
console.log("new/updated:", hit);
if (!hit) {
  // maybe ses_ prefix
  const any = sessions.find((s) => s.title.includes("开发MiMo"));
  if (!any) throw new Error("未在 mimo 列表中找到迁入会话");
}
const ir = await mimo.readSession(hit.id);
const msgs = ir.items.filter((i) => i.type === "message");
console.log("read back messages:", msgs.length, "title:", ir.header.session.title);
if (msgs.length < 1) throw new Error("迁入后读不到消息");
console.log("✅ alink → mimo 沙箱迁移验证通过");
