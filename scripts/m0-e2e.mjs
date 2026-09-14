/**
 * M0 沙箱 E2E：领慧 ↔ Claude Code 双向迁移验证
 * 使用 fixtures + 拷贝的真实库，不碰线上数据。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SANDBOX = path.join(ROOT, "sandbox-m0");

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function setupSandbox() {
  rmrf(SANDBOX);
  fs.mkdirSync(SANDBOX, { recursive: true });

  // --- alink sandbox ---
  const alinkRoot = path.join(SANDBOX, "alink");
  const alinkMsg = path.join(alinkRoot, "user", "messages");
  fs.mkdirSync(alinkMsg, { recursive: true });
  const srcDb = path.join(
    process.env.APPDATA,
    "alink",
    "messages_tc032353_PROD.sqlite",
  );
  const alinkDb = path.join(alinkRoot, "messages_tc032353_PROD.sqlite");
  fs.copyFileSync(srcDb, alinkDb);
  for (const ext of ["-wal", "-shm"]) {
    const s = srcDb + ext;
    if (fs.existsSync(s)) fs.copyFileSync(s, alinkDb + ext);
  }
  // pick one real session jsonl
  const sampleId = "00609438-b872-4963-9873-21bd09140c04";
  const srcJsonl = path.join(
    process.env.APPDATA,
    "alink",
    "user",
    "messages",
    `${sampleId}.jsonl`,
  );
  if (fs.existsSync(srcJsonl)) {
    fs.copyFileSync(srcJsonl, path.join(alinkMsg, `${sampleId}.jsonl`));
  }

  // --- claude-code sandbox ---
  const ccRoot = path.join(SANDBOX, "claude-projects");
  const proj = path.join(ccRoot, "D--SessionHarborSandbox");
  fs.mkdirSync(proj, { recursive: true });
  // use a small fixture as source for CC→alink
  const fixture = path.join(ROOT, "fixtures", "claude-code", "026b2f92-a89e-43d1-88cf-fd94b0072edd.jsonl");
  if (fs.existsSync(fixture)) {
    fs.copyFileSync(fixture, path.join(proj, "026b2f92-a89e-43d1-88cf-fd94b0072edd.jsonl"));
  }

  return {
    alinkDb,
    alinkMsg,
    ccRoot,
    sampleId,
    ccSampleId: "026b2f92-a89e-43d1-88cf-fd94b0072edd",
  };
}

async function run() {
  const { createAlinkAdapter } = await import(
    pathToFileURL(path.join(ROOT, "packages/adapters/alink/dist/index.js")).href
  );
  const { createClaudeCodeAdapter } = await import(
    pathToFileURL(path.join(ROOT, "packages/adapters/claude-code/dist/index.js")).href
  );
  const { migrate, formatReport } = await import(
    pathToFileURL(path.join(ROOT, "packages/core/dist/index.js")).href
  );

  const sb = setupSandbox();
  const workdir = path.join(SANDBOX, "workdir");

  const alink = createAlinkAdapter({
    id: "alink",
    dataRoot: path.dirname(sb.alinkDb),
    primaryDb: sb.alinkDb,
    jsonlDir: sb.alinkMsg,
    extraDbs: [],
  });
  const cc = createClaudeCodeAdapter({
    id: "claude-code",
    dataRoot: path.dirname(sb.ccRoot),
    projectsRoot: sb.ccRoot,
    extraDbs: [],
  });

  console.log("=== 1) alink → claude-code ===");
  const r1 = await migrate({
    source: alink,
    target: cc,
    workdir,
    filter: { ids: [sb.sampleId] },
    overwrite: true,
    backupPaths: [sb.alinkDb],
  });
  console.log(formatReport(r1));
  if (r1.failed > 0) throw new Error("alink→cc 失败");

  // verify CC output
  const outDir = path.join(sb.ccRoot, "D--mimo");
  const outFile = path.join(outDir, `${sb.sampleId}.jsonl`);
  if (!fs.existsSync(outFile)) {
    // cwd may encode differently
    const found = [];
    for (const d of fs.readdirSync(sb.ccRoot)) {
      const f = path.join(sb.ccRoot, d, `${sb.sampleId}.jsonl`);
      if (fs.existsSync(f)) found.push(f);
    }
    if (!found.length) throw new Error("未找到迁入 Claude Code 的 jsonl");
    console.log("CC 落盘:", found[0]);
    assertCcJsonl(found[0]);
  } else {
    console.log("CC 落盘:", outFile);
    assertCcJsonl(outFile);
  }

  console.log("\n=== 2) claude-code → alink ===");
  const r2 = await migrate({
    source: cc,
    target: alink,
    workdir,
    filter: { ids: [sb.ccSampleId] },
    overwrite: true,
    backupPaths: [sb.alinkDb],
  });
  console.log(formatReport(r2));
  if (r2.failed > 0) throw new Error("cc→alink 失败");

  const inJsonl = path.join(sb.alinkMsg, `${sb.ccSampleId}.jsonl`);
  if (!fs.existsSync(inJsonl)) {
    // maybe uuid remapped
    const files = fs.readdirSync(sb.alinkMsg).filter((f) => f !== `${sb.sampleId}.jsonl`);
    console.log("alink messages 目录:", files);
    const newOne = files.find((f) => f.endsWith(".jsonl"));
    if (!newOne) throw new Error("未找到写入 alink 的 jsonl");
    assertAlinkJsonl(path.join(sb.alinkMsg, newOne));
  } else {
    console.log("alink 落盘:", inJsonl);
    assertAlinkJsonl(inJsonl);
  }

  // verify DB row
  const db = new DatabaseSync(sb.alinkDb, { readOnly: true });
  const rows = db.prepare(`SELECT sessionId, name, cwd, agentEngine FROM alink_session`).all();
  console.log(`\nalink_session 行数: ${rows.length}`);
  const last = rows.slice(-3);
  for (const r of last) console.log(" ", r);
  db.close();

  console.log("\n✅ M0 沙箱双向迁移验证通过");
  console.log("沙箱目录:", SANDBOX);
}

function assertCcJsonl(file) {
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error("CC jsonl 为空");
  let users = 0;
  let assistants = 0;
  let parentOk = 0;
  let prevUuid = null;
  for (const line of lines) {
    const o = JSON.parse(line);
    if (o.type === "user") users++;
    if (o.type === "assistant") assistants++;
    if (o.parentUuid === prevUuid) parentOk++;
    if (o.uuid) prevUuid = o.uuid;
    if (o.type === "user" && typeof o.message?.content !== "string") {
      throw new Error("user content 应为字符串");
    }
  }
  console.log(`  CC 行数=${lines.length} user=${users} assistant=${assistants} parent链=${parentOk}`);
  if (users < 1 || assistants < 1) throw new Error("CC 消息不完整");
}

function assertAlinkJsonl(file) {
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
  const first = JSON.parse(lines[0]);
  if (first.type !== "system" || first.data?.subtype !== "init") {
    throw new Error("alink 首行应为 system/init 信封");
  }
  if (!first.sessionId || !first.timestamp) throw new Error("alink 信封缺字段");
  let prompts = 0;
  let assistants = 0;
  for (const line of lines) {
    const o = JSON.parse(line);
    if (!("type" in o) || !("sessionId" in o) || !("timestamp" in o) || !("data" in o)) {
      throw new Error("alink 行缺信封字段");
    }
    if (o.type === "prompt") prompts++;
    if (o.type === "assistant") assistants++;
  }
  console.log(`  alink 行数=${lines.length} prompt=${prompts} assistant=${assistants}`);
  if (prompts < 1 || assistants < 1) throw new Error("alink 消息不完整");
}

run().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
