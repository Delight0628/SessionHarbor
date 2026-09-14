/**
 * 综合 E2E：M0（领慧↔CC）+ N1（codex 实写）+ chatgpt-export 导入
 * 沙箱内运行，不碰线上可写目标。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SANDBOX = path.join(ROOT, "sandbox-e2e");

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function setup() {
  rmrf(SANDBOX);
  fs.mkdirSync(SANDBOX, { recursive: true });

  // alink sandbox
  const alinkRoot = path.join(SANDBOX, "alink");
  const alinkMsg = path.join(alinkRoot, "user", "messages");
  fs.mkdirSync(alinkMsg, { recursive: true });
  const srcDb = path.join(process.env.APPDATA, "alink", "messages_tc032353_PROD.sqlite");
  const alinkDb = path.join(alinkRoot, "messages_tc032353_PROD.sqlite");
  fs.copyFileSync(srcDb, alinkDb);
  for (const ext of ["-wal", "-shm"]) {
    if (fs.existsSync(srcDb + ext)) fs.copyFileSync(srcDb + ext, alinkDb + ext);
  }
  const sampleId = "00609438-b872-4963-9873-21bd09140c04";
  const srcJsonl = path.join(process.env.APPDATA, "alink", "user", "messages", `${sampleId}.jsonl`);
  if (fs.existsSync(srcJsonl)) fs.copyFileSync(srcJsonl, path.join(alinkMsg, `${sampleId}.jsonl`));

  // claude-code sandbox
  const ccRoot = path.join(SANDBOX, "claude-projects");
  fs.mkdirSync(path.join(ccRoot, "D--SessionHarborSandbox"), { recursive: true });
  const fixtureCC = path.join(ROOT, "fixtures", "claude-code", "026b2f92-a89e-43d1-88cf-fd94b0072edd.jsonl");
  if (fs.existsSync(fixtureCC)) {
    fs.copyFileSync(fixtureCC, path.join(ccRoot, "D--SessionHarborSandbox", path.basename(fixtureCC)));
  }

  // codex sandbox：拷贝真实 state_5.sqlite + 一个小 rollout
  const codexRoot = path.join(SANDBOX, "codex");
  const codexSessions = path.join(codexRoot, "sessions", "2026", "07", "30");
  fs.mkdirSync(codexSessions, { recursive: true });
  const realCodex = path.join(process.env.USERPROFILE, ".codex");
  const realState = path.join(realCodex, "state_5.sqlite");
  const codexDb = path.join(codexRoot, "state_5.sqlite");
  if (fs.existsSync(realState)) {
    fs.copyFileSync(realState, codexDb);
    for (const ext of ["-wal", "-shm"]) {
      if (fs.existsSync(realState + ext)) fs.copyFileSync(realState + ext, codexDb + ext);
    }
  } else {
    // 空库 + threads 表
    const db = new DatabaseSync(codexDb);
    db.exec(`CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
      source TEXT, model_provider TEXT, cwd TEXT, title TEXT, archived INTEGER DEFAULT 0,
      cli_version TEXT, first_user_message TEXT, model TEXT,
      created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, preview TEXT
    );`);
    db.close();
  }
  const realRollouts = path.join(realCodex, "sessions", "2026", "07", "30");
  if (fs.existsSync(realRollouts)) {
    const small = fs
      .readdirSync(realRollouts)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, s: fs.statSync(path.join(realRollouts, f)).size }))
      .filter((x) => x.s > 1000 && x.s < 2_000_000)
      .sort((a, b) => a.s - b.s)[0];
    if (small) {
      fs.copyFileSync(path.join(realRollouts, small.f), path.join(codexSessions, small.f));
    }
  }

  // chatgpt fixture
  const chatgpt = path.join(ROOT, "fixtures", "chatgpt-export", "conversations.json");

  return {
    alinkDb,
    alinkMsg,
    sampleId,
    ccRoot,
    ccSampleId: "026b2f92-a89e-43d1-88cf-fd94b0072edd",
    codexRoot,
    codexDb,
    codexSessions,
    chatgpt,
  };
}

function assertCC(file) {
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
  let users = 0,
    assistants = 0,
    parentOk = 0,
    prev = null;
  for (const line of lines) {
    const o = JSON.parse(line);
    if (o.type === "user") users++;
    if (o.type === "assistant") assistants++;
    if (o.parentUuid === prev) parentOk++;
    if (o.uuid) prev = o.uuid;
  }
  console.log(`  CC: lines=${lines.length} user=${users} asst=${assistants} parentOk=${parentOk}`);
  if (users < 1 || assistants < 1) throw new Error("CC messages incomplete");
}

function assertAlinkJsonl(file) {
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
  const first = JSON.parse(lines[0]);
  if (first.type !== "system" || first.data?.subtype !== "init") throw new Error("alink envelope missing");
  let prompts = 0,
    assts = 0;
  for (const l of lines) {
    const o = JSON.parse(l);
    if (!("type" in o && "sessionId" in o && "timestamp" in o && "data" in o)) throw new Error("envelope fields");
    if (o.type === "prompt") prompts++;
    if (o.type === "assistant") assts++;
  }
  console.log(`  alink: lines=${lines.length} prompt=${prompts} asst=${assts}`);
  if (prompts < 1 || assts < 1) throw new Error("alink messages incomplete");
}

function assertCodexRollout(file) {
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
  const first = JSON.parse(lines[0]);
  if (first.type !== "session_meta") throw new Error("codex session_meta missing");
  let msgs = 0;
  for (const l of lines) {
    const o = JSON.parse(l);
    if (o.type === "response_item" && o.payload?.type === "message") msgs++;
  }
  const name = path.basename(file);
  if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) throw new Error("bad rollout naming: " + name);
  console.log(`  codex rollout: ${name} lines=${lines.length} messages=${msgs}`);
  if (msgs < 1) throw new Error("codex rollout has no messages");
}

async function run() {
  const { createAlinkAdapter } = await import(
    pathToFileURL(path.join(ROOT, "packages/adapters/alink/dist/index.js")).href
  );
  const { createClaudeCodeAdapter } = await import(
    pathToFileURL(path.join(ROOT, "packages/adapters/claude-code/dist/index.js")).href
  );
  const { createCodexAdapter } = await import(
    pathToFileURL(path.join(ROOT, "packages/adapters/codex/dist/index.js")).href
  );
  const { createChatGptExportAdapter } = await import(
    pathToFileURL(path.join(ROOT, "packages/adapters/chatgpt-export/dist/index.js")).href
  );
  const { migrate, formatReport } = await import(
    pathToFileURL(path.join(ROOT, "packages/core/dist/index.js")).href
  );

  const sb = setup();
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
  const codex = createCodexAdapter({
    id: "codex",
    dataRoot: sb.codexRoot,
    sessionsRoot: path.join(sb.codexRoot, "sessions"),
    primaryDb: sb.codexDb,
    stateDb: sb.codexDb,
    sessionIndex: path.join(sb.codexRoot, "session_index.jsonl"),
    extraDbs: [],
  });
  const chatgpt = createChatGptExportAdapter({
    id: "chatgpt-export",
    dataRoot: path.dirname(sb.chatgpt),
    source: sb.chatgpt,
    extraDbs: [],
  });

  console.log("=== 1) alink → claude-code（M0）===");
  const r1 = await migrate({
    source: alink,
    target: cc,
    workdir,
    filter: { ids: [sb.sampleId] },
    overwrite: true,
    backupPaths: [sb.alinkDb],
  });
  console.log(formatReport(r1));
  if (r1.failed > 0) throw new Error("alink→cc failed");
  const ccOut = path.join(sb.ccRoot, "D--mimo", `${sb.sampleId}.jsonl`);
  const ccFound = fs.existsSync(ccOut)
    ? ccOut
    : fs
        .readdirSync(sb.ccRoot)
        .flatMap((d) => {
          const f = path.join(sb.ccRoot, d, `${sb.sampleId}.jsonl`);
          return fs.existsSync(f) ? [f] : [];
        })[0];
  if (!ccFound) throw new Error("CC output missing");
  assertCC(ccFound);

  console.log("\n=== 2) claude-code → alink（M0）===");
  const r2 = await migrate({
    source: cc,
    target: alink,
    workdir,
    filter: { ids: [sb.ccSampleId] },
    overwrite: true,
    backupPaths: [sb.alinkDb],
  });
  console.log(formatReport(r2));
  if (r2.failed > 0) throw new Error("cc→alink failed");
  const inJsonl = path.join(sb.alinkMsg, `${sb.ccSampleId}.jsonl`);
  let alinkFile = fs.existsSync(inJsonl)
    ? inJsonl
    : (() => {
        const other = fs
          .readdirSync(sb.alinkMsg)
          .find((f) => f.endsWith(".jsonl") && f !== `${sb.sampleId}.jsonl`);
        return other ? path.join(sb.alinkMsg, other) : null;
      })();
  if (!alinkFile) throw new Error("alink jsonl missing");
  assertAlinkJsonl(alinkFile);

  console.log("\n=== 3) alink → codex 实写（N1）===");
  const r3 = await migrate({
    source: alink,
    target: codex,
    workdir,
    filter: { ids: [sb.sampleId] },
    overwrite: true,
    backupPaths: [sb.alinkDb, sb.codexDb],
  });
  console.log(formatReport(r3));
  if (r3.failed > 0) throw new Error("alink→codex failed");
  const written = r3.items.find((i) => i.status === "success");
  const target = written?.detail?.targetPath;
  console.log("  targetPath:", target);
  if (target && fs.existsSync(target)) {
    assertCodexRollout(target);
  } else {
    // fallback walk
    const rollouts = [];
    const walk = (dir, depth = 0) => {
      if (depth > 8) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.name.endsWith(".jsonl") && e.name.startsWith("rollout-")) rollouts.push(full);
      }
    };
    walk(path.join(sb.codexRoot, "sessions"));
    if (!rollouts.length) throw new Error("no codex rollout written");
    assertCodexRollout(rollouts[0]);
  }
  if (written?.detail?.warning) console.log("  warn:", written.detail.warning);
  // threads 行
  const db = new DatabaseSync(sb.codexDb, { readOnly: true });
  const trows = db.prepare(`SELECT COUNT(*) AS n FROM threads`).get();
  console.log(`  threads rows: ${trows.n}`);
  db.close();
  if (!fs.existsSync(path.join(sb.codexRoot, "session_index.jsonl"))) {
    throw new Error("session_index.jsonl missing");
  }
  console.log("  session_index.jsonl ok");

  console.log("\n=== 4) chatgpt-export → alink（导入）===");
  const r4 = await migrate({
    source: chatgpt,
    target: alink,
    workdir,
    limit: 1,
    overwrite: true,
    backupPaths: [sb.alinkDb],
  });
  console.log(formatReport(r4));
  if (r4.failed > 0) throw new Error("chatgpt→alink failed");
  if (r4.success < 1) throw new Error("chatgpt migrate not success");
  // pairing stats in report
  if (!r3.pairing && !r1.pairing) {
    console.log("  (pairing 字段已写入 report，本会话可能无 tool)");
  } else {
    console.log("  pairing:", r1.pairing ?? r3.pairing);
  }

  console.log("\n✅ 综合 E2E 全部通过（M0 + codex 实写 + chatgpt 导入）");
  console.log("沙箱:", SANDBOX);
}

run().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
