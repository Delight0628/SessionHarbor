import { app, BrowserWindow, ipcMain, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  SessionIndex,
  SessionWatcher,
  defaultIndexPath,
  discoverAlink,
  discoverClaudeCode,
  discoverWorkbuddy,
  formatReport,
  migrate,
  toHtml,
  toMarkdown,
  watchDirsFor,
  syncToCloud,
  pushToCloud,
  pullFromCloud,
  formatSyncResult,
  loadOrCreateSyncConfig,
  saveSyncConfig,
  resolveTarget,
  listCloudSessions,
  planDisplay,
  formatPricing,
  type ClientPathsLike,
  type FilterSpec,
} from "@sessionharbor/core";
import { createAlinkAdapter } from "@sessionharbor/adapter-alink";
import { createClaudeCodeAdapter } from "@sessionharbor/adapter-claude-code";
import { createWorkbuddyAdapter } from "@sessionharbor/adapter-workbuddy";
import { createCodexAdapter, discoverCodex } from "@sessionharbor/adapter-codex";
import { createMimoAdapter, discoverMimo } from "@sessionharbor/adapter-mimo";
import {
  createDeepseekHarnessAdapter,
  discoverDsh,
} from "@sessionharbor/adapter-deepseek-harness";
import { createDevinAdapter, discoverDevin } from "@sessionharbor/adapter-devin";
import { createTraeSoloAdapter, discoverTrae } from "@sessionharbor/adapter-trae-solo";
import { createCursorAdapter, discoverCursor } from "@sessionharbor/adapter-cursor";
import { createVsCodeAdapter, discoverVsCode } from "@sessionharbor/adapter-vscode";
import { createHermesAdapter, discoverHermes } from "@sessionharbor/adapter-hermes";
import { createOpenClawAdapter, discoverOpenClaw } from "@sessionharbor/adapter-openclaw";
import {
  createChatGptExportAdapter,
  discoverChatGptExport,
} from "@sessionharbor/adapter-chatgpt-export";

/**
 * 应用资源根目录：
 * - 打包后: .../resources/app.asar
 * - 开发时: apps/desktop
 * 不用 import.meta/__dirname，兼容 tsc ESM 与 esbuild CJS 打包。
 */
function appRoot(): string {
  try {
    const p = app.getAppPath();
    if (p) return p;
  } catch {
    /* app 未就绪时 */
  }
  // 回退：相对 cwd 或已知布局
  const candidates = [
    process.cwd(),
    path.join(process.cwd(), "apps", "desktop"),
    path.dirname(path.dirname(process.argv[1] || "")),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "package.json"))) return c;
  }
  return process.cwd();
}
const WORKDIR = process.env.HARBOR_WORKDIR || process.cwd();

/** 默认 Supabase（个人项目 Delight0628）；仅写入本机配置，勿提交仓库 */
const DEFAULT_SUPABASE_URL =
  process.env.HARBOR_DEFAULT_DATABASE_URL ||
  "postgresql://postgres.hnrvuzgljxwixspbwgaw:ggxqq2607101627@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres";

/** 启动时若无 cloud 配置则自动写入（等同 setup-supabase.ps1） */
function ensureCloudSetup(): void {
  try {
    const dir = path.join(WORKDIR, ".sessionharbor");
    const envFile = path.join(dir, "cloud.env");
    const syncDir = path.join(dir, "sync");
    const syncFile = path.join(syncDir, "config.json");
    fs.mkdirSync(syncDir, { recursive: true });
    if (!fs.existsSync(envFile) && DEFAULT_SUPABASE_URL) {
      fs.writeFileSync(
        envFile,
        [
          `DATABASE_URL=${DEFAULT_SUPABASE_URL}`,
          "HARBOR_CLOUD_PG_SSL_INSECURE=1",
          "HARBOR_CLOUD_ADMIN_TOKEN=admin-delight-0628",
          "HARBOR_CLOUD_MAIL=console",
          "HARBOR_CLOUD_PORT=8787",
          "",
        ].join("\n"),
        "utf8",
      );
    }
    const cfg = loadOrCreateSyncConfig(WORKDIR);
    let changed = false;
    if (DEFAULT_SUPABASE_URL && !(cfg as { databaseUrl?: string }).databaseUrl) {
      (cfg as { databaseUrl?: string }).databaseUrl = DEFAULT_SUPABASE_URL;
      changed = true;
    }
    if (cfg.targetKind !== "hosted" || !cfg.hostedEndpoint) {
      cfg.targetKind = "hosted";
      cfg.hostedEndpoint = "http://127.0.0.1:8787";
      changed = true;
    }
    if (changed) saveSyncConfig(WORKDIR, cfg);
  } catch (e) {
    console.error("ensureCloudSetup", e);
  }
}

