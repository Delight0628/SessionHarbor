/**
 * Devin Desktop 适配器
 * 数据: %APPDATA%/Devin/cli/sessions.db
 *   sessions(id, working_directory, model, created_at, last_activity_at, title, ...)
 *   message_nodes(row_id, session_id, node_id, parent_node_id, chat_message, created_at, metadata)
 *   prompt_history(id, content, timestamp, session_id, is_shell)
 * 实测 2026-09-14：本机 sessions 为 0（会话偏云端）；适配器按 schema 只读解析。
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
}

function discoverDevin(explicitDb?: string): DevinPaths {
  if (explicitDb) {
    const p = path.resolve(explicitDb);
    if (!fs.existsSync(p)) throw new Error(`sessions.db 不存在: ${p}`);
    return {
      id: "devin",
      dataRoot: path.dirname(path.dirname(path.dirname(p))),
      primaryDb: p,
      sessionsDb: p,
      extraDbs: [],
    };
  }
  const roots: string[] = [];
  if (process.env.APPDATA) roots.push(process.env.APPDATA);
  roots.push(path.join(os.homedir(), "AppData", "Roaming"));
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
        extraDbs: [],
      };
    }
  }
  throw new Error("未找到 Devin 数据目录（APPDATA/Devin/cli/sessions.db）");
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

export class DevinAdapter implements Adapter {
  id = "devin";
  displayName = "Devin";
  capabilities = { read: true, write: false, incremental: false, live: false };
  private paths?: DevinPaths;

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

  async listSessions(): Promise<SessionSummary[]> {
    const p = this.ensure();
    const db = openRo(p.sessionsDb);
    try {
      const rows = db
        .prepare(
          `SELECT id, working_directory, model, created_at, last_activity_at, title, agent_mode
           FROM sessions ORDER BY last_activity_at DESC`,
        )
        .all() as Array<Json>;
      const out: SessionSummary[] = rows.map((r) => {
        const cwd = (r.working_directory as string) || undefined;
        // created_at 可能是秒或 ISO
        const ca = r.created_at;
        const la = r.last_activity_at;
        const toMs = (v: unknown) => {
          if (v == null) return undefined;
          if (typeof v === "number") return v > 1e12 ? v : v * 1000;
          const n = Date.parse(String(v));
          return Number.isFinite(n) ? n : undefined;
        };
        return {
          id: String(r.id),
          title: String(r.title || r.id),
          cwd,
          group: cwd ? path.basename(cwd) : undefined,
          model: (r.model as string) || undefined,
          createdAtMs: toMs(ca),
          updatedAtMs: toMs(la),
          meta: { agentMode: r.agent_mode },
        };
      });
      // 补消息数
      if (out.length) {
        const counts = db
          .prepare(
            `SELECT session_id, COUNT(*) n FROM message_nodes GROUP BY session_id`,
          )
          .all() as Array<{ session_id: string; n: number }>;
        const map = new Map(counts.map((c) => [c.session_id, c.n]));
        for (const s of out) s.messageCount = map.get(s.id);
      }
      return out;
    } finally {
      db.close();
    }
  }

  async readSession(id: string): Promise<HarborIR> {
    const p = this.ensure();
    const db = openRo(p.sessionsDb);
    try {
      const row = db
        .prepare(
          `SELECT id, working_directory, model, created_at, last_activity_at, title
           FROM sessions WHERE id = ?`,
        )
        .get(id) as Json | undefined;
      if (!row) throw new Error(`Devin 会话不存在: ${id}`);
      const nodes = db
        .prepare(
          `SELECT node_id, parent_node_id, chat_message, created_at
           FROM message_nodes WHERE session_id = ?
           ORDER BY created_at ASC, row_id ASC`,
        )
        .all(id) as Array<Json>;
      const items: HarborItem[] = [];
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
      // prompt_history 兜底
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
                ? new Date(pr.timestamp > 1e12 ? pr.timestamp : pr.timestamp * 1000).toISOString()
                : undefined,
          });
        }
      }
      const toIso = (v: unknown) => {
        if (v == null) return undefined;
        if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000).toISOString();
        const t = Date.parse(String(v));
        return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
      };
      const header = createHeader(
        {
          id,
          sourceClient: "devin",
          sourceSessionId: id,
          title: String(row.title || id),
          cwd: (row.working_directory as string) || undefined,
          model: (row.model as string) || undefined,
          createdAt: toIso(row.created_at),
          updatedAt: toIso(row.last_activity_at),
        },
        { storage: "sessions.db/message_nodes" },
      );
      return { header, items };
    } finally {
      db.close();
    }
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
