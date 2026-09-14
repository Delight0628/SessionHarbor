/**
 * TRAE SOLO CN 适配器
 * 数据: %APPDATA%/TRAE SOLO CN/
 *   User/globalStorage/state.vscdb — draft:session:* 等
 *   ModularData/ai-agent/database.db — 实测非明文 SQLite（加密/私有格式）
 * 实测 2026-09-14：无可用明文转录；适配器做发现 + draft 解析 + 明确只读。
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
  stateDb?: string;
  agentDb?: string;
}

function discoverTrae(explicitRoot?: string): TraePaths {
  const roots: string[] = [];
  if (explicitRoot) roots.push(path.resolve(explicitRoot));
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "TRAE SOLO CN"));
  roots.push(path.join(os.homedir(), "AppData", "Roaming", "TRAE SOLO CN"));

  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const stateDb = path.join(r, "User", "globalStorage", "state.vscdb");
    const agentDb = path.join(r, "ModularData", "ai-agent", "database.db");
    return {
      id: "trae-solo",
      dataRoot: r,
      primaryDb: fs.existsSync(stateDb) ? stateDb : undefined,
      stateDb: fs.existsSync(stateDb) ? stateDb : undefined,
      agentDb: fs.existsSync(agentDb) ? agentDb : undefined,
      extraDbs: [],
    };
  }
  throw new Error("未找到 TRAE SOLO CN 数据目录（APPDATA/TRAE SOLO CN）");
}

function decodeValue(v: unknown): unknown {
  // VS Code ItemTable 存 JSON 文本或 Buffer
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

export class TraeSoloAdapter implements Adapter {
  id = "trae-solo";
  displayName = "TRAE SOLO CN";
  capabilities = { read: true, write: false, incremental: false, live: false };
  private paths?: TraePaths;

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

  async listSessions(): Promise<SessionSummary[]> {
    const p = this.ensure();
    const out: SessionSummary[] = [];
    if (!p.stateDb || !fs.existsSync(p.stateDb)) return out;
    const db = openRo(p.stateDb);
    try {
      const rows = db
        .prepare(`SELECT key, value FROM ItemTable`)
        .all() as Array<{ key: string; value: unknown }>;
      const drafts = new Map<string, string>();
      for (const r of rows) {
        // 形如 3850950341047163:draft:session:<id>:code
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
        out.push({
          id: sid,
          title: body.trim().slice(0, 80).replace(/\s+/g, " ") || sid,
          group: "drafts",
          messageCount: 1,
          meta: { kind: "draft", note: "本地仅有草稿；完整会话可能在云端/加密库" },
        });
      }
    } finally {
      db.close();
    }
    return out;
  }

  async readSession(id: string): Promise<HarborIR> {
    const p = this.ensure();
    const items: HarborItem[] = [];
    let title = id;
    let cwd: string | undefined;
    if (p.stateDb && fs.existsSync(p.stateDb)) {
      const db = openRo(p.stateDb);
      try {
        const rows = db
          .prepare(`SELECT key, value FROM ItemTable WHERE key LIKE ?`)
          .all(`%draft:session:${id}%`) as Array<{ key: string; value: unknown }>;
        for (const r of rows) {
          const val = decodeValue(r.value);
          const text =
            typeof val === "string" ? val : extractTextFromContent(val);
          if (!text.trim()) continue;
          title = text.slice(0, 80).replace(/\s+/g, " ");
          items.push({
            type: "message",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            role: "user",
            content: [{ type: "text", text }],
          });
        }
        // 最近打开路径
        const hist = db
          .prepare(`SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'`)
          .get() as { value: unknown } | undefined;
        if (hist) {
          const v = decodeValue(hist.value) as Json | undefined;
          const folders = (v?.folders ?? []) as Array<{ folderUri?: string }>;
          if (folders[0]?.folderUri) {
            cwd = decodeURIComponent(folders[0].folderUri.replace(/^file:\/\/\//, ""));
          }
        }
      } finally {
        db.close();
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
              "TRAE SOLO 本地未发现明文完整转录（database.db 非明文 SQLite）。" +
              "完整会话可能存于云端或加密存储，当前仅支持草稿/元数据级解析。",
          },
        ],
      });
    }
    const header = createHeader(
      {
        id,
        sourceClient: "trae-solo",
        sourceSessionId: id,
        title,
        cwd,
      },
      { note: "partial-local", agentDb: p.agentDb },
    );
    return { header, items };
  }

  async writeSession(): Promise<WriteResult> {
    return {
      status: "failed",
      sessionId: "",
      error: "TRAE SOLO 本地库加密/无公开写格式，仅支持只读探测",
    };
  }
}

export function createTraeSoloAdapter(paths?: TraePaths): TraeSoloAdapter {
  return new TraeSoloAdapter(paths);
}
export { discoverTrae };
