/**
 * Codex 适配器
 * 正文: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * 行: {timestamp, type: session_meta|event_msg|response_item|world_state|turn_context, payload}
 * 索引: ~/.codex/state_5.sqlite threads 表 + session_index.jsonl
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createHeader,
  extractTextFromContent,
  openRo,
  openRw,
  type Adapter,
  type ClientPathsLike,
  type HarborIR,
  type HarborItem,
  type SessionSummary,
  type WriteResult,
  type ContentBlock,
} from "@sessionharbor/core";

type Json = Record<string, unknown>;

export interface CodexPaths extends ClientPathsLike {
  sessionsRoot: string;
  stateDb?: string;
  sessionIndex?: string;
  archivedRoot?: string;
}

function discoverCodex(explicitRoot?: string): CodexPaths {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const root = explicitRoot ? path.resolve(explicitRoot) : path.join(home, ".codex");
  const sessionsRoot = path.join(root, "sessions");
  const stateDb = path.join(root, "state_5.sqlite");
  const sessionIndex = path.join(root, "session_index.jsonl");
  const archivedRoot = path.join(root, "archived_sessions");
  if (!fs.existsSync(sessionsRoot) && !fs.existsSync(stateDb)) {
    throw new Error(`未找到 Codex 数据目录: ${root}（可用 --codex-root 指定）`);
  }
  return {
    id: "codex",
    dataRoot: root,
    primaryDb: fs.existsSync(stateDb) ? stateDb : undefined,
    sessionsRoot,
    stateDb: fs.existsSync(stateDb) ? stateDb : undefined,
    sessionIndex: fs.existsSync(sessionIndex) ? sessionIndex : undefined,
    archivedRoot: fs.existsSync(archivedRoot) ? archivedRoot : undefined,
    extraDbs: [],
  };
}

function normalizeCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  // strip \\?\ prefix
  return cwd.replace(/^\\\\\?\\/, "");
}

function parseContentBlocks(content: unknown): ContentBlock[] {
  if (content == null) return [];
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return extractTextFromContent(content)
      ? [{ type: "text", text: extractTextFromContent(content) }]
      : [];
  }
  const blocks: ContentBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const o = item as Json;
    const t = o.type;
    if (t === "input_text" || t === "output_text" || t === "text") {
      const text = String(o.text ?? "");
      if (text) blocks.push({ type: "text", text });
    } else if (t === "refusal") {
      /* skip */
    }
  }
  return blocks;
}

export class CodexAdapter implements Adapter {
  id = "codex";
  displayName = "Codex";
  capabilities = { read: true, write: true, incremental: false, live: false };
  private paths?: CodexPaths;

  constructor(paths?: CodexPaths) {
    this.paths = paths;
  }

  discover(): CodexPaths {
    if (!this.paths) this.paths = discoverCodex();
    return this.paths;
  }

  private ensure(): CodexPaths {
    return (this.paths ?? this.discover()) as CodexPaths;
  }

