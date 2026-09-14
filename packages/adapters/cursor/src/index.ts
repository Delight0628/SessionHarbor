/**
 * Cursor 适配器（只读）
 * 数据: %APPDATA%/Cursor/User/globalStorage/state.vscdb
 *   ItemTable: composer.composerHeaders → allComposers[]
 *   cursorDiskKV: composerData:<id> / bubbleId:<composerId>:<bubbleId>
 * 安装目录探测: D:/cursor, %LOCALAPPDATA%/Programs/cursor 等（仅用于 installed 判定）
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  createHeader,
  openRo,
  type Adapter,
  type ClientPathsLike,
  type HarborIR,
  type HarborItem,
  type SessionSummary,
  type WriteResult,
} from "@sessionharbor/core";

type Json = Record<string, unknown>;

export interface CursorPaths extends ClientPathsLike {
  stateDb?: string;
  projectsRoot?: string;
  installHint?: string;
}

function firstExisting(paths: string[]): string | undefined {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

export function discoverCursor(explicitRoot?: string): CursorPaths {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

  const roots: string[] = [];
  if (explicitRoot) roots.push(path.resolve(explicitRoot));
  roots.push(path.join(appData, "Cursor"));
  roots.push(path.join(home, "AppData", "Roaming", "Cursor"));

  for (const r of roots) {
    const stateDb = path.join(r, "User", "globalStorage", "state.vscdb");
    if (fs.existsSync(stateDb)) {
      const projectsRoot = path.join(home, ".cursor", "projects");
      const installHint = firstExisting([
        "D:\\cursor\\Cursor.exe",
        "C:\\cursor\\Cursor.exe",
        path.join(home, "AppData", "Local", "Programs", "cursor", "Cursor.exe"),
      ]);
      return {
        id: "cursor",
        dataRoot: r,
        primaryDb: stateDb,
        stateDb,
        projectsRoot: fs.existsSync(projectsRoot) ? projectsRoot : undefined,
        installHint,
        extraDbs: [],
      };
    }
  }
  throw new Error(
    "未找到 Cursor 数据目录（%APPDATA%/Cursor/User/globalStorage/state.vscdb）",
  );
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

function uriToPath(uri: unknown): string | undefined {
  if (!uri || typeof uri !== "object") return undefined;
  const o = uri as Json;
  const p = typeof o.path === "string" ? o.path : undefined;
  if (!p) return undefined;
  let s = decodeURIComponent(p);
  // /D:/foo → D:/foo
  if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  return s.replace(/\//g, "\\");
}

function bubbleText(b: Json): string {
  if (typeof b.text === "string" && b.text.trim()) return b.text.trim();
  if (typeof b.richText === "string" && b.richText.includes('"text"')) {
    try {
      const rt = JSON.parse(b.richText) as Json;
      const walk = (o: unknown, acc: string[]): void => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) {
          for (const x of o) walk(x, acc);
          return;
        }
        const d = o as Json;
        if (typeof d.text === "string" && d.text.trim()) acc.push(d.text.trim());
        for (const k of Object.keys(d)) {
          if (k !== "text") walk(d[k], acc);
        }
      };
      const acc: string[] = [];
      walk(rt, acc);
      if (acc.length) return acc.join("\n");
    } catch {
      /* ignore */
    }
  }
  return "";
}

interface ComposerHeader {
  composerId: string;
  createdAt?: number;
  workspaceIdentifier?: { id?: string; uri?: unknown };
  unifiedMode?: string;
  isArchived?: boolean;
  isDraft?: boolean;
}

export class CursorAdapter implements Adapter {
  id = "cursor";
  displayName = "Cursor";
  capabilities = { read: true, write: false, incremental: false, live: false };
  private paths?: CursorPaths;
  /** list 会话缓存，避免 read 时重复扫全库 */
  private metaCache = new Map<string, SessionSummary & { headers?: Array<{ bubbleId: string; type: number }> }>();

