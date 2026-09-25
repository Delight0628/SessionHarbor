/**
 * Devin Desktop 适配器（只读）
 * 数据源:
 * 1. %APPDATA%/Devin/cli/sessions.db — ACP/CLI 本地会话（message_nodes / prompt_history）
 * 2. %APPDATA%/Devin/IndexedDB/vscode-file_vscode-app_0.indexeddb.leveldb
 *    桌面 Web 会话元数据（UUID + 标题 + file:// 工作区），LevelDB 扫描提取
 * 3. %APPDATA%/Devin/Local Storage/leveldb — open-sessions-by-workspace 中的会话 ID
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

export interface DevinPaths extends ClientPathsLike {
  sessionsDb: string;
  acpDir?: string;
  indexDbDir?: string;
  localStorageDir?: string;
}

function discoverDevin(explicitDb?: string): DevinPaths {
  const roots: string[] = [];
  if (process.env.APPDATA) roots.push(process.env.APPDATA);
  roots.push(path.join(os.homedir(), "AppData", "Roaming"));
  if (explicitDb) {
    const p = path.resolve(explicitDb);
    if (!fs.existsSync(p)) throw new Error(`sessions.db 不存在: ${p}`);
    const dataRoot = path.dirname(path.dirname(path.dirname(p)));
    return {
      id: "devin",
      dataRoot,
      primaryDb: p,
      sessionsDb: p,
      indexDbDir: path.join(dataRoot, "IndexedDB"),
      localStorageDir: path.join(dataRoot, "Local Storage", "leveldb"),
      extraDbs: [],
    };
  }
  for (const r of roots) {
    const db = path.join(r, "Devin", "cli", "sessions.db");
    if (fs.existsSync(db)) {
      const dataRoot = path.join(r, "Devin");
      const acpDir = path.join(dataRoot, "User", "acp-messages");
      return {
        id: "devin",
        dataRoot,
        primaryDb: db,
        sessionsDb: db,
        acpDir: fs.existsSync(acpDir) ? acpDir : undefined,
        indexDbDir: path.join(dataRoot, "IndexedDB"),
        localStorageDir: path.join(dataRoot, "Local Storage", "leveldb"),
        extraDbs: [],
      };
    }
  }
  throw new Error("未找到 Devin 数据目录（APPDATA/Devin/cli/sessions.db）");
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FILE_URI_RE = /file:\/\/\/[A-Za-z0-9%/\._\-一-鿿:]+/g;

function decodeBufferish(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && (v as Json).type === "Buffer" && Array.isArray((v as Json).data)) {
    return Buffer.from((v as { data: number[] }).data).toString("utf-8");
  }
  return String(v);
}

function parseChatMessage(raw: unknown): { role: string; text: string } | null {
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return raw.trim() ? { role: "assistant", text: raw } : null;
    }
  }
  if (typeof obj !== "object" || !obj) return null;
  const o = obj as Json;
  const role = String(o.role || o.author || o.kind || "assistant");
  const text =
    extractTextFromContent(o.content) ||
    extractTextFromContent(o.message) ||
    (typeof o.text === "string" ? o.text : "") ||
    (typeof o.content === "string" ? o.content : "");
  if (!text.trim()) return null;
  const r = role === "user" || role === "human" ? "user" : role === "system" ? "system" : "assistant";
  return { role: r, text };
}

function cleanTitle(s: string): string | null {
  let t = s.trim().replace(/^[\x21-\x2f\x24"'`]+/, "").trim();
  if (/^F?file:\/\//i.test(t)) return null;
  if (/^[0-9a-f-]{36}$/i.test(t)) return null;
  if (/^[A-Za-z0-9+/=]{16,}$/.test(t)) return null;
  if (t.length < 3) return null;
  // 去掉尾部协议/控制残留
  t = t.replace(/[\x00-\x1f]+.*$/s, "").trim();
  return t.slice(0, 120);
}

interface WebSession {
  id: string;
  title: string;
  cwd?: string;
  source: "indexdb" | "localstorage";
}

function scanIndexDb(indexDbDir?: string): WebSession[] {
  const out: WebSession[] = [];
  if (!indexDbDir || !fs.existsSync(indexDbDir)) return out;
  const byId = new Map<string, WebSession>();

  const walkFiles = (dir: string): string[] => {
    const files: string[] = [];
    try {
      for (const n of fs.readdirSync(dir)) {
        const p = path.join(dir, n);
        const st = fs.statSync(p);
        if (st.isDirectory()) files.push(...walkFiles(p));
        else if (/\.(ldb|log)$/i.test(n) && st.size > 0 && st.size < 50 * 1024 * 1024) {
          files.push(p);
        }
      }
    } catch {
      /* ignore */
    }
    return files;
  };

  for (const file of walkFiles(indexDbDir)) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    const ascii = buf.toString("latin1");
    // 1) $<uuid> + 附近可读标题
    const dollar = /\$([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
    let m: RegExpExecArray | null;
    while ((m = dollar.exec(ascii)) !== null) {
      const id = m[1]!.toLowerCase();
      const after = ascii.slice(m.index + m[0].length, m.index + m[0].length + 220);
      let title: string | null = null;
      const printable = /[\x20-\x7e]{4,150}/.exec(after);
      if (printable) title = cleanTitle(printable[0]);
      // cwd：附近 file:///
      const uri = FILE_URI_RE.exec(after) || FILE_URI_RE.exec(ascii.slice(m.index, m.index + 500));
      FILE_URI_RE.lastIndex = 0;
      const cwd = uri ? decodeURIComponent(uri[0].replace(/^file:\/\/\//i, "")) : undefined;
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          title: title || id,
          cwd,
          source: "indexdb",
        });
      } else {
        const prev = byId.get(id)!;
        if (cwd && (!prev.cwd || prev.cwd.length < cwd.length)) prev.cwd = cwd;
        if (title && title.length > prev.title.length && !title.startsWith("file:")) {
          prev.title = title;
        }
      }
    }

    // 2) 任意 UUID + 邻近可读标题（兼容无 $ 前缀）
    UUID_RE.lastIndex = 0;
    while ((m = UUID_RE.exec(ascii)) !== null) {
      const id = m[0].toLowerCase();
      if (byId.has(id)) continue;
      const after = ascii.slice(m.index + 36, m.index + 36 + 220);
      let title: string | null = null;
      const printable = /[\x20-\x7e]{6,150}/.exec(after);
      if (printable) title = cleanTitle(printable[0]);
      if (title) {
        byId.set(id, { id, title, source: "indexdb" });
      }
    }

    // 3) base64 块内的 UUID/标题（protobuf: uuid 后跟 length-prefix 标题）
    const b64re = /[A-Za-z0-9+/=]{60,}/g;
    while ((m = b64re.exec(ascii)) !== null) {
      const s = m[0];
      try {
        const raw = Buffer.from(s, "base64").toString("latin1");
        const ids = raw.match(UUID_RE) || [];
        for (const idRaw of ids) {
          const id = idRaw.toLowerCase();
          if (byId.has(id) && byId.get(id)!.title !== id) continue;
          const pos = raw.toLowerCase().indexOf(id);
          const window = raw.slice(pos, pos + 300);
          let title: string | null = null;
          // 形如 \x12\xdb\x05\n!Rerun Evaluation with Gantt Chart（标题含空格）
          const tm =
            /\n[\x20-\x7e]{4,120}/.exec(window) || /[\x20-\x7e]{6,120}/.exec(window.slice(36));
          if (tm) title = cleanTitle(tm[0]);
          const uri = FILE_URI_RE.exec(window) || FILE_URI_RE.exec(raw.slice(pos, pos + 800));
          FILE_URI_RE.lastIndex = 0;
          let cwd = uri ? decodeURIComponent(uri[0].replace(/^file:\/\/\//i, "")) : undefined;
          if (cwd) cwd = cwd.replace(/\/+$/, "");
          const prev = byId.get(id);
          if (!prev) {
            byId.set(id, { id, title: title || id, cwd, source: "indexdb" });
          } else {
            if (title && title !== id && title.length > prev.title.length) {
              if (!title.startsWith("file:")) prev.title = title;
            }
            if (cwd && (!prev.cwd || prev.cwd.length < cwd.length)) prev.cwd = cwd;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  out.push(...byId.values());
  return out;
}

function scanLocalStorage(localStorageDir?: string): WebSession[] {
  const out: WebSession[] = [];
  if (!localStorageDir || !fs.existsSync(localStorageDir)) return out;
  const byId = new Map<string, WebSession>();
  for (const n of fs.readdirSync(localStorageDir)) {
    if (!/\.(ldb|log)$/i.test(n)) continue;
    const p = path.join(localStorageDir, n);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(p);
    } catch {
      continue;
    }
    const ascii = buf.toString("latin1");
    // 形如 5726709-863cu94xw
    const re = /(\d{3,}-[a-z0-9]{6,12})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ascii)) !== null) {
      const id = m[1]!;
      if (id.startsWith("178") && id.includes("-") && /^\d{10,}-/.test(id)) {
        // new-tab id，跳过
        if (id.startsWith("new-")) continue;
      }
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        title: id,
        source: "localstorage",
      });
    }
    // open-sessions JSON 片段里的 folderUri
    const folder = /folderUri[^"]{0,20}"([^"]+)"/.exec(ascii);
    if (folder) {
      try {
        const uri = decodeURIComponent(folder[1]!);
        for (const s of byId.values()) {
          if (!s.cwd) s.cwd = uri.replace(/^file:\/\/\//i, "");
        }
      } catch {
        /* ignore */
      }
    }
  }
  out.push(...byId.values());
  return out;
}

export class DevinAdapter implements Adapter {
  id = "devin";
  displayName = "Devin";
  capabilities = { read: true, write: false, incremental: false, live: false };
  private paths?: DevinPaths;
  private webCache = new Map<string, WebSession>();

  constructor(paths?: DevinPaths) {
    this.paths = paths;
  }

  discover(): DevinPaths {
    if (!this.paths) this.paths = discoverDevin();
    return this.paths;
  }

  private ensure(): DevinPaths {
    return (this.paths ?? this.discover()) as DevinPaths;
  }

  private loadWebSessions(): WebSession[] {
    this.webCache.clear();
    const p = this.ensure();
    const all = [...scanIndexDb(p.indexDbDir), ...scanLocalStorage(p.localStorageDir)];
    for (const s of all) {
      const prev = this.webCache.get(s.id);
      if (!prev) this.webCache.set(s.id, s);
      else if (!prev.cwd && s.cwd) prev.cwd = s.cwd;
      if (prev && prev.title === s.id && s.title !== s.id) prev.title = s.title;
    }
    return [...this.webCache.values()];
  }

  async listSessions(): Promise<SessionSummary[]> {
    const p = this.ensure();
    const out: SessionSummary[] = [];
    const seen = new Set<string>();

    // 1) sessions.db（CLI/ACP）
    try {
      const db = openRo(p.sessionsDb);
      try {
        const rows = db
          .prepare(
            `SELECT id, working_directory, model, created_at, last_activity_at, title, agent_mode
             FROM sessions ORDER BY last_activity_at DESC`,
          )
          .all() as Array<Json>;
        const counts = new Map<string, number>();
        if (rows.length) {
          try {
            for (const c of db
              .prepare(`SELECT session_id, COUNT(*) n FROM message_nodes GROUP BY session_id`)
              .all() as Array<{ session_id: string; n: number }>) {
              counts.set(c.session_id, c.n);
            }
          } catch {
            /* ignore */
          }
        }
        const toMs = (v: unknown) => {
          if (v == null) return undefined;
          if (typeof v === "number") return v > 1e12 ? v : v * 1000;
          const n = Date.parse(String(v));
          return Number.isFinite(n) ? n : undefined;
        };
        for (const r of rows) {
          const id = String(r.id);
          seen.add(id);
          const cwd = (r.working_directory as string) || undefined;
          out.push({
            id,
            title: String(r.title || id),
            cwd,
            group: cwd ? path.basename(cwd) : "devin-cli",
            model: (r.model as string) || undefined,
            createdAtMs: toMs(r.created_at),
            updatedAtMs: toMs(r.last_activity_at),
            messageCount: counts.get(id),
            meta: { agentMode: r.agent_mode, store: "sessions.db" },
          });
        }
      } finally {
        db.close();
      }
    } catch {
      /* sessions.db 不可读时继续 web 源 */
    }

    // 2) IndexedDB / Local Storage（桌面 Web 会话）
    const web = this.loadWebSessions();
    for (const s of web) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        group: s.cwd ? path.basename(s.cwd) : "devin-web",
        messageCount: undefined,
        meta: { store: s.source, kind: "devin_web" },
      });
    }

    return out;
  }

  async readSession(id: string): Promise<HarborIR> {
    const p = this.ensure();
    const items: HarborItem[] = [];
    let title = id;
    let cwd: string | undefined;
    let model: string | undefined;
    let createdAt: string | undefined;
    let updatedAt: string | undefined;

    // sessions.db 正文
    try {
      const db = openRo(p.sessionsDb);
      try {
        const row = db
          .prepare(
            `SELECT id, working_directory, model, created_at, last_activity_at, title
             FROM sessions WHERE id = ?`,
          )
          .get(id) as Json | undefined;
        if (row) {
          title = String(row.title || id);
          cwd = (row.working_directory as string) || undefined;
          model = (row.model as string) || undefined;
          const toIso = (v: unknown) => {
            if (v == null) return undefined;
            if (typeof v === "number")
              return new Date(v > 1e12 ? v : v * 1000).toISOString();
            const t = Date.parse(String(v));
            return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
          };
          createdAt = toIso(row.created_at);
          updatedAt = toIso(row.last_activity_at);

          const nodes = db
            .prepare(
              `SELECT node_id, parent_node_id, chat_message, created_at
               FROM message_nodes WHERE session_id = ?
               ORDER BY created_at ASC, row_id ASC`,
            )
            .all(id) as Array<Json>;
          for (const n of nodes) {
            const parsed = parseChatMessage(n.chat_message);
            if (!parsed) continue;
            const tsNum =
              typeof n.created_at === "number"
                ? n.created_at > 1e12
                  ? n.created_at
                  : n.created_at * 1000
                : n.created_at
                  ? Date.parse(String(n.created_at))
                  : undefined;
            items.push({
              type: "message",
              itemId: `item_${String(n.node_id || randomUUID()).replace(/-/g, "").slice(0, 20)}`,
              role: parsed.role as "user" | "assistant" | "system",
              content: [{ type: "text", text: parsed.text }],
              timestamp: tsNum ? new Date(tsNum).toISOString() : undefined,
            });
          }
          if (!items.length) {
            const prompts = db
              .prepare(
                `SELECT content, timestamp FROM prompt_history WHERE session_id = ? ORDER BY timestamp ASC`,
              )
              .all(id) as Array<Json>;
            for (const pr of prompts) {
              const text = String(pr.content || "");
              if (!text.trim()) continue;
              items.push({
                type: "message",
                itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
                role: "user",
                content: [{ type: "text", text }],
                timestamp:
                  typeof pr.timestamp === "number"
                    ? new Date(
                        pr.timestamp > 1e12 ? pr.timestamp : pr.timestamp * 1000,
                      ).toISOString()
                    : undefined,
              });
            }
          }
        }
      } finally {
        db.close();
      }
    } catch {
      /* fall through to web */
    }

    // Web 会话：从 IndexedDB 抽取可读片段
    if (!items.length) {
      const web = this.webCache.get(id) ?? this.loadWebSessions().find((s) => s.id === id);
      if (web) {
        title = web.title;
        cwd = web.cwd;
        // 尽力从 IndexedDB 抽取与该 UUID 相邻的文本
        const p2 = this.ensure();
        const snippets: string[] = [];
        if (p2.indexDbDir && fs.existsSync(p2.indexDbDir)) {
          const scan = (dir: string, depth = 0) => {
            if (depth > 3) return;
            let names: string[] = [];
            try {
              names = fs.readdirSync(dir);
            } catch {
              return;
            }
            for (const n of names) {
              const fp = path.join(dir, n);
              try {
                const st = fs.statSync(fp);
                if (st.isDirectory()) scan(fp, depth + 1);
                else if (/\.(ldb|log)$/i.test(n) && st.size < 20 * 1024 * 1024) {
                  const buf = fs.readFileSync(fp);
                  const ascii = buf.toString("latin1");
                  const idx = ascii.toLowerCase().indexOf(web.id);
                  if (idx < 0) continue;
                  const window = ascii.slice(Math.max(0, idx - 200), idx + 2500);
                  for (const mm of window.matchAll(/[\x20-\x7e一-鿿]{12,200}/g)) {
                    const t = mm[0].trim();
                    if (t.length < 12) continue;
                    if (/^[A-Za-z0-9+/=]{20,}$/.test(t)) continue;
                    if (/^[0-9a-f-]{36}$/i.test(t)) continue;
                    if (t.includes("vscode") || t.includes("http://") || t.includes("filter.leveldb"))
                      continue;
                    snippets.push(t);
                    if (snippets.length >= 8) break;
                  }
                }
              } catch {
                /* ignore */
              }
            }
          };
          scan(p2.indexDbDir);
        }
        if (snippets.length) {
          items.push({
            type: "message",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            role: "assistant",
            content: [
              {
                type: "text",
                text: `（Devin 桌面会话本地元数据 / 片段）\n${snippets.join("\n---\n")}`,
              },
            ],
          });
        } else {
          items.push({
            type: "message",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            role: "system",
            content: [
              {
                type: "text",
                text:
                  "Devin 桌面会话在本地仅有元数据（IndexedDB/Local Storage）。" +
                  "完整对话可能同步在云端；本地 sessions.db 的 message_nodes 为空。",
              },
            ],
          });
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
            text: "Devin 本地未找到该会话正文（会话可能仅存云端）。",
          },
        ],
      });
    }

    const header = createHeader(
      {
        id,
        sourceClient: "devin",
        sourceSessionId: id,
        title: title.slice(0, 200),
        cwd,
        model,
        createdAt,
        updatedAt,
      },
      { storage: "sessions.db + IndexedDB/LocalStorage" },
    );
    return { header, items };
  }

  async writeSession(): Promise<WriteResult> {
    return {
      status: "failed",
      sessionId: "",
      error: "Devin 本地库无稳定公开写格式（会话偏云端），仅支持只读解析",
    };
  }
}

export function createDevinAdapter(paths?: DevinPaths): DevinAdapter {
  return new DevinAdapter(paths);
}
export { discoverDevin };
