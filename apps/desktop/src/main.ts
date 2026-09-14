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
  type ClientPathsLike,
  type FilterSpec,
} from "@sessionharbor/core";
import { createAlinkAdapter } from "@sessionharbor/adapter-alink";
import { createClaudeCodeAdapter } from "@sessionharbor/adapter-claude-code";
import { createWorkbuddyAdapter } from "@sessionharbor/adapter-workbuddy";
import { createCodexAdapter, discoverCodex } from "@sessionharbor/adapter-codex";
import { createMimoAdapter, discoverMimo } from "@sessionharbor/adapter-mimo";
import {
  createChatGptExportAdapter,
  discoverChatGptExport,
} from "@sessionharbor/adapter-chatgpt-export";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = process.env.HARBOR_WORKDIR || process.cwd();

type ClientId = "alink" | "claude-code" | "workbuddy" | "codex" | "mimo" | "chatgpt-export";
const CLIENTS: ClientId[] = ["alink", "claude-code", "workbuddy", "codex", "mimo", "chatgpt-export"];

function getAdapter(id: ClientId) {
  switch (id) {
    case "alink":
      return createAlinkAdapter(discoverAlink());
    case "claude-code":
      return createClaudeCodeAdapter(discoverClaudeCode());
    case "workbuddy":
      return createWorkbuddyAdapter(discoverWorkbuddy());
    case "codex":
      return createCodexAdapter(discoverCodex());
    case "mimo":
      return createMimoAdapter(discoverMimo());
    case "chatgpt-export":
      return createChatGptExportAdapter(
        discoverChatGptExport(process.env.HARBOR_CHATGPT_EXPORT),
      );
  }
}

function discoverAll(): Array<{ id: string; ok: boolean; info?: string; error?: string }> {
  return CLIENTS.map((id) => {
    try {
      const a = getAdapter(id);
      const p = a.discover() as ClientPathsLike & { sessionsRoot?: string };
      return {
        id,
        ok: true,
        info: [p.primaryDb, p.jsonlDir, p.projectsRoot, p.sessionsRoot].filter(Boolean).join(" | "),
      };
    } catch (e) {
      return { id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
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
  const clients: ClientId[] = client === "all" ? CLIENTS.filter((c) => {
    try {
      getAdapter(c);
      return true;
    } catch {
      return false;
    }
  }) : [client];
  let n = 0;
  const t0 = Date.now();
  for (const id of clients) {
    try {
      const adapter = getAdapter(id);
      const sessions = await adapter.listSessions();
      index.begin();
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
      index.commit();
    } catch (e) {
      index.rollback();
      console.error(e);
    }
  }
  const ms = Date.now() - t0;
  const total = index.count();
  index.close();
  return { indexed: n, total, ms, indexPath };
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

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
