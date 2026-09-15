/**
 * WorkBuddy 适配器
 * 元数据: ~/.workbuddy/workbuddy.db  表 sessions
 * 正文:   ~/.workbuddy/projects/<编码cwd>/<sessionId>.jsonl
 * 行: {id, parentId, timestamp(ms), type:"message", role, status,
 *      content:[{type:input_text|output_text,text}], sessionId, cwd}
 * cwd 编码: D:\alink -> d-alink
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createHeader,
  discoverWorkbuddy,
  extractTextFromContent,
  openRo,
  openRw,
  wbCwdEncode,
  type Adapter,
  type ClientPathsLike,
  type HarborIR,
  type HarborItem,
  type SessionSummary,
  type WriteResult,
  type ContentBlock,
} from "@sessionharbor/core";

type Json = Record<string, unknown>;

function msToIso(ms?: number | null): string | undefined {
  if (ms == null || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

export class WorkbuddyAdapter implements Adapter {
  id = "workbuddy";
  displayName = "WorkBuddy";
  capabilities = { read: true, write: true, incremental: false, live: false };
  constructor(private paths?: ClientPathsLike) {}

  discover(): ClientPathsLike {
    if (!this.paths) this.paths = discoverWorkbuddy();
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
          `SELECT id, cwd, title, custom_title, created_at, updated_at, deleted_at, status
           FROM sessions`,
        )
        .all() as Array<Json>;
      return rows.map((r) => {
        const cwd = (r.cwd as string) || "";
        const title = String(r.custom_title || r.title || r.id);
        let messageCount: number | undefined;
        if (p.projectsRoot) {
          const jp = path.join(p.projectsRoot, wbCwdEncode(cwd || "D:\\default"), `${r.id}.jsonl`);
          if (fs.existsSync(jp)) {
            try {
              messageCount = fs
                .readFileSync(jp, "utf-8")
                .split(/\r?\n/)
                .filter((l) => {
                  try {
                    const o = JSON.parse(l) as Json;
                    return o.type === "message" && (o.role === "user" || o.role === "assistant");
                  } catch {
                    return false;
                  }
                }).length;
            } catch {
              /* ignore */
            }
          }
        }
        return {
          id: String(r.id),
          title,
          createdAtMs: Number(r.created_at) || undefined,
          updatedAtMs: Number(r.updated_at) || undefined,
          cwd: cwd || undefined,
          group: cwd ? path.basename(cwd) : undefined,
          messageCount,
          deleted: Boolean(r.deleted_at),
          meta: { status: r.status },
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
          `SELECT id, cwd, title, custom_title, created_at, updated_at, model, status
           FROM sessions WHERE id = ?`,
        )
        .get(id) as Json | undefined;
      if (!row) throw new Error(`WorkBuddy 会话不存在: ${id}`);
      const cwd = (row.cwd as string) || "";
      const title = String(row.custom_title || row.title || id);
      const createdMs = Number(row.created_at) || undefined;
      const updatedMs = Number(row.updated_at) || undefined;
      const model = (row.model as string) || undefined;

      const items: HarborItem[] = [];
      const trackedFiles = new Set<string>();
      let editCount = 0;
      let toolCount = 0;
      const jp = p.projectsRoot
        ? path.join(p.projectsRoot, wbCwdEncode(cwd || "D:\\default"), `${id}.jsonl`)
        : undefined;
      if (jp && fs.existsSync(jp)) {
        const lines = fs.readFileSync(jp, "utf-8").split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          let o: Json;
          try {
            o = JSON.parse(line) as Json;
          } catch {
            continue;
          }
          const ts = Number(o.timestamp) || undefined;
          const tsIso = msToIso(ts);
          const rawType = String(o.type || "");

          if (rawType === "message") {
            const role = o.role;
            if (role !== "user" && role !== "assistant") continue;
            const text = extractTextFromContent(o.content);
            if (!text.trim()) continue;
            items.push({
              type: "message",
              itemId: `item_${String(o.id ?? randomUUID()).replace(/-/g, "").slice(0, 20)}`,
              role,
              content: [{ type: "text", text }],
              parentItemId:
                typeof o.parentId === "string"
                  ? `item_${o.parentId.replace(/-/g, "").slice(0, 20)}`
                  : undefined,
              timestamp: tsIso,
            });
            continue;
          }

          if (rawType === "reasoning") {
            const text =
              extractTextFromContent(o.content) ||
              extractTextFromContent(o.rawContent) ||
              "";
            if (text.trim()) {
              items.push({
                type: "thinking",
                itemId: `item_${String(o.id ?? randomUUID()).replace(/-/g, "").slice(0, 20)}`,
                text: text.trim(),
                timestamp: tsIso,
              });
            }
            continue;
          }

          if (rawType === "function_call") {
            toolCount++;
            const name = String(o.name || "tool");
            if (name === "Edit" || name === "Write" || name === "apply_patch") editCount++;
            let input: unknown = o.arguments;
            if (typeof input === "string") {
              try {
                input = JSON.parse(input);
              } catch {
                /* keep string */
              }
            }
            // 从 Edit/Write 参数抓取文件路径
            if (input && typeof input === "object") {
              const file =
                (input as Json).file_path ||
                (input as Json).path ||
                (input as Json).filename ||
                (input as Json).absolute_path;
              if (typeof file === "string" && file) trackedFiles.add(file);
            }
            items.push({
              type: "tool_call",
              itemId: `item_${String(o.id ?? randomUUID()).replace(/-/g, "").slice(0, 20)}`,
              callId: String(o.callId || o.id || randomUUID()),
              toolName: name,
              input,
              timestamp: tsIso,
            });
            continue;
          }

          if (rawType === "function_call_result") {
            const output = extractTextFromContent(o.output);
            items.push({
              type: "tool_output",
              itemId: `item_${String(o.id ?? randomUUID()).replace(/-/g, "").slice(0, 20)}`,
              callId: String(o.callId || ""),
              output,
              isError: String(o.status || "") !== "success" && String(o.status || "") !== "completed",
              timestamp: tsIso,
            });
            continue;
          }

          if (rawType === "file-history-snapshot") {
            const snap = (o.snapshot ?? {}) as Json;
            const backups = (snap.trackedFileBackups ?? {}) as Record<string, unknown>;
            for (const f of Object.keys(backups)) trackedFiles.add(f);
            continue;
          }

          if (rawType === "ai-title") {
            const t = String(o.aiTitle || "");
            if (t) {
              // 标题已在 header，忽略
            }
          }
        }
      }

      // 产物汇总 checkpoint（对话级状态栏/文件卡片）
      if (trackedFiles.size || editCount) {
        items.push({
          type: "checkpoint",
          itemId: `item_ckpt_${id.replace(/-/g, "").slice(0, 16)}`,
          label: `产物汇总：编辑 ${editCount} 次 · 相关文件 ${trackedFiles.size} 个 · 工具调用 ${toolCount} 次`,
          files: [...trackedFiles],
        });
      }

      const header = createHeader(
        {
          id,
          sourceClient: "workbuddy",
          sourceSessionId: id,
          title,
          createdAt: msToIso(createdMs),
          updatedAt: msToIso(updatedMs),
          cwd: cwd || undefined,
          model,
        },
        {
          status: row.status,
          summary: {
            editCount,
            toolCount,
            trackedFiles: [...trackedFiles],
          },
        },
      );
      return { header, items };
    } finally {
      db.close();
    }
  }

  async writeSession(ir: HarborIR, opts?: { overwrite?: boolean }): Promise<WriteResult> {
    const p = this.ensure();
    const s = ir.header.session;
    const sessionId = /^[0-9a-f-]{36}$/i.test(s.sourceSessionId || "")
      ? s.sourceSessionId!
      : randomUUID();
    const cwd = s.cwd || "D:\\SessionHarborDefault";
    const createdMs = s.createdAt ? Date.parse(s.createdAt) : Date.now();
    const updatedMs = s.updatedAt ? Date.parse(s.updatedAt) : createdMs;

    const db = openRw(p.primaryDb!);
    try {
      const existing = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(sessionId);
      if (existing && !opts?.overwrite) {
        return { status: "skipped", sessionId, reason: "session exists" };
      }
      const urow = db.prepare(`SELECT user_id FROM sessions LIMIT 1`).get() as
        | { user_id?: string }
        | undefined;
      const userId = urow?.user_id || "migrated";

      db.exec(`BEGIN`);
      if (existing && opts?.overwrite) {
        db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
      }

      db.prepare(
        `INSERT OR REPLACE INTO sessions
         (id, cwd, user_id, title, custom_title, status, created_at, updated_at,
          deleted_at, is_playground, mode)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, NULL, 0, 'craft')`,
      ).run(sessionId, cwd, userId, s.title || sessionId, null, createdMs, updatedMs);

      db.prepare(
        `INSERT OR REPLACE INTO workspaces (path, last_opened_at) VALUES (?, ?)`,
      ).run(cwd, updatedMs);

      db.exec(`COMMIT`);

      let msgCount = 0;
      let jp: string | undefined;
      if (p.projectsRoot) {
        const enc = wbCwdEncode(cwd);
        const dir = path.join(p.projectsRoot, enc);
        fs.mkdirSync(dir, { recursive: true });
        jp = path.join(dir, `${sessionId}.jsonl`);
        const lines: string[] = [];
        let parent: string | null = null;
        for (const item of ir.items) {
          if (item.type !== "message") {
            if (item.type === "thinking") {
              const u = randomUUID();
              const ts = item.timestamp ? Date.parse(item.timestamp) : updatedMs;
              lines.push(
                JSON.stringify({
                  id: u,
                  parentId: parent,
                  timestamp: ts,
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: `[thinking] ${item.text}` }],
                  sessionId,
                  cwd,
                }),
              );
              parent = u;
              msgCount++;
            }
            continue;
          }
          const text = item.content
            .map((b) => (b.type === "text" ? b.text : ""))
            .filter(Boolean)
            .join("\n");
          if (!text.trim()) continue;
          const u = randomUUID();
          const ts = item.timestamp ? Date.parse(item.timestamp) : updatedMs;
          const content =
            item.role === "user"
              ? [{ type: "input_text", text }]
              : [{ type: "output_text", text }];
          lines.push(
            JSON.stringify({
              id: u,
              parentId: parent,
              timestamp: ts,
              type: "message",
              role: item.role,
              status: "completed",
              content,
              sessionId,
              cwd,
            }),
          );
          parent = u;
          msgCount++;
        }
        fs.writeFileSync(jp, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
      }

      return {
        status: "ok",
        sessionId,
        messageCount: msgCount,
        targetPath: jp,
        detail: { cwd, title: s.title },
      };
    } catch (e) {
      try {
        db.exec(`ROLLBACK`);
      } catch {
        /* ignore */
      }
      return {
        status: "failed",
        sessionId: s.id,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      db.close();
    }
  }
}

export function createWorkbuddyAdapter(paths?: ClientPathsLike): WorkbuddyAdapter {
  return new WorkbuddyAdapter(paths);
}
