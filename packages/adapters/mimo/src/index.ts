/**
 * Xiaomi MiMo Desktop 适配器
 * 主库: %USERPROFILE%/.local/share/mimocode/mimocode.db
 * 模型: session → message(JSON data) → part(text/tool/file)
 * 注: 旧版 Desktop 云端正文无法本地迁入；本适配器面向 mimocode 本地库。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  createHeader,
  openRo,
  openRw,
  extractTextFromContent,
  planForkSessions,
  applyCompactionPolicy,
  type Adapter,
  type ClientPathsLike,
  type HarborIR,
  type HarborItem,
  type SessionSummary,
  type WriteResult,
} from "@sessionharbor/core";

type Json = Record<string, unknown>;

function discoverMimo(explicitDb?: string): ClientPathsLike {
  if (explicitDb) {
    const p = path.resolve(explicitDb);
    if (!fs.existsSync(p)) throw new Error(`mimocode.db 不存在: ${p}`);
    return { id: "mimo", dataRoot: path.dirname(path.dirname(p)), primaryDb: p, extraDbs: [] };
  }

  const roots: string[] = [];
  for (const k of ["USERPROFILE", "HOME"]) {
    if (process.env[k]) roots.push(process.env[k]!);
  }
  for (const k of ["APPDATA", "LOCALAPPDATA"]) {
    if (process.env[k]) {
      const p = process.env[k]!;
      roots.push(p, path.dirname(p), path.dirname(path.dirname(p)));
    }
  }
  roots.push(os.homedir());

  const rels = [
    path.join(".local", "share", "mimocode", "mimocode.db"),
    path.join("AppData", "Local", "mimocode", "mimocode.db"),
    path.join("AppData", "Roaming", "mimocode", "mimocode.db"),
    path.join("Application Data", "mimocode", "mimocode.db"),
    path.join("Application Data", "Xiaomi MiMo", "mimocode", "mimocode.db"),
    path.join("mimocode", "mimocode.db"),
  ];

  const hits: string[] = [];
  for (const root of roots) {
    for (const rel of rels) {
      const p = path.join(root, rel);
      if (fs.existsSync(p)) hits.push(p);
    }
  }
  for (const drive of ["C:", "D:", "E:"]) {
    const user = path.join(drive + path.sep, "user");
    if (!fs.existsSync(user)) continue;
    try {
      for (const u of fs.readdirSync(user)) {
        const base = path.join(user, u);
        if (!fs.statSync(base).isDirectory()) continue;
        for (const rel of [
          path.join(".local", "share", "mimocode", "mimocode.db"),
          path.join("Application Data", "mimocode", "mimocode.db"),
        ]) {
          const p = path.join(base, rel);
          if (fs.existsSync(p)) hits.push(p);
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!hits.length) throw new Error("未找到 mimocode.db，可用 --mimo-db 指定");
  hits.sort((a, b) => {
    const la = a.includes(".local") ? 0 : 1;
    const lb = b.includes(".local") ? 0 : 1;
    if (la !== lb) return la - lb;
    return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
  });
  const db = hits[0]!;
  return {
    id: "mimo",
    dataRoot: path.dirname(path.dirname(db)),
    primaryDb: db,
    extraDbs: [...new Set(hits.slice(1))],
  };
}

function ensureSchema(conn: ReturnType<typeof openRw>): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      slug TEXT,
      directory TEXT,
      title TEXT,
      version TEXT,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT,
      context_from TEXT,
      context_watermark TEXT,
      last_checkpoint_message_id TEXT,
      prompt TEXT,
      auto_worktree_hint_sent INTEGER
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      agent_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY,
      worktree TEXT,
      vcs TEXT,
      name TEXT,
      icon_url TEXT,
      icon_color TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      time_initialized INTEGER,
      sandboxes TEXT,
      commands TEXT
    );
  `);
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
}

function slugify(title: string): string {
  const s = (title || "session")
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 48) || "session";
}

function nowMs(): number {
  return Date.now();
}

export class MimoAdapter implements Adapter {
  id = "mimo";
  displayName = "MiMo Desktop";
  capabilities = { read: true, write: true, incremental: false, live: false };
  private paths?: ClientPathsLike;

  constructor(paths?: ClientPathsLike) {
    this.paths = paths;
  }

  discover(): ClientPathsLike {
    if (!this.paths) this.paths = discoverMimo();
    return this.paths;
  }

  private ensure(): ClientPathsLike {
    return this.paths ?? this.discover();
  }

  async listSessions(): Promise<SessionSummary[]> {
    const p = this.ensure();
    const db = openRo(p.primaryDb!);
    try {
      const rows = db
        .prepare(
          `SELECT id, project_id, directory, title, time_created, time_updated, time_archived, slug
           FROM session ORDER BY time_updated DESC`,
        )
        .all() as Array<Json>;
      return rows.map((r) => {
        const directory = (r.directory as string) || undefined;
        return {
          id: String(r.id),
          title: String(r.title || r.slug || r.id),
          cwd: directory,
          group: directory ? path.basename(directory) : (r.project_id as string) || undefined,
          createdAtMs: Number(r.time_created) || undefined,
          updatedAtMs: Number(r.time_updated) || undefined,
          deleted: r.time_archived != null,
          meta: { project_id: r.project_id, slug: r.slug },
        };
      });
    } finally {
      db.close();
    }
  }

  async readSession(id: string): Promise<HarborIR> {
    const p = this.ensure();
    const db = openRo(p.primaryDb!);
    try {
      const row = db
        .prepare(
          `SELECT id, project_id, directory, title, time_created, time_updated, slug
           FROM session WHERE id = ?`,
        )
        .get(id) as Json | undefined;
      if (!row) throw new Error(`MiMo 会话不存在: ${id}`);
      const title = String(row.title || row.slug || id);
      const cwd = (row.directory as string) || undefined;
      const createdMs = Number(row.time_created) || undefined;
      const updatedMs = Number(row.time_updated) || undefined;

      const messages = db
        .prepare(
          `SELECT id, data, time_created FROM message WHERE session_id = ?
           ORDER BY time_created ASC, id ASC`,
        )
        .all(id) as Array<Json>;
      const partsByMsg = new Map<string, Json[]>();
      for (const pr of db
        .prepare(
          `SELECT message_id, data, time_created FROM part WHERE session_id = ?
           ORDER BY time_created ASC, id ASC`,
        )
        .all(id) as Array<Json>) {
        const mid = String(pr.message_id);
        const list = partsByMsg.get(mid) ?? [];
        list.push(pr);
        partsByMsg.set(mid, list);
      }

      const items: HarborItem[] = [];
      let model: string | undefined;
      for (const m of messages) {
        let data: Json = {};
        try {
          data = JSON.parse(String(m.data || "{}")) as Json;
        } catch {
          /* skip */
        }
        const role = String(data.role || "user") as "user" | "assistant" | "system";
        const tsNum = Number((data.time as Json | undefined)?.created) || Number(m.time_created) || undefined;
        const ts = tsNum ? new Date(tsNum).toISOString() : undefined;
        const modelObj = data.model;
        if (!model && modelObj && typeof modelObj === "object") {
          model = String((modelObj as Json).modelID || (modelObj as Json).id || "") || undefined;
        }
        const texts: string[] = [];
        const toolNotes: string[] = [];
        for (const pr of partsByMsg.get(String(m.id)) ?? []) {
          let pd: Json = {};
          try {
            pd = JSON.parse(String(pr.data || "{}")) as Json;
          } catch {
            continue;
          }
          if (pd.type === "text") {
            const t = String(pd.text || "");
            if (t) texts.push(t);
          } else if (pd.type === "tool") {
            const tool = String(pd.tool || "tool");
            const state = (pd.state ?? {}) as Json;
            const status = String(state.status || "");
            const out = typeof state.output === "string" ? state.output : "";
            const summary = out ? out.slice(0, 120) + (out.length > 120 ? "…" : "") : "";
            toolNotes.push(`[tool:${tool} ${status}] ${summary}`.trim());
            items.push({
              type: "tool_call",
              itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
              callId: String(pd.callID || pd.toolCallId || m.id),
              toolName: tool,
              input: pd.state ?? {},
              timestamp: ts,
            });
          } else if (pd.type === "file") {
            texts.push(`[file] ${pd.filename || pd.url || ""}`);
          }
        }
        let content = texts.join("\n").trim();
        if (!content && toolNotes.length) content = toolNotes.join("\n");
        if (!content) content = String(data.summary || "");
        if (!content) continue;
        items.push({
          type: "message",
          itemId: `item_${String(m.id).replace(/-/g, "").slice(0, 20)}`,
          role: role === "assistant" || role === "system" ? role : "user",
          content: [{ type: "text", text: content }],
          timestamp: ts,
          model,
        });
      }

      const header = createHeader(
        {
          id,
          sourceClient: "mimo",
          sourceSessionId: id,
          title,
          createdAt: createdMs ? new Date(createdMs).toISOString() : undefined,
          updatedAt: updatedMs ? new Date(updatedMs).toISOString() : undefined,
          cwd,
          model,
        },
        { projectId: row.project_id, slug: row.slug },
      );
      return { header, items };
    } finally {
      db.close();
    }
  }

  async writeSession(ir: HarborIR, opts?: { overwrite?: boolean }): Promise<WriteResult> {
    const p = this.ensure();
    // 分叉拆分：只把主链写进本会话；其余分支写成 parent_id 关联的 fork 会话
    const { main, forks } = planForkSessions(ir);
    const compacted = {
      header: main.header,
      items: applyCompactionPolicy(main.items, "keep-all"),
    };

    const s = compacted.header.session;
    let sessionId = s.sourceSessionId || s.id;
    if (!String(sessionId).startsWith("ses_")) {
      sessionId = `ses_${String(sessionId).replace(/-/g, "").slice(0, 24)}`;
    }
    const createdMs = s.createdAt ? Date.parse(s.createdAt) : nowMs();
    const updatedMs = s.updatedAt ? Date.parse(s.updatedAt) : createdMs;
    const directory = s.cwd || process.cwd();
    const projectId = (compacted.header.extensions?.projectId as string) || "global";

    const db = openRw(p.primaryDb!);
    try {
      ensureSchema(db);
      const existing = db.prepare(`SELECT 1 FROM session WHERE id = ?`).get(sessionId);
      if (existing && !opts?.overwrite) {
        return {
          status: "skipped",
          sessionId,
          reason: "session exists（可用 --overwrite 重写；分叉会另建 fork 会话）",
        };
      }

      db.exec(`BEGIN`);
      db.prepare(
        `INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes)
         VALUES (?, ?, ?, ?, '[]')`,
      ).run(projectId, directory, createdMs, updatedMs);

      if (existing && opts?.overwrite) {
        db.prepare(`DELETE FROM part WHERE session_id = ?`).run(sessionId);
        db.prepare(`DELETE FROM message WHERE session_id = ?`).run(sessionId);
      }

      db.prepare(
        `INSERT OR REPLACE INTO session
         (id, project_id, slug, directory, title, version, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        projectId,
        (compacted.header.extensions?.slug as string) || slugify(s.title),
        directory,
        s.title || sessionId,
        (compacted.header.extensions?.version as string) || "sessionharbor-0.1",
        createdMs,
        updatedMs,
      );

      const inserted = this.insertMessageChain(db, sessionId, compacted.items, s, updatedMs);

      // 写 fork 会话（parent_id 指向主会话，标题带 fork #n）
      let forkCount = 0;
      let forkIdx = 0;
      for (const fk of forks) {
        forkIdx++;
        // 必须与主会话 ID 不同：后缀 hash 而不是截断同一前缀
        const fid = `ses_${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
        const fExists = db.prepare(`SELECT 1 FROM session WHERE id = ?`).get(fid);
        if (fExists && !opts?.overwrite) continue;
        db.prepare(
          `INSERT OR REPLACE INTO session
           (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          fid,
          projectId,
          sessionId,
          slugify(fk.ir.header.session.title),
          directory,
          fk.ir.header.session.title,
          "sessionharbor-0.1-fork",
          createdMs,
          updatedMs,
        );
        this.insertMessageChain(db, fid, fk.ir.items, fk.ir.header.session, updatedMs);
        forkCount++;
      }

      db.exec(`COMMIT`);
      return {
        status: "ok",
        sessionId,
        messageCount: inserted,
        detail: {
          projectId,
          directory,
          title: s.title,
          forksWritten: forkCount,
          mainPathLength: compacted.items.filter((i) => i.type === "message").length,
        },
      };
    } catch (e) {
      try {
        db.exec(`ROLLBACK`);
      } catch {
        /* ignore */
      }
      return {
        status: "failed",
        sessionId,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      db.close();
    }
  }

  /** 按顺序插入 message/part，并维护 parentID 链（每条消息都挂上一跳） */
  private insertMessageChain(
    db: ReturnType<typeof openRw>,
    sessionId: string,
    items: HarborItem[],
    sessionMeta: { sourceClient: string; model?: string },
    fallbackTs: number,
  ): number {
    let inserted = 0;
    let lastMsgId: string | null = null;
    const idMap = new Map<string, string>(); // ir itemId -> mimo msg id

    for (const item of items) {
      if (item.type === "checkpoint") {
        // 压缩/产物边界：写成 system 消息，避免历史被「抹掉」
        const ts = fallbackTs;
        const msgId = newId("msg");
        db.prepare(
          `INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data)
           VALUES (?, ?, 'main', ?, ?, ?)`,
        ).run(
          msgId,
          sessionId,
          ts,
          ts,
          JSON.stringify({
            role: "system",
            time: { created: ts },
            agent: "migrate",
            parentID: lastMsgId,
            summary: item.label,
          }),
        );
        db.prepare(
          `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          newId("prt"),
          msgId,
          sessionId,
          ts,
          ts,
          JSON.stringify({
            type: "text",
            text: `[${item.label}]\n${(item.files || []).map((f) => `- ${f}`).join("\n")}`,
            synthetic: true,
          }),
        );
        if (item.itemId) idMap.set(item.itemId, msgId);
        lastMsgId = msgId;
        inserted++;
        continue;
      }

      let text = "";
      let role: string = "assistant";
      if (item.type === "message") {
        role = item.role === "system" ? "system" : item.role;
        text = item.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .filter(Boolean)
          .join("\n");
      } else if (item.type === "thinking") {
        role = "assistant";
        text = `[thinking] ${item.text ?? ""}`;
      } else if (item.type === "tool_call") {
        role = "assistant";
        // input 可能为 undefined/null；JSON.stringify(undefined) 返回 undefined，不能直接 .slice
        const inputJson =
          item.input === undefined
            ? "null"
            : (() => {
                try {
                  const s = JSON.stringify(item.input);
                  return typeof s === "string" ? s : "null";
                } catch {
                  return String(item.input);
                }
              })();
        text = `[tool:${item.toolName ?? "tool"}] ${inputJson.slice(0, 400)}`;
      } else if (item.type === "tool_output") {
        role = "assistant";
        text = `[tool_result] ${item.output ?? ""}`;
      }
      if (!text.trim()) continue;

      const ts =
        "timestamp" in item && item.timestamp ? Date.parse(item.timestamp) : fallbackTs;
      const msgId = newId("msg");
      // parent：优先 IR parent 映射，否则上一条
      const irParent =
        "parentItemId" in item && item.parentItemId ? idMap.get(item.parentItemId) : undefined;
      const parentID = irParent || lastMsgId;

      const data: Json = {
        role,
        time: { created: ts },
        agent: "migrate",
      };
      if (parentID) data.parentID = parentID;
      if (item.type === "message" && item.model) {
        data.model = { providerID: "migrated", modelID: item.model };
      }
      if (role === "user") data.system = `迁移自 ${sessionMeta.sourceClient} 的对话记录`;

      db.prepare(
        `INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data)
         VALUES (?, ?, 'main', ?, ?, ?)`,
      ).run(msgId, sessionId, ts, ts, JSON.stringify(data));
      db.prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        newId("prt"),
        msgId,
        sessionId,
        ts,
        ts,
        JSON.stringify({ type: "text", text, synthetic: item.type !== "message" }),
      );
      if ("itemId" in item && item.itemId) idMap.set(item.itemId, msgId);
      lastMsgId = msgId;
      inserted++;
    }
    return inserted;
  }
}

export function createMimoAdapter(paths?: ClientPathsLike): MimoAdapter {
  return new MimoAdapter(paths);
}
export { discoverMimo };
