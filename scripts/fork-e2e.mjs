/**
 * Fork E2E：WorkBuddy 兄弟分叉 → MiMo 主链 + fork 会话
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = "D:/SessionHarbor";
const SB = path.join(ROOT, "sandbox-fork");
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(SB, { recursive: true });

// 合成 workbuddy.db + jsonl（含分叉）
const wbRoot = path.join(SB, "wb");
const projects = path.join(wbRoot, "projects", "d-demo");
fs.mkdirSync(projects, { recursive: true });
const dbPath = path.join(wbRoot, "workbuddy.db");
const db = new DatabaseSync(dbPath);
db.exec(`
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, custom_title TEXT,
  status TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER,
  is_playground INTEGER, mode TEXT, model TEXT
);
CREATE TABLE workspaces (path TEXT, last_opened_at INTEGER);
`);
const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
db.prepare(
  `INSERT INTO sessions (id,cwd,user_id,title,custom_title,status,created_at,updated_at,is_playground,mode,model)
   VALUES (?,?,?,?,?,?,?, ?,0,'craft','test-model')`,
).run(sid, "D:\\demo", "u1", "ForkDemo", null, "completed", 1700000000000, 1700000001000);
db.close();

const msg = (id, parentId, role, text, ts) =>
  JSON.stringify({
    id,
    parentId,
    timestamp: ts,
    type: "message",
    role,
    status: "completed",
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    sessionId: sid,
    cwd: "D:\\demo",
  });

const lines = [
  msg("m1", null, "user", "如何设计缓存？", 1700000000000),
  msg("m2", "m1", "assistant", "方案A：本地 Redis", 1700000000100),
  msg("m3a", "m2", "user", "走方案A继续", 1700000000200),
  msg("m4a", "m3a", "assistant", "A：已写 redis.conf", 1700000000300),
  msg("m3b", "m2", "user", "换成方案B：内存缓存", 1700000000200),
  msg("m4b", "m3b", "assistant", "B：已用 LRU map", 1700000000300),
];
fs.writeFileSync(path.join(projects, `${sid}.jsonl`), lines.join("\n") + "\n");

// MiMo sandbox db — 留空，由 adapter ensureSchema 建完整表
const mimoDb = path.join(SB, "mimocode.db");

const { createWorkbuddyAdapter } = await import(
  pathToFileURL(path.join(ROOT, "packages/adapters/workbuddy/dist/index.js")).href
);
const { createMimoAdapter } = await import(
  pathToFileURL(path.join(ROOT, "packages/adapters/mimo/dist/index.js")).href
);
const { migrate, formatReport, planForkSessions } = await import(
  pathToFileURL(path.join(ROOT, "packages/core/dist/index.js")).href
);

const wb = createWorkbuddyAdapter({
  id: "workbuddy",
  dataRoot: wbRoot,
  primaryDb: dbPath,
  projectsRoot: path.join(wbRoot, "projects"),
  extraDbs: [],
});
const mimo = createMimoAdapter({
  id: "mimo",
  dataRoot: SB,
  primaryDb: mimoDb,
  extraDbs: [],
});

const ir = await wb.readSession(sid);
const texts = ir.items
  .filter((i) => i.type === "message")
  .map((i) => (i.type === "message" ? i.content.map((c) => (c.type === "text" ? c.text : "")).join("") : ""));
console.log("source messages:", texts);
const plan = planForkSessions(ir);
console.log(
  "main path texts:",
  plan.main.items
    .filter((i) => i.type === "message")
    .map((i) => (i.type === "message" ? i.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "")),
);
console.log("forks:", plan.forks.map((f) => f.ir.header.session.title));

const r = await migrate({
  source: wb,
  target: mimo,
  workdir: path.join(SB, "workdir"),
  filter: { ids: [sid] },
  overwrite: true,
  backupPaths: [dbPath],
});
console.log(formatReport(r));
if (r.failed) process.exit(1);

const sessions = await mimo.listSessions();
console.log(
  "mimo sessions:",
  sessions.map((s) => ({ id: s.id, title: s.title, parent: s.meta })),
);
const main = sessions.find((s) => s.title === "ForkDemo");
const fork = sessions.find((s) => (s.title || "").includes("fork"));
console.log("titles", sessions.map((s) => s.title));
if (!main) throw new Error("main session missing");
if (!fork) throw new Error("fork session missing — 分叉未写入");

// 读回 parentID 链
const db2 = new DatabaseSync(mimoDb, { readOnly: true });
const rows = db2
  .prepare(
    `SELECT m.id, m.data, m.session_id FROM message m WHERE m.session_id IN (?, ?) ORDER BY m.time_created`,
  )
  .all(main.id, fork.id);
db2.close();
let withParent = 0;
for (const row of rows) {
  const d = JSON.parse(row.data);
  if (d.parentID) withParent++;
}
console.log("messages", rows.length, "with parentID", withParent);
if (withParent < 2) throw new Error("parentID 链不完整");
console.log("✅ fork E2E 通过：主链 + fork 会话 + parentID");
