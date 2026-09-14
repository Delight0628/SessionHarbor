/**
 * Trae 系列适配器（Trae / Trae CN / TRAE SOLO CN，只读）
 * 数据根:
 *   %APPDATA%/Trae | Trae CN | TRAE SOLO CN
 * 会话正文:
 *   User/workspaceStorage/<hash>/state.vscdb
 *     ItemTable key = memento/icube-ai-agent-storage
 *     value = { list: [{ sessionId, title, createdAt, updatedAt, messages: [...] }], currentSessionId }
 * 另: global state.vscdb 中 draft:session:* 草稿；ModularData/ai-agent/database.db 非明文
 * 安装目录: D:\Trae 等（仅用于 installed 判定）
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  createHeader,
  extractTextFromContent,
  openRo,
  type Adapter,
  type ClientPathsLike,
  type HarborIR,
  type HarborItem,
  type SessionSummary,
  type WriteResult,
} from "@sessionharbor/core";

type Json = Record<string, unknown>;

export interface TraePaths extends ClientPathsLike {
  /** 各产品数据根（Trae / Trae CN / TRAE SOLO CN） */
  roots: Array<{ brand: string; root: string; stateDb?: string; agentDb?: string }>;
  workspaceStorageDirs: string[];
  installHint?: string;
}

const BRANDS = ["Trae", "Trae CN", "TRAE SOLO CN"] as const;