  private loadThreadIndex(): Map<string, Json> {
    const p = this.ensure();
    const map = new Map<string, Json>();
    if (p.primaryDb && fs.existsSync(p.primaryDb)) {
      try {
        const db = openRo(p.primaryDb);
        const rows = db
          .prepare(
            `SELECT id, rollout_path, created_at_ms, updated_at_ms, cwd, title,
                    model, archived, first_user_message, preview
             FROM threads`,
          )
          .all() as Array<Json>;
        db.close();
        for (const r of rows) map.set(String(r.id), r);
      } catch {
        /* fall through */
      }
    }
    // session_index.jsonl fallback
    if (map.size === 0 && p.sessionIndex && fs.existsSync(p.sessionIndex)) {
      const lines = fs.readFileSync(p.sessionIndex, "utf-8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const o = JSON.parse(line) as Json;
          if (o.id) map.set(String(o.id), o);
        } catch {
          /* skip */
        }
      }
    }
    return map;
  }

  private findRolloutFile(threadId: string, rolloutPath?: string): string | undefined {
    if (rolloutPath) {
      const cleaned = normalizeCwd(rolloutPath)!;
      // rollout_path may be truncated; try exact then glob
      if (fs.existsSync(cleaned)) return cleaned;
      const dir = path.dirname(cleaned);
      const base = path.basename(cleaned);
      if (fs.existsSync(dir)) {
        const hit = fs.readdirSync(dir).find((f) => f.startsWith(base.replace(/\.jsonl$/, "")) && f.endsWith(".jsonl"));
        if (hit) return path.join(dir, hit);
      }
    }
    // search sessions tree by thread id in filename
    const p = this.ensure();
    const roots = [p.sessionsRoot, p.archivedRoot].filter(Boolean) as string[];
    for (const root of roots) {
      const found = walkFind(root, threadId, 6);
      if (found) return found;
    }
    return undefined;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const threads = this.loadThreadIndex();
    const out: SessionSummary[] = [];
    // also scan filesystem for rollouts not in index
    const seen = new Set<string>();
    for (const [id, r] of threads) {
      if (Number(r.archived ?? 0) === 1 && !process.env.HARBOR_INCLUDE_ARCHIVED) {
        // still list but mark
      }
      const cwd = normalizeCwd(r.cwd as string | undefined);
      const title = String(r.title || r.preview || r.name || r.thread_name || id);
      const createdMs =
        Number(r.created_at_ms) || (Number(r.created_at) ? Number(r.created_at) * 1000 : undefined);
      const updatedMs =
        Number(r.updated_at_ms) || (Number(r.updated_at) ? Number(r.updated_at) * 1000 : undefined);
      out.push({
        id,
        title,
        cwd,
        group: cwd ? path.basename(cwd) : undefined,
        createdAtMs: createdMs,
        updatedAtMs: updatedMs,
        model: (r.model as string) || undefined,
        deleted: Number(r.archived ?? 0) === 1,
        meta: {
          rolloutPath: r.rollout_path,
          source: r.source,
          archived: Number(r.archived ?? 0) === 1,
        },
      });
      seen.add(id);
    }
    out.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    return out;
  }

  async readSession(id: string): Promise<HarborIR> {
    const threads = this.loadThreadIndex();
    const meta = threads.get(id);
    const filePath = this.findRolloutFile(id, meta?.rollout_path as string | undefined);
    if (!filePath) throw new Error(`Codex rollout 不存在: ${id}`);

    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
    const items: HarborItem[] = [];
    let title = String(meta?.title || id);
    let cwd = normalizeCwd(meta?.cwd as string | undefined);
    let model = (meta?.model as string) || undefined;
    let createdAt: string | undefined;
    let updatedAt: string | undefined;
    let firstUser = true;

    for (const line of lines) {
      let o: Json;
      try {
        o = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      const ts = typeof o.timestamp === "string" ? o.timestamp : undefined;
      if (ts) {
        if (!createdAt) createdAt = ts;
        updatedAt = ts;
      }
      const payload = (o.payload ?? {}) as Json;
      const topType = o.type;

      if (topType === "session_meta") {
        cwd = normalizeCwd(payload.cwd as string) || cwd;
        continue;
      }
      if (topType === "turn_context") {
        if (payload.model) model = String(payload.model);
        continue;
      }
      if (topType === "event_msg") {
        const et = payload.type;
        if (et === "user_message") {
          const text = String(payload.message ?? "");
          if (text) {
            items.push({
              type: "message",
              itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
              role: "user",
              content: [{ type: "text", text }],
              timestamp: ts,
            });
            if (firstUser && title === id) {
              title = text.slice(0, 80).replace(/\s+/g, " ");
              firstUser = false;
            }
          }
        }
        // agent_message 与 response_item.message 重复，跳过
        continue;
      }
      if (topType !== "response_item") continue;

      const rt = payload.type;
      if (rt === "message") {
        const role = payload.role;
        if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer") continue;
        // developer/system 上下文噪音默认跳过正文索引，但保留 system
        if (role === "developer") continue;
        if (role === "user") {
          // 环境上下文等注入：若已有 user_message 事件则可能重复
          const text = extractTextFromContent(payload.content);
          if (!text.trim()) continue;
          // 环境/文件注入块标记为 system
          if (text.includes("<environment_context>") || text.includes("# Files mentioned by the user:")) {
            continue;
          }
          items.push({
            type: "message",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            role: "user",
            content: parseContentBlocks(payload.content),
            timestamp: ts,
          });
        } else {
          const blocks = parseContentBlocks(payload.content);
          if (!blocks.length) continue;
          items.push({
            type: "message",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            role: role as "assistant" | "system",
            content: blocks,
            timestamp: ts,
          });
        }
      } else if (rt === "reasoning") {
        const summary = extractTextFromContent(payload.summary);
        const body = extractTextFromContent(payload.content);
        const text = [summary, body].filter(Boolean).join("\n");
        if (text) {
          items.push({
            type: "thinking",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            text,
            timestamp: ts,
          });
        }
      } else if (rt === "function_call" || rt === "local_shell_call" || rt === "custom_tool_call") {
        const callId = String(payload.call_id ?? payload.id ?? randomUUID());
        const toolName = String(payload.name ?? "tool");
        let input: unknown = payload.input ?? payload.arguments ?? payload.action ?? {};
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {
            /* keep string */
          }
        }
        items.push({
          type: "tool_call",
          itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          callId,
          toolName,
          input,
          timestamp: ts,
        });
      } else if (
        rt === "function_call_output" ||
        rt === "custom_tool_call_output" ||
        rt === "local_shell_call_output"
      ) {
        const callId = String(payload.call_id ?? "");
        const output = extractTextFromContent(payload.output);
        items.push({
          type: "tool_output",
          itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          callId,
          output,
          isError: Boolean(payload.is_error ?? payload.isError),
          timestamp: ts,
        });
      }
    }

    const createdMs = createdAt ? Date.parse(createdAt) : Number(meta?.created_at_ms) || undefined;
    const updatedMs = updatedAt ? Date.parse(updatedAt) : Number(meta?.updated_at_ms) || undefined;
    const header = createHeader(
      {
        id,
        sourceClient: "codex",
        sourceSessionId: id,
        title,
        createdAt: createdMs ? new Date(createdMs).toISOString() : createdAt,
        updatedAt: updatedMs ? new Date(updatedMs).toISOString() : updatedAt,
        cwd,
        model,
      },
      { rolloutPath: filePath, archived: meta?.archived },
    );
    return { header, items };
  }

  async writeSession(ir: HarborIR, opts?: { overwrite?: boolean }): Promise<WriteResult> {
    const p = this.ensure();
    const s = ir.header.session;
    const sessionId =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.sourceSessionId || "")
        ? s.sourceSessionId!
        : randomUUID();
    const createdMs = s.createdAt ? Date.parse(s.createdAt) : Date.now();
    const updatedMs = s.updatedAt ? Date.parse(s.updatedAt) : createdMs;
    const cwd = normalizeCwd(s.cwd) || process.cwd();
    const tsIso = new Date(createdMs).toISOString();
    const datePart = tsIso.slice(0, 10).replace(/-/g, "/");
    // rollout-2026-07-30T09-25-31-<uuid>.jsonl
    const tsName = tsIso.replace(/:/g, "-").replace(/\.\d+Z$/, "");
    const fileName = `rollout-${tsName}-${sessionId}.jsonl`;
    const outDir = path.join(p.sessionsRoot, ...datePart.split("/"));
    const outPath = path.join(outDir, fileName);

    if (fs.existsSync(outPath) && !opts?.overwrite) {
      return { status: "skipped", sessionId, reason: `已存在 ${outPath}`, targetPath: outPath };
    }

    const lines: string[] = [];
    // session_meta
    lines.push(
      JSON.stringify({
        timestamp: tsIso,
        type: "session_meta",
        payload: {
          id: sessionId,
          timestamp: tsIso,
          cwd,
          originator: "sessionharbor",
          cli_version: "sessionharbor-0.1",
          source: "sessionharbor",
          model_provider: "migrated",
          instructions: null,
        },
      }),
    );
    lines.push(
      JSON.stringify({
        timestamp: tsIso,
        type: "turn_context",
        payload: {
          cwd,
          model: s.model || "migrated",
          approval_policy: "never",
          sandbox_policy: { type: "workspace-write" },
        },
      }),
    );

    let msgCount = 0;
    for (const item of ir.items) {
      const itemTs = "timestamp" in item && item.timestamp ? item.timestamp : tsIso;
      if (item.type === "message") {
        const text = item.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .filter(Boolean)
          .join("\n");
        if (!text.trim()) continue;
        const role = item.role === "system" ? "system" : item.role;
        if (role === "system") continue;
        // event_msg for user
        if (role === "user") {
          lines.push(
            JSON.stringify({
              timestamp: itemTs,
              type: "event_msg",
              payload: { type: "user_message", message: text },
            }),
          );
        }
        lines.push(
          JSON.stringify({
            timestamp: itemTs,
            type: "response_item",
            payload: {
              type: "message",
              id: `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
              role,
              content: [
                {
                  type: role === "user" ? "input_text" : "output_text",
                  text,
                },
              ],
            },
          }),
        );
        msgCount++;
      } else if (item.type === "thinking") {
        lines.push(
          JSON.stringify({
            timestamp: itemTs,
            type: "response_item",
            payload: {
              type: "reasoning",
              id: `rsn_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
              summary: [{ type: "summary_text", text: item.text.slice(0, 200) }],
              content: [],
            },
          }),
        );
      } else if (item.type === "tool_call") {
        lines.push(
          JSON.stringify({
            timestamp: itemTs,
            type: "response_item",
            payload: {
              type: "function_call",
              id: item.itemId,
              call_id: item.callId,
              name: item.toolName,
              arguments: typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? {}),
            },
          }),
        );
      } else if (item.type === "tool_output") {
        lines.push(
          JSON.stringify({
            timestamp: itemTs,
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: item.callId,
              output: item.output,
            },
          }),
        );
      }
    }

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf-8");

    // 回写 threads + session_index
    let indexOk = false;
    if (p.primaryDb && fs.existsSync(p.primaryDb)) {
      try {
        const db = openRw(p.primaryDb);
        db.exec(`BEGIN`);
        const existing = db.prepare(`SELECT 1 FROM threads WHERE id = ?`).get(sessionId);
        if (!existing || opts?.overwrite) {
          if (existing) db.prepare(`DELETE FROM threads WHERE id = ?`).run(sessionId);
          // insert minimal required columns
          db.prepare(
            `INSERT INTO threads
             (id, rollout_path, created_at, updated_at, source, model_provider,
              cwd, title, archived, cli_version, first_user_message, model,
              created_at_ms, updated_at_ms, thread_source, preview)
             VALUES (?, ?, ?, ?, 'sessionharbor', 'migrated', ?, ?, 0, 'sessionharbor-0.1', ?, ?, ?, ?, 'user', ?)`,
          ).run(
            sessionId,
            outPath,
            Math.floor(createdMs / 1000),
            Math.floor(updatedMs / 1000),
            cwd,
            s.title || sessionId,
            s.title || "",
            s.model || "migrated",
            createdMs,
            updatedMs,
            s.title || "",
          );
        }
        db.exec(`COMMIT`);
        db.close();
        indexOk = true;
      } catch (e) {
        indexOk = false;
        // 文件已写，索引失败仅告警
        return {
          status: "ok",
          sessionId,
          messageCount: msgCount,
          targetPath: outPath,
          detail: {
            warning: `threads 回写失败: ${e instanceof Error ? e.message : e}`,
            fileName,
          },
        };
      }
    }
    if (p.sessionIndex) {
      try {
        const entry = JSON.stringify({
          id: sessionId,
          thread_name: s.title || sessionId,
          updated_at: new Date(updatedMs).toISOString(),
        });
        fs.appendFileSync(p.sessionIndex, entry + "\n", "utf-8");
      } catch {
        /* ignore */
      }
    }

    return {
      status: "ok",
      sessionId,
      messageCount: msgCount,
      targetPath: outPath,
      detail: { fileName, threadsIndexed: indexOk },
    };
  }
}

function walkFind(root: string, needle: string, maxDepth: number): string | undefined {
  if (maxDepth < 0 || !fs.existsSync(root)) return undefined;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name.endsWith(".jsonl") && e.name.includes(needle)) return full;
    if (e.isDirectory()) {
      const hit = walkFind(full, needle, maxDepth - 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

export function createCodexAdapter(paths?: CodexPaths): CodexAdapter {
  return new CodexAdapter(paths);
}
export { discoverCodex };