  constructor(paths?: CursorPaths) {
    this.paths = paths;
  }

  discover(): CursorPaths {
    if (!this.paths) this.paths = discoverCursor();
    return this.paths;
  }

  private ensure(): CursorPaths {
    return (this.paths ?? this.discover()) as CursorPaths;
  }

  private loadHeaders(db: ReturnType<typeof openRo>): ComposerHeader[] {
    const byId = new Map<string, ComposerHeader>();
    try {
      const row = db
        .prepare(`SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'`)
        .get() as { value?: unknown } | undefined;
      if (row?.value != null) {
        const d = decodeValue(row.value) as Json | undefined;
        const list = (d?.allComposers ?? []) as ComposerHeader[];
        for (const h of list) {
          if (h?.composerId) byId.set(h.composerId, h);
        }
      }
    } catch {
      /* fall through */
    }
    // 全量 composerData（headers 可能只含近期 head）
    try {
      const rows = db
        .prepare(`SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%'`)
        .all() as Array<{ key: string }>;
      for (const r of rows) {
        const id = r.key.slice("composerData:".length);
        if (id && !byId.has(id)) byId.set(id, { composerId: id });
      }
    } catch {
      /* ignore */
    }
    return [...byId.values()];
  }

  private loadComposerData(db: ReturnType<typeof openRo>, composerId: string): Json | undefined {
    try {
      const row = db
        .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
        .get(`composerData:${composerId}`) as { value?: unknown } | undefined;
      if (row?.value == null) return undefined;
      const d = decodeValue(row.value);
      return d && typeof d === "object" ? (d as Json) : undefined;
    } catch {
      return undefined;
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    const p = this.ensure();
    if (!p.stateDb || !fs.existsSync(p.stateDb)) return [];
    const db = openRo(p.stateDb);
    this.metaCache.clear();
    const out: SessionSummary[] = [];
    try {
      // 一次拉全部 composerData，避免逐条 query
      const dataMap = new Map<string, Json>();
      try {
        const rows = db
          .prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'`)
          .all() as Array<{ key: string; value: unknown }>;
        for (const r of rows) {
          const id = r.key.slice("composerData:".length);
          const d = decodeValue(r.value);
          if (id && d && typeof d === "object") dataMap.set(id, d as Json);
        }
      } catch {
        /* ignore */
      }

      const headers = this.loadHeaders(db);
      for (const h of headers) {
        const cid = h.composerId;
        if (!cid) continue;
        const data = dataMap.get(cid) ?? this.loadComposerData(db, cid);
        const convHeaders = (data?.fullConversationHeadersOnly ?? []) as Array<{
          bubbleId: string;
          type: number;
        }>;
        let title = typeof data?.text === "string" && data.text.trim() ? data.text.trim() : "";
        const cwd = uriToPath(h.workspaceIdentifier?.uri);
        const messageCount = Array.isArray(convHeaders) ? convHeaders.length : 0;
        let firstUserText = "";

        if (!title && Array.isArray(convHeaders) && convHeaders.length) {
          // 只读第一枚 type=1
          for (const ch of convHeaders) {
            if (ch.type !== 1) continue;
            try {
              const row = db
                .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
                .get(`bubbleId:${cid}:${ch.bubbleId}`) as { value?: unknown } | undefined;
              if (row?.value != null) {
                const b = decodeValue(row.value) as Json | undefined;
                firstUserText = b ? bubbleText(b) : "";
              }
            } catch {
              /* skip */
            }
            break;
          }
        }
        if (!title) title = firstUserText || cid;
        title = title.slice(0, 120).replace(/\s+/g, " ");
        const base: SessionSummary = {
          id: cid,
          title,
          createdAtMs: h.createdAt,
          updatedAtMs: h.createdAt,
          cwd,
          group: cwd ? path.basename(cwd) : "cursor",
          messageCount,
          meta: {
            kind: "cursor_composer",
            unifiedMode: h.unifiedMode,
            isArchived: h.isArchived,
            isDraft: h.isDraft,
          },
        };
        this.metaCache.set(cid, { ...base, headers: convHeaders });
        out.push(base);
      }
    } finally {
      db.close();
    }
    // 有消息的排前面
    out.sort((a, b) => {
      const am = a.messageCount ? 1 : 0;
      const bm = b.messageCount ? 1 : 0;
      if (am !== bm) return bm - am;
      return (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
    });
    return out;
  }

  async readSession(id: string): Promise<HarborIR> {
    const p = this.ensure();
    const db = openRo(p.stateDb!);
    const items: HarborItem[] = [];
    let title = id;
    let cwd: string | undefined;
    let createdAt: number | undefined;
    try {
      const data = this.loadComposerData(db, id);
      const convHeaders =
        this.metaCache.get(id)?.headers ??
        ((data?.fullConversationHeadersOnly ?? []) as Array<{ bubbleId: string; type: number }>);

      // 补齐 header 元信息
      try {
        const row = db
          .prepare(`SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'`)
          .get() as { value?: unknown } | undefined;
        if (row?.value != null) {
          const d = decodeValue(row.value) as Json;
          const list = (d.allComposers ?? []) as ComposerHeader[];
          const h = list.find((x) => x.composerId === id);
          if (h) {
            cwd = uriToPath(h.workspaceIdentifier?.uri);
            createdAt = h.createdAt;
          }
        }
      } catch {
        /* ignore */
      }

      if (typeof data?.text === "string" && data.text.trim()) title = data.text.trim();

      for (const ch of convHeaders ?? []) {
        let b: Json | undefined;
        try {
          const row = db
            .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
            .get(`bubbleId:${id}:${ch.bubbleId}`) as { value?: unknown } | undefined;
          if (row?.value == null) continue;
          const decoded = decodeValue(row.value);
          b = decoded && typeof decoded === "object" ? (decoded as Json) : undefined;
        } catch {
          continue;
        }
        if (!b) continue;
        const text = bubbleText(b);
        const role = b.type === 1 ? "user" : "assistant";
        if (text) {
          if (role === "user" && title === id) title = text.slice(0, 80);
          items.push({
            type: "message",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            role,
            content: [{ type: "text", text }],
            timestamp: typeof b.createdAt === "number" ? new Date(b.createdAt).toISOString() : undefined,
          });
        }
        // 工具结果
        const toolResults = b.toolResults;
        if (Array.isArray(toolResults)) {
          for (const tr of toolResults) {
            if (!tr || typeof tr !== "object") continue;
            const o = tr as Json;
            const toolName = String(o.toolName ?? o.name ?? "tool");
            const callId = String(o.callId ?? o.id ?? randomUUID());
            const output =
              typeof o.result === "string"
                ? o.result
                : typeof o.output === "string"
                  ? o.output
                  : JSON.stringify(o).slice(0, 4000);
            items.push({
              type: "tool_call",
              itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
              callId,
              toolName,
              input: o.params ?? o.input,
            });
            items.push({
              type: "tool_output",
              itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
              callId,
              output: output.slice(0, 20000),
            });
          }
        }
      }
    } finally {
      db.close();
    }

    const header = createHeader(
      {
        id,
        sourceClient: "cursor",
        sourceSessionId: id,
        title: title.slice(0, 200),
        createdAt: createdAt ? new Date(createdAt).toISOString() : undefined,
        updatedAt: createdAt ? new Date(createdAt).toISOString() : undefined,
        cwd,
      },
      { note: "cursor-local-readonly" },
    );
    return { header, items };
  }

  async writeSession(): Promise<WriteResult> {
    return {
      status: "failed",
      sessionId: "",
      error: "Cursor 本地 composer 库仅支持只读；可作为迁移源",
    };
  }
}

export function createCursorAdapter(paths?: CursorPaths): CursorAdapter {
  return new CursorAdapter(paths);
}