function firstExisting(cands: string[]): string | undefined {
  for (const p of cands) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

export function discoverTrae(explicitRoot?: string): TraePaths {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

  const roots: TraePaths["roots"] = [];
  const workspaceStorageDirs: string[] = [];

  const tryRoot = (brand: string, root: string) => {
    if (!fs.existsSync(root)) return;
    const resolved = path.resolve(root);
    if (roots.some((r) => r.root === resolved)) return;
    const stateDb = path.join(resolved, "User", "globalStorage", "state.vscdb");
    const agentDb = path.join(resolved, "ModularData", "ai-agent", "database.db");
    const ws = path.join(resolved, "User", "workspaceStorage");
    roots.push({
      brand,
      root: resolved,
      stateDb: fs.existsSync(stateDb) ? stateDb : undefined,
      agentDb: fs.existsSync(agentDb) ? agentDb : undefined,
    });
    if (fs.existsSync(ws) && !workspaceStorageDirs.includes(ws)) {
      workspaceStorageDirs.push(ws);
    }
  };

  if (explicitRoot) {
    const r = path.resolve(explicitRoot);
    tryRoot(path.basename(r), r);
  }
  for (const b of BRANDS) {
    tryRoot(b, path.join(appData, b));
    tryRoot(b, path.join(home, "AppData", "Roaming", b));
  }

  if (!roots.length) {
    throw new Error(
      "未找到 Trae 数据目录（APPDATA/Trae 或 Trae CN 或 TRAE SOLO CN）",
    );
  }

  const primary = roots.find((r) => r.stateDb) ?? roots[0]!;
  const installHint = firstExisting([
    "D:\\Trae\\Trae.exe",
    "C:\\Trae\\Trae.exe",
    path.join(home, "AppData", "Local", "Programs", "Trae", "Trae.exe"),
  ]);

  return {
    id: "trae-solo",
    dataRoot: primary.root,
    primaryDb: primary.stateDb,
    roots,
    workspaceStorageDirs,
    installHint,
    extraDbs: [...new Set(roots.map((r) => r.stateDb).filter(Boolean))] as string[],
  };
}

function decodeValue(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  if (typeof v === "object" && (v as Json).type === "Buffer" && Array.isArray((v as Json).data)) {
    const buf = Buffer.from((v as { data: number[] }).data);
    const s = buf.toString("utf-8");
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return v;
}

function folderFromWorkspaceJson(wsDir: string): string | undefined {
  try {
    const p = path.join(wsDir, "workspace.json");
    if (!fs.existsSync(p)) return undefined;
    const meta = JSON.parse(fs.readFileSync(p, "utf-8")) as Json;
    const folder = typeof meta.folder === "string" ? meta.folder : undefined;
    if (!folder) return undefined;
    return decodeURIComponent(folder.replace(/^file:\/\/\//i, ""));
  } catch {
    return undefined;
  }
}

interface TraeMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
  modelInfo?: Json;
  agentTaskContent?: Json;
  agentName?: string;
  agentType?: string;
}

interface TraeSessionRecord {
  sessionId: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messages?: TraeMessage[];
  cwd?: string;
  brand?: string;
  wsDir?: string;
}

function extractAssistantText(m: TraeMessage): { text: string; thinking: string } {
  let text = "";
  if (typeof m.content === "string" && m.content.trim()) text = m.content.trim();
  else if (m.content != null) text = extractTextFromContent(m.content);

  let thinking = "";
  const task = m.agentTaskContent;
  if (task && typeof task === "object") {
    const proposal = (task as Json).proposal;
    const reasoning = (task as Json).proposalReasoningContent;
    if (typeof proposal === "string" && proposal.trim()) {
      text = text ? `${text}\n${proposal.trim()}` : proposal.trim();
    }
    if (typeof reasoning === "string" && reasoning.trim()) {
      thinking = reasoning.trim();
    }
  }
  return { text, thinking };
}

export class TraeSoloAdapter implements Adapter {
  id = "trae-solo";
  displayName = "Trae";
  capabilities = { read: true, write: false, incremental: false, live: false };
  private paths?: TraePaths;
  private sessionIndex = new Map<string, TraeSessionRecord>();

  constructor(paths?: TraePaths) {
    this.paths = paths;
  }

  discover(): TraePaths {
    if (!this.paths) this.paths = discoverTrae();
    return this.paths;
  }

  private ensure(): TraePaths {
    return (this.paths ?? this.discover()) as TraePaths;
  }

  private loadWorkspaceSessions(wsDir: string): TraeSessionRecord[] {
    const dbPath = path.join(wsDir, "state.vscdb");
    if (!fs.existsSync(dbPath)) return [];
    const cwd = folderFromWorkspaceJson(wsDir);
    const brandFromPath = (): string => {
      const p = wsDir.toLowerCase();
      if (p.includes("trae solo")) return "TRAE SOLO CN";
      if (p.includes("trae cn")) return "Trae CN";
      return "Trae";
    };
    let db: ReturnType<typeof openRo>;
    try {
      db = openRo(dbPath);
    } catch {
      return [];
    }
    const out: TraeSessionRecord[] = [];
    try {
      const row = db
        .prepare(`SELECT value FROM ItemTable WHERE key = 'memento/icube-ai-agent-storage'`)
        .get() as { value?: unknown } | undefined;
      if (row?.value == null) return out;
      const d = decodeValue(row.value) as Json | undefined;
      const list = (d?.list ?? []) as TraeSessionRecord[];
      for (const s of list) {
        if (!s?.sessionId) continue;
        out.push({
          ...s,
          cwd,
          brand: brandFromPath(),
          wsDir,
        });
      }
      // 补充：input-history 里有标题但 storage 空时，用历史提示词作标题
      if (!out.length) {
        const hist = db
          .prepare(`SELECT value FROM ItemTable WHERE key = 'icube-ai-agent-storage-input-history'`)
          .get() as { value?: unknown } | undefined;
        if (hist?.value != null) {
          const arr = decodeValue(hist.value) as Array<{ inputText?: string }> | undefined;
          if (Array.isArray(arr) && arr.length) {
            const first = arr.find((x) => x?.inputText)?.inputText;
            if (first) {
              out.push({
                sessionId: `history-${path.basename(wsDir)}`,
                title: first.slice(0, 120),
                messages: arr.map((x) => ({
                  role: "user",
                  content: x.inputText ?? "",
                })),
                cwd,
                brand: brandFromPath(),
                wsDir,
              });
            }
          }
        }
      }
    } catch {
      /* ignore corrupt workspace */
    } finally {
      db.close();
    }
    return out;
  }

  private loadDrafts(stateDb: string): TraeSessionRecord[] {
    if (!fs.existsSync(stateDb)) return [];
    let db: ReturnType<typeof openRo>;
    try {
      db = openRo(stateDb);
    } catch {
      return [];
    }
    const out: TraeSessionRecord[] = [];
    try {
      const rows = db
        .prepare(`SELECT key, value FROM ItemTable`)
        .all() as Array<{ key: string; value: unknown }>;
      const drafts = new Map<string, string>();
      for (const r of rows) {
        const m = /^(?:\d+_?)?draft:session:([0-9a-f]+):/i.exec(r.key);
        if (!m) continue;
        const sid = m[1]!;
        const val = decodeValue(r.value);
        const text =
          typeof val === "string"
            ? val
            : extractTextFromContent(val) || JSON.stringify(val).slice(0, 200);
        drafts.set(sid, (drafts.get(sid) || "") + "\n" + (text || ""));
      }
      for (const [sid, body] of drafts) {
        const title = body.trim().slice(0, 80).replace(/\s+/g, " ") || sid;
        out.push({
          sessionId: sid,
          title,
          messages: [{ role: "user", content: body.trim() }],
          brand: "draft",
        });
      }
    } catch {
      /* ignore */
    } finally {
      db.close();
    }
    return out;
  }

  private collectAll(): TraeSessionRecord[] {
    const p = this.ensure();
    this.sessionIndex.clear();
    const byId = new Map<string, TraeSessionRecord>();
    for (const ws of p.workspaceStorageDirs) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(ws);
      } catch {
        continue;
      }
      for (const name of names) {
        const dir = path.join(ws, name);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        for (const s of this.loadWorkspaceSessions(dir)) {
          const prev = byId.get(s.sessionId);
          // 保留消息更多的那份
          if (!prev || (s.messages?.length ?? 0) > (prev.messages?.length ?? 0)) {
            byId.set(s.sessionId, s);
          }
        }
      }
    }
    for (const r of p.roots) {
      if (!r.stateDb) continue;
      for (const d of this.loadDrafts(r.stateDb)) {
        if (!byId.has(d.sessionId)) byId.set(d.sessionId, d);
      }
    }
    const all = [...byId.values()];
    for (const s of all) {
      this.sessionIndex.set(s.sessionId, s);
    }
    return all;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const all = this.collectAll();
    const out: SessionSummary[] = all.map((s) => {
      const msgs = s.messages ?? [];
      const firstUser = msgs.find((m) => m.role === "user" && (typeof m.content === "string" ? m.content.trim() : extractTextFromContent(m.content)));
      const title =
        (s.title && s.title.trim()) ||
        (firstUser
          ? (typeof firstUser.content === "string"
              ? firstUser.content
              : extractTextFromContent(firstUser.content)
            )
              .trim()
              .slice(0, 120)
              .replace(/\s+/g, " ")
          : s.sessionId);
      const lastTs = msgs.reduce((acc, m) => {
        const t = typeof m.timestamp === "number" ? m.timestamp : 0;
        return t > acc ? t : acc;
      }, s.updatedAt ?? 0);
      return {
        id: s.sessionId,
        title,
        createdAtMs: s.createdAt,
        updatedAtMs: lastTs || s.updatedAt,
        cwd: s.cwd,
        group: s.cwd ? path.basename(s.cwd) : (s.brand || "trae"),
        messageCount: msgs.length,
        meta: { brand: s.brand, kind: s.brand === "draft" ? "draft" : "icube" },
      };
    });
    out.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    return out;
  }

  async readSession(id: string): Promise<HarborIR> {
    if (!this.sessionIndex.has(id)) this.collectAll();
    const s = this.sessionIndex.get(id);
    const items: HarborItem[] = [];
    let title = id;
    let model: string | undefined;
    let createdAt: number | undefined;
    let updatedAt: number | undefined;

    if (s) {
      title = (s.title && s.title.trim()) || id;
      createdAt = s.createdAt;
      updatedAt = s.updatedAt;
      for (const m of s.messages ?? []) {
        const role = m.role === "assistant" ? "assistant" : "user";
        const ts =
          typeof m.timestamp === "number" ? new Date(m.timestamp).toISOString() : undefined;
        if (role === "user") {
          const text =
            typeof m.content === "string" ? m.content : extractTextFromContent(m.content);
          if (!text.trim()) continue;
          if (title === id) title = text.trim().slice(0, 80);
          items.push({
            type: "message",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            role: "user",
            content: [{ type: "text", text: text.trim() }],
            timestamp: ts,
          });
        } else {
          const { text, thinking } = extractAssistantText(m);
          const modelInfo = m.modelInfo;
          const modelName =
            modelInfo && typeof modelInfo === "object"
              ? String((modelInfo as Json).display_model_name || (modelInfo as Json).model_name || "")
              : "";
          if (modelName) model = modelName;
          if (thinking) {
            items.push({
              type: "thinking",
              itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
              text: thinking.slice(0, 20000),
              timestamp: ts,
            });
          }
          if (text.trim()) {
            items.push({
              type: "message",
              itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
              role: "assistant",
              content: [{ type: "text", text: text.trim() }],
              model: modelName || undefined,
              timestamp: ts,
            });
          }
        }
      }
    }

    if (!items.length) {
      items.push({
        type: "message",
        itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        role: "system",
        content: [
          {
            type: "text",
            text:
              "Trae 本地未解析到完整正文。部分会话可能存于云端或加密库（ModularData/ai-agent/database.db）。",
          },
        ],
      });
    }

    const header = createHeader(
      {
        id,
        sourceClient: "trae-solo",
        sourceSessionId: id,
        title: title.slice(0, 200),
        createdAt: createdAt ? new Date(createdAt).toISOString() : undefined,
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : undefined,
        cwd: s?.cwd,
        model,
      },
      { brand: s?.brand, note: "trae-local-readonly" },
    );
    return { header, items };
  }

  async writeSession(): Promise<WriteResult> {
    return {
      status: "failed",
      sessionId: "",
      error: "Trae 本地库不支持写回；可作为迁移源",
    };
  }
}

export function createTraeSoloAdapter(paths?: TraePaths): TraeSoloAdapter {
  return new TraeSoloAdapter(paths);
}
