import { app, BrowserWindow, ipcMain, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  createChatGptExportAdapter,
  discoverChatGptExport,
} from "@sessionharbor/adapter-chatgpt-export";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.HARBOR_WORKDIR || process.cwd();

type ClientId =
  | "alink"
  | "claude-code"
  | "workbuddy"
  | "codex"
  | "mimo"
  | "deepseek-harness"
  | "devin"
  | "trae-solo"
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
    displayName: "TRAE SOLO CN",
    discover: () => discoverTrae(),
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
  const paths = meta.discover();
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
    case "chatgpt-export":
      return createChatGptExportAdapter(paths as never);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "SessionHarbor",
    backgroundColor: "#0f1419",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "../renderer/index.html"));
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
      for (const s of sessions) {
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

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