/** 内嵌托管云：启动时若配置了 DATABASE_URL / cloud.env 则自动拉起 cloud-server */
let cloudChild: ChildProcess | null = null;

function cloudServerEntry(): string | null {
  const candidates = [
    path.join(WORKDIR, "packages", "cloud-server", "dist", "server.js"),
    path.join(appRoot(), "packages", "cloud-server", "dist", "server.js"),
    path.join(appRoot(), "cloud-server", "server.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function readCloudEnvFile(): Record<string, string> {
  const p = path.join(WORKDIR, ".sessionharbor", "cloud.env");
  if (!fs.existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

async function startEmbeddedCloud(): Promise<void> {
  const entry = cloudServerEntry();
  if (!entry) return;
  const envFile = readCloudEnvFile();
  const cfg = loadOrCreateSyncConfig(WORKDIR);
  const databaseUrl =
    process.env.DATABASE_URL ||
    envFile.DATABASE_URL ||
    (cfg as { databaseUrl?: string }).databaseUrl ||
    "";
  // 无云库配置则不启内嵌服务
  if (!databaseUrl && !envFile.HARBOR_CLOUD_DATA && !(cfg as { cloudRoot?: string }).cloudRoot) {
    // 仍允许本地 SQLite 云（方便内网）
    if (!envFile.HARBOR_CLOUD_PORT && !process.env.HARBOR_CLOUD_FORCE_EMBEDDED) return;
  }
  const port = String(
    process.env.HARBOR_CLOUD_PORT || envFile.HARBOR_CLOUD_PORT || "8787",
  );
  const env = {
    ...process.env,
    ...envFile,
    PORT: port,
    HARBOR_CLOUD_PORT: port,
    DATABASE_URL: databaseUrl || envFile.DATABASE_URL || "",
    HARBOR_CLOUD_PG_SSL_INSECURE:
      process.env.HARBOR_CLOUD_PG_SSL_INSECURE ||
      envFile.HARBOR_CLOUD_PG_SSL_INSECURE ||
      "1",
    HARBOR_CLOUD_ADMIN_TOKEN:
      process.env.HARBOR_CLOUD_ADMIN_TOKEN ||
      envFile.HARBOR_CLOUD_ADMIN_TOKEN ||
      "harbor-local-admin",
    HARBOR_CLOUD_MAIL: process.env.HARBOR_CLOUD_MAIL || envFile.HARBOR_CLOUD_MAIL || "console",
    HARBOR_CLOUD_DATA:
      process.env.HARBOR_CLOUD_DATA ||
      envFile.HARBOR_CLOUD_DATA ||
      path.join(WORKDIR, ".sessionharbor", "cloud-data"),
  };
  if (env.DATABASE_URL) {
    // 写回 sync 配置，GUI/CLI 统一 endpoint
    const cfg2 = loadOrCreateSyncConfig(WORKDIR);
    cfg2.targetKind = "hosted";
    cfg2.hostedEndpoint = `http://127.0.0.1:${port}`;
    (cfg2 as { databaseUrl?: string }).databaseUrl = env.DATABASE_URL;
    if (!cfg2.license) {
      cfg2.license = {
        plan: "free",
        hostedEndpoint: cfg2.hostedEndpoint,
        expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
      };
    }
    saveSyncConfig(WORKDIR, cfg2);
  }
  cloudChild = spawn(process.execPath, [entry], {
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  const logDir = path.join(WORKDIR, "logs");
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "cloud-embed.log");
    cloudChild.stdout?.on("data", (d) => {
      try {
        fs.appendFileSync(logPath, String(d));
      } catch {
        /* ignore */
      }
    });
    cloudChild.stderr?.on("data", (d) => {
      try {
        fs.appendFileSync(logPath, String(d));
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
  cloudChild.on("exit", (code) => {
    console.log("embedded cloud-server exit", code);
    cloudChild = null;
  });
}

type ClientId =
  | "alink"
  | "claude-code"
  | "workbuddy"
  | "codex"
  | "mimo"
  | "deepseek-harness"
  | "devin"
  | "trae-solo"
  | "cursor"
  | "vscode"
  | "hermes"
  | "openclaw"
  | "chatgpt-export";
const CLIENTS: ClientId[] = [
  "alink",
  "claude-code",
  "workbuddy",
  "codex",
  "mimo",
  "deepseek-harness",
  "devin",
  "trae-solo",
  "cursor",
  "vscode",
  "hermes",
  "openclaw",
  "chatgpt-export",
];

const CLIENT_META: Array<{
  id: ClientId;
  displayName: string;
  discover: () => ClientPathsLike;
  canWrite?: boolean;
}> = [
  { id: "alink", displayName: "领慧AI工作台", discover: () => discoverAlink() },
  { id: "claude-code", displayName: "Claude Code", discover: () => discoverClaudeCode() },
  { id: "workbuddy", displayName: "WorkBuddy", discover: () => discoverWorkbuddy() },
  { id: "codex", displayName: "Codex", discover: () => discoverCodex() },
  { id: "mimo", displayName: "MiMo Desktop", discover: () => discoverMimo() },
  {
    id: "deepseek-harness",
    displayName: "DeepSeek Harness",
    discover: () => discoverDsh(),
    canWrite: false,
  },
  {
    id: "devin",
    displayName: "Devin",
    discover: () => discoverDevin(),
    canWrite: false,
  },
  {
    id: "trae-solo",
    displayName: "Trae",
    discover: () => discoverTrae(),
    canWrite: false,
  },
  {
    id: "cursor",
    displayName: "Cursor",
    discover: () => discoverCursor(),
    canWrite: false,
  },
  {
    id: "vscode",
    displayName: "VS Code",
    discover: () => discoverVsCode(),
    canWrite: false,
  },
  {
    id: "hermes",
    displayName: "Hermes",
    discover: () => discoverHermes(),
    canWrite: false,
  },
  {
    id: "openclaw",
    displayName: "OpenClaw",
    discover: () => discoverOpenClaw(),
    canWrite: false,
  },
  {
    id: "chatgpt-export",
    displayName: "ChatGPT Export",
    discover: () => discoverChatGptExport(process.env.HARBOR_CHATGPT_EXPORT),
    canWrite: false,
  },
];

type Detected = {
  id: string;
  displayName: string;
  installed: boolean;
  canRead: boolean;
  canWrite: boolean;
  info?: string;
  error?: string;
};

function discoverAll(): Detected[] {
  return CLIENT_META.map((c) => {
    try {
      const p = c.discover();
      return {
        id: c.id,
        displayName: c.displayName,
        installed: true,
        canRead: true,
        canWrite: c.canWrite !== false,
        info: [p.primaryDb, p.jsonlDir, p.projectsRoot, p.dataRoot].filter(Boolean).join(" | "),
      };
    } catch (e) {
      return {
        id: c.id,
        displayName: c.displayName,
        installed: false,
        canRead: false,
        canWrite: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
}

function getAdapter(id: ClientId) {
  const meta = CLIENT_META.find((c) => c.id === id);
  if (!meta) throw new Error(`未知客户端: ${id}`);
  let paths: ClientPathsLike;
  try {
    paths = meta.discover();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${meta.displayName} 未安装或数据目录不可用: ${msg}`);
  }
  switch (id) {
    case "alink":
      return createAlinkAdapter(paths as never);
    case "claude-code":
      return createClaudeCodeAdapter(paths);
    case "workbuddy":
      return createWorkbuddyAdapter(paths);
    case "codex":
      return createCodexAdapter(paths as never);
    case "mimo":
      return createMimoAdapter(paths);
    case "deepseek-harness":
      return createDeepseekHarnessAdapter(paths as never);
    case "devin":
      return createDevinAdapter(paths as never);
    case "trae-solo":
      return createTraeSoloAdapter(paths as never);
    case "cursor":
      return createCursorAdapter(paths as never);
    case "vscode":
      return createVsCodeAdapter(paths as never);
    case "hermes":
      return createHermesAdapter(paths as never);
    case "openclaw":
      return createOpenClawAdapter(paths as never);
    case "chatgpt-export":
      return createChatGptExportAdapter(paths as never);
  }
}

function resolvePreload(): string {
  const root = appRoot();
  const candidates = [
    path.join(root, "dist", "preload.cjs"),
    path.join(root, "src", "preload.cjs"),
    path.join(process.cwd(), "src/preload.cjs"),
    path.join(process.cwd(), "apps/desktop/src/preload.cjs"),
    path.join(process.cwd(), "apps/desktop/dist/preload.cjs"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]!;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "SessionHarbor",
    backgroundColor: "#0f1419",
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const root = appRoot();
  win.loadFile(path.join(root, "renderer", "index.html"));
  return win;
}

ipcMain.handle("harbor:discover", () => discoverAll());

ipcMain.handle("harbor:list", async (_e, client: ClientId, filter?: Partial<FilterSpec>) => {
  const adapter = getAdapter(client);
  const sessions = await adapter.listSessions();
  let out = sessions;
  if (filter?.titles?.length) {
    out = out.filter((s) =>
      filter.titles!.some((t) => (s.title || "").toLowerCase().includes(t.toLowerCase())),
    );
  }
  if (filter?.keyword) {
    const kw = filter.keyword.toLowerCase();
    out = out.filter((s) => (s.title || "").toLowerCase().includes(kw));
  }
  if (filter?.ids?.length) {
    out = out.filter((s) => filter.ids!.some((id) => s.id.startsWith(id)));
  }
  return out.map((s) => ({
    id: s.id,
    title: s.title,
    client,
    messageCount: s.messageCount,
    cwd: s.cwd,
    group: s.group,
    createdAtMs: s.createdAtMs,
    updatedAtMs: s.updatedAtMs,
    model: s.model,
  }));
});

ipcMain.handle("harbor:read", async (_e, client: ClientId, id: string) => {
  const adapter = getAdapter(client);
  const ir = await adapter.readSession(id);
  return {
    session: ir.header.session,
    items: ir.items.map((item) => {
      if (item.type === "message") {
        const text = item.content
          .map((b) => (b.type === "text" || b.type === "thinking" ? b.text : ""))
          .filter(Boolean)
          .join("\n");
        return { type: "message", role: item.role, text, timestamp: item.timestamp };
      }
      if (item.type === "thinking") return { type: "thinking", text: item.text, timestamp: item.timestamp };
      if (item.type === "tool_call")
        return { type: "tool_call", toolName: item.toolName, callId: item.callId, timestamp: item.timestamp };
      if (item.type === "tool_output")
        return { type: "tool_output", output: item.output, isError: item.isError, timestamp: item.timestamp };
      if (item.type === "file_ref") return { type: "file_ref", uri: item.uri };
      return { type: item.type };
    }),
  };
});

ipcMain.handle("harbor:exportHtml", async (_e, client: ClientId, id: string) => {
  const adapter = getAdapter(client);
  const ir = await adapter.readSession(id);
  return toHtml(ir);
});

ipcMain.handle("harbor:scan", async (_e, client: ClientId | "all") => {
  const indexPath = defaultIndexPath(WORKDIR);
  const index = new SessionIndex(indexPath);
  const detected = discoverAll();
  const installed = new Set(detected.filter((d) => d.installed).map((d) => d.id));
  const clients: ClientId[] =
    client === "all"
      ? (CLIENTS.filter((c) => installed.has(c)) as ClientId[])
      : [client];
  let n = 0;
  const t0 = Date.now();
  index.beginBulkRebuild();
  for (const id of clients) {
    try {
      const adapter = getAdapter(id);
      const sessions = await adapter.listSessions();
      const capped = sessions.slice(0, client === "all" ? SCAN_SESSION_CAP : sessions.length);
      for (const s of capped) {
        try {
          index.upsertIR(await adapter.readSession(s.id));
          n++;
        } catch {
          /* skip */
        }
        if (n % 50 === 0) {
          index.commit();
          index.begin();
        }
      }
    } catch (e) {
      console.error(e);
    }
  }
  index.endBulkRebuild();
  const ms = Date.now() - t0;
  const total = index.count();
  index.close();
  return { indexed: n, total, ms, indexPath, clients };
});

ipcMain.handle("harbor:search", (_e, q: string, limit = 20) => {
  const indexPath = defaultIndexPath(WORKDIR);
  if (!fs.existsSync(indexPath)) return { error: "索引不存在，请先扫描", hits: [] };
  const index = new SessionIndex(indexPath);
  const t0 = Date.now();
  const hits = index.search(q, { limit });
  const ms = Date.now() - t0;
  index.close();
  return { hits, ms };
});

ipcMain.handle(
  "harbor:migrate",
  async (
    _e,
    opts: {
      from: ClientId;
      to: ClientId;
      ids?: string[];
      titles?: string[];
      dryRun?: boolean;
      overwrite?: boolean;
      yes?: boolean;
    },
  ) => {
    if (!opts.dryRun && !opts.yes) {
      return { error: "写入迁移需要确认 yes" };
    }
    const source = getAdapter(opts.from);
    const target = getAdapter(opts.to);
    const report = await migrate({
      source,
      target,
      workdir: WORKDIR,
      filter: { ids: opts.ids, titles: opts.titles },
      dryRun: opts.dryRun,
      overwrite: opts.overwrite,
      backupPaths: collectBackupPaths(opts.from, opts.to),
    });
    return { report, text: formatReport(report) };
  },
);

function collectBackupPaths(...clients: ClientId[]): string[] {
  const out: string[] = [];
  for (const c of clients) {
    try {
      const p = getAdapter(c).discover() as ClientPathsLike;
      if (p.primaryDb) out.push(p.primaryDb);
    } catch {
      /* ignore */
    }
  }
  return out;
}

let activeWatcher: SessionWatcher | null = null;

ipcMain.handle("harbor:exportMd", async (_e, client: ClientId, id: string) => {
  const ir = await getAdapter(client).readSession(id);
  const md = toMarkdown(ir);
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: `${id}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (canceled || !filePath) return { canceled: true };
  fs.writeFileSync(filePath, md, "utf-8");
  return { canceled: false, filePath };
});

ipcMain.handle("harbor:watchStart", () => {
  if (activeWatcher) return { ok: true, already: true };
  const index = new SessionIndex(defaultIndexPath(WORKDIR));
  const events: string[] = [];
  activeWatcher = new SessionWatcher({
    debounceMs: 600,
    onEvent: async (e) => {
      events.push(`${e.kind} ${path.basename(e.file)}`);
      try {
        const adapter = getAdapter(e.clientId as ClientId);
        const id = path.basename(e.file).replace(/\.(jsonl|sqlite|db)$/i, "");
        const ir = await adapter.readSession(id);
        index.upsertIR(ir);
      } catch {
        /* skip incomplete */
      }
    },
  });
  for (const id of CLIENTS) {
    if (id === "chatgpt-export") continue;
    try {
      const p = getAdapter(id).discover() as ClientPathsLike & {
        sessionsRoot?: string;
      };
      for (const dir of watchDirsFor(p)) {
        activeWatcher.watch({ id, dir });
      }
    } catch {
      /* skip */
    }
  }
  return { ok: true };
});

ipcMain.handle("harbor:watchStop", () => {
  activeWatcher?.close();
  activeWatcher = null;
  return { ok: true };
});

function cloudBase(): string {
  const cfg = loadOrCreateSyncConfig(WORKDIR);
  const ep =
    cfg.hostedEndpoint ||
    process.env.HARBOR_CLOUD_URL ||
    "http://127.0.0.1:8787";
  return String(ep).replace(/\/+$/, "");
}

ipcMain.handle(
  "harbor:cloudAuth",
  async (
    _e,
    opts: {
      action: "register" | "login" | "verify" | "me" | "logout";
      endpoint?: string;
      email?: string;
      password?: string;
      code?: string;
    },
  ) => {
    const wd = WORKDIR;
    const cfg = loadOrCreateSyncConfig(wd);
    const base = (opts.endpoint || cloudBase()).replace(/\/+$/, "");
    try {
      if (opts.action === "register" || opts.action === "login") {
        if (!opts.email || !opts.password) return { error: "需要邮箱和密码" };
        const res = await fetch(`${base}/v1/auth/${opts.action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: opts.email, password: opts.password }),
        });
        const body = (await res.json()) as {
          error?: string;
          token?: string;
          userId?: string;
          plan?: string;
          emailVerified?: boolean;
          verifyCode?: string;
        };
        if (!res.ok || !body.token) return { error: body.error || String(res.status) };
        cfg.targetKind = "hosted";
        cfg.hostedEndpoint = base;
        cfg.hostedToken = body.token;
        cfg.license = {
          plan: (body.plan as "free" | "pro" | "team") || "free",
          accountId: body.userId,
          hostedEndpoint: base,
          expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
        };
        saveSyncConfig(wd, cfg);
        return {
          ok: true,
          email: opts.email,
          userId: body.userId,
          plan: body.plan,
          emailVerified: body.emailVerified,
          verifyCode: body.verifyCode,
          endpoint: base,
        };
      }
      if (opts.action === "verify") {
        if (!opts.email || !opts.code) return { error: "需要邮箱和验证码" };
        const res = await fetch(`${base}/v1/auth/verify-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: opts.email, code: opts.code }),
        });
        const body = (await res.json()) as { error?: string; token?: string };
        if (!res.ok) return { error: body.error || String(res.status) };
        cfg.hostedEndpoint = base;
        if (body.token) cfg.hostedToken = body.token;
        saveSyncConfig(wd, cfg);
        return { ok: true, emailVerified: true };
      }
      if (opts.action === "logout") {
        if (cfg.hostedToken) {
          try {
            await fetch(`${base}/v1/auth/logout`, {
              method: "POST",
              headers: { Authorization: `Bearer ${cfg.hostedToken}` },
            });
          } catch {
            /* ignore */
          }
        }
        delete cfg.hostedToken;
        cfg.license = undefined;
        saveSyncConfig(wd, cfg);
        return { ok: true };
      }
      // me
      if (!cfg.hostedToken || !cfg.hostedEndpoint) {
        return { loggedIn: false, endpoint: base };
      }
      const res = await fetch(`${cfg.hostedEndpoint}/v1/auth/me`, {
        headers: { Authorization: `Bearer ${cfg.hostedToken}` },
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return { loggedIn: false, endpoint: cfg.hostedEndpoint, error: "token 无效，请重新登录" };
      }
      return {
        loggedIn: true,
        endpoint: cfg.hostedEndpoint,
        email: body.email,
        userId: body.userId,
        plan: body.plan,
        usage: body.usage,
        quota: body.quota,
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
);

ipcMain.handle(
  "harbor:sync",
  async (
    _e,
    opts: {
      direction?: "push" | "pull";
      scope: "client" | "group" | "session" | "all";
      client?: string;
      group?: string;
      sessionId?: string;
      cloudRoot?: string;
      restoreTo?: ClientId;
      overwrite?: boolean;
      dryRun?: boolean;
    },
  ) => {
    const cfg = loadOrCreateSyncConfig(WORKDIR);
    const target = resolveTarget(cfg, WORKDIR, opts.cloudRoot);
    const targetLabel =
      target.kind === "directory"
        ? target.root
        : target.kind === "webdav"
          ? target.baseUrl
          : target.endpoint;
    const filter = {
      scope: opts.scope,
      client: opts.client,
      group: opts.group,
      sessionId: opts.sessionId,
    };
    if (opts.direction === "pull") {
      const restoreTo = opts.restoreTo ? getAdapter(opts.restoreTo) : undefined;
      const report = await pullFromCloud({
        target,
        filter,
        passphrase: cfg.passphrase,
        workdir: WORKDIR,
        restoreTo,
        overwrite: opts.overwrite,
        dryRun: opts.dryRun,
      });
      return {
        report,
        text: formatSyncResult(report),
        cloudRoot: targetLabel,
        direction: "pull",
      };
    }
    const adapters = [];
    for (const id of CLIENTS) {
      try {
        adapters.push(getAdapter(id));
      } catch {
        /* skip */
      }
    }
    const report = await pushToCloud({
      adapters,
      target,
      filter,
      passphrase: cfg.passphrase,
      workdir: WORKDIR,
      dryRun: opts.dryRun,
      license: cfg.license,
    });
    return {
      report,
      text: formatSyncResult(report),
      cloudRoot: targetLabel,
      direction: "push",
      plan: planDisplay(cfg.license),
    };
  },
);

/** 单客户端自动/全量扫描上限，避免 Cursor 等超大库拖死启动 */
const SCAN_SESSION_CAP = 150;

/** 启动后自动扫描已安装客户端的会话库，不阻塞窗口创建 */
async function autoScanInstalled(): Promise<void> {
  try {
    const detected = discoverAll().filter((d) => d.installed && d.id !== "chatgpt-export");
    if (!detected.length) return;
    const indexPath = defaultIndexPath(WORKDIR);
    const index = new SessionIndex(indexPath);
    let n = 0;
    index.beginBulkRebuild();
    for (const d of detected) {
      try {
        const adapter = getAdapter(d.id as ClientId);
        const sessions = await adapter.listSessions();
        const capped = sessions.slice(0, SCAN_SESSION_CAP);
        if (sessions.length > capped.length) {
          console.log(`auto-scan ${d.id}: cap ${capped.length}/${sessions.length}`);
        }
        for (const s of capped) {
          try {
            index.upsertIR(await adapter.readSession(s.id));
            n++;
          } catch {
            /* skip */
          }
          if (n % 50 === 0) {
            index.commit();
            index.begin();
          }
        }
      } catch (e) {
        console.error(`auto-scan ${d.id} failed:`, e);
      }
    }
    index.endBulkRebuild();
    index.close();
    console.log(`auto-scan indexed ${n} sessions from ${detected.length} clients`);
  } catch (e) {
    console.error("auto-scan failed:", e);
  }
}

app.whenReady().then(() => {
  ensureCloudSetup();
  void startEmbeddedCloud();
  const win = createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // 首窗就绪后自动探测+扫描；结果推给渲染层
  win.webContents.once("did-finish-load", () => {
    void autoScanInstalled().then(() => {
      try {
        const detected = discoverAll();
        win.webContents.send("harbor:autoScanDone", {
          installed: detected.filter((d) => d.installed).length,
          clients: detected.filter((d) => d.installed).map((d) => d.id),
        });
      } catch {
        /* ignore */
      }
    });
  });
});

app.on("before-quit", () => {
  try {
    cloudChild?.kill();
  } catch {
    /* ignore */
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
