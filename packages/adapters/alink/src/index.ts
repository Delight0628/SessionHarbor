/**
 * 领慧AI工作台 (alink) 适配器
 * 元数据: %APPDATA%/alink/messages_*_PROD.sqlite  表 alink_session
 * 正文:   %APPDATA%/alink/user/messages/<sessionId>.jsonl
 * 信封:   {type, sessionId, timestamp, data}  data 内为 Claude Agent SDK 事件
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  createHeader,
  discoverAlink,
  extractTextFromContent,
  isoToMs,
  msToAlinkStr,
  openRo,
  openRw,
  claudeCwdEncode,
  stripReminders,
  type Adapter,
  type ClientPathsLike,
  type HarborIR,
  type HarborItem,
  type SessionSummary,
  type WriteResult,
  type ContentBlock,
} from "@sessionharbor/core";

type Json = Record<string, unknown>;

const VALID_ENGINES = new Set(["claude", "deepseek-harness", "local-agent-harness"]);

/**
 * 写入时默认使用 claude 引擎：我们落地的是 Claude Agent SDK 事件流信封。
 * 若标成 local-agent-harness，领慧无法用 Claude 转录 resume，会提示「历史会话已过期」。
 */
function normalizeEngine(v: unknown): string {
  const s = String(v ?? "").toLowerCase();
  if (s === "claude" || s === "deepseek-harness") return s;
  return "claude";
}

function isoZ(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "000Z").replace(/(\.\d{3})\d*Z$/, "$1Z");
}

export class AlinkAdapter implements Adapter {
  id = "alink";
  displayName = "领慧AI工作台";
  capabilities = { read: true, write: true, incremental: false, live: false };
  constructor(private paths?: ClientPathsLike) {}

  discover(): ClientPathsLike {
    if (!this.paths) this.paths = discoverAlink();
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
          `SELECT sessionId, name, createdAt, updatedAt, cwd, isFavorite,
                  selectedModelId, agentEngine, sessionType, userId
           FROM alink_session ORDER BY updatedAt DESC`,
        )
        .all() as Array<Json>;
      const out: SessionSummary[] = rows.map((r) => {
        const cwd = (r.cwd as string) || undefined;
        return {
          id: String(r.sessionId),
          title: String(r.name || r.sessionId),
          createdAtMs: isoToMs(r.createdAt),
          updatedAtMs: isoToMs(r.updatedAt),
          cwd,
          group: cwd ? path.basename(cwd) : undefined,
          model: (r.selectedModelId as string) || undefined,
          meta: {
            kind: "alink_session",
            agentEngine: r.agentEngine,
            sessionType: r.sessionType,
            userId: r.userId,
            favorite: Boolean(r.isFavorite),
          },
        };
      });
      return out;
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
          `SELECT sessionId, name, createdAt, updatedAt, cwd, selectedModelId, agentEngine
           FROM alink_session WHERE sessionId = ?`,
        )
        .get(id) as Json | undefined;
      const title = String(row?.name || id);
      const cwd = (row?.cwd as string) || undefined;
      const model = (row?.selectedModelId as string) || undefined;
      const createdAt = row?.createdAt ? String(row.createdAt) : undefined;
      const updatedAt = row?.updatedAt ? String(row.updatedAt) : undefined;
      const createdAtMs = isoToMs(createdAt);
      const updatedAtMs = isoToMs(updatedAt);

      const jsonlPath = p.jsonlDir ? path.join(p.jsonlDir, `${id}.jsonl`) : undefined;
      const items: HarborItem[] = [];
      if (jsonlPath && fs.existsSync(jsonlPath)) {
        const lines = fs.readFileSync(jsonlPath, "utf-8").split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          let env: Json;
          try {
            env = JSON.parse(line) as Json;
          } catch {
            continue;
          }
          const t = env.type as string;
          const ts = typeof env.timestamp === "string" ? env.timestamp : undefined;
          const data = (env.data ?? {}) as Json;
          if (t === "system") {
            // init 信息已进 header，note 保留
            const subtype = data.subtype;
            if (subtype === "note" || subtype === "warning") {
              const text = String(data.text ?? data.message ?? "");
              if (text) {
                items.push({
                  type: "message",
                  itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
                  role: "system",
                  content: [{ type: "text", text }],
                  timestamp: ts,
                });
              }
            }
            continue;
          }
          if (t === "prompt") {
            const text = String(data.prompt ?? "");
            if (text) {
              items.push({
                type: "message",
                itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
                role: "user",
                content: [{ type: "text", text }],
                timestamp: ts,
              });
            }
            continue;
          }
          if (t === "user") {
            const msg = (data.message ?? {}) as Json;
            const content = msg.content;
            if (isToolResultOnly(content)) continue;
            const blocks = contentToBlocks(content);
            if (!blocks.length) continue;
            items.push({
              type: "message",
              itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
              role: "user",
              content: blocks,
              timestamp: ts,
            });
            continue;
          }
          if (t === "assistant") {
            const msg = (data.message ?? {}) as Json;
            const blocks = contentToBlocks(msg.content);
            if (!blocks.length) continue;
            // 把 tool_call / thinking 拆成独立 item，text 留在 message
            const texts = blocks.filter((b) => b.type === "text") as Array<{ type: "text"; text: string }>;
            const thinkings = blocks.filter((b) => b.type === "thinking") as Array<{ type: "thinking"; text: string }>;
            const calls = blocks.filter((b) => b.type === "tool_call") as Array<{
              type: "tool_call";
              callId: string;
              toolName: string;
              input: unknown;
            }>;
            const outputs = blocks.filter((b) => b.type === "tool_output") as Array<{
              type: "tool_output";
              callId: string;
              output: string;
              isError?: boolean;
            }>;
            for (const th of thinkings) {
              items.push({
                type: "thinking",
                itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
                text: th.text,
                timestamp: ts,
              });
            }
            for (const c of calls) {
              items.push({
                type: "tool_call",
                itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
                callId: c.callId,
                toolName: c.toolName,
                input: c.input,
                timestamp: ts,
              });
            }
            for (const o of outputs) {
              items.push({
                type: "tool_output",
                itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
                callId: o.callId,
                output: o.output,
                isError: o.isError,
                timestamp: ts,
              });
            }
            if (texts.length) {
              items.push({
                type: "message",
                itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
                role: "assistant",
                content: texts,
                timestamp: ts,
                model: typeof msg.model === "string" ? msg.model : model,
              });
            }
            continue;
          }
          if (t === "artifact_card") {
            const art = (data.artifact ?? {}) as Json;
            items.push({
              type: "file_ref",
              itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
              uri: String(art.fileName ?? art.filePath ?? "artifact"),
              kind: "artifact",
            });
          }
        }
      }

      const header = createHeader(
        {
          id,
          sourceClient: "alink",
          sourceSessionId: id,
          title,
          createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : createdAt,
          updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : updatedAt,
          cwd,
          model,
        },
        { agentEngine: row?.agentEngine, userId: row?.userId },
      );
      return { header, items };
    } finally {
      db.close();
    }
  }

  async writeSession(ir: HarborIR, opts?: { overwrite?: boolean }): Promise<WriteResult> {
    const p = this.ensure();
    const s = ir.header.session;
    let sessionId = s.sourceSessionId || s.id;
    // 非 UUID 时用 UUID5 稳定派生
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      sessionId = uuid5(`sessionharbor:alink:${s.sourceClient}:${s.id}`);
    }
    const createdMs = s.createdAt ? Date.parse(s.createdAt) : Date.now();
    const updatedMs = s.updatedAt ? Date.parse(s.updatedAt) : createdMs;
    const createdS = msToAlinkStr(createdMs) ?? msToAlinkStr(Date.now())!;
    const updatedS = msToAlinkStr(updatedMs) ?? createdS;

    const db = openRw(p.primaryDb!);
    try {
      const existing = db
        .prepare(`SELECT 1 FROM alink_session WHERE sessionId = ?`)
        .get(sessionId);
      if (existing && !opts?.overwrite) {
        // 若缺少 Claude Code 转录则补写，避免 resume 时报 No conversation found
        let ccPath: string | undefined;
        try {
          const home = process.env.USERPROFILE || process.env.HOME || "";
          const enc = claudeCwdEncode(s.cwd || "");
          const want = path.join(home, ".claude", "projects", enc, `${sessionId}.jsonl`);
          if (!fs.existsSync(want) || fs.statSync(want).size === 0) {
            ccPath = writeClaudeCodeTranscript(ir, sessionId);
            return {
              status: "ok",
              sessionId,
              messageCount: 0,
              targetPath: want,
              detail: {
                repaired: true,
                claudeCodePath: ccPath,
                note: "已补写 Claude Code 转录供 resume",
              },
            };
          }
        } catch {
          /* fallthrough */
        }
        return {
          status: "skipped",
          sessionId,
          reason: "目标已存在同 ID 会话（此前可能已迁入）。勾选覆盖或加 --overwrite 可重写",
        };
      }
      const urow = db.prepare(`SELECT userId FROM alink_session LIMIT 1`).get() as
        | { userId?: string }
        | undefined;
      const userId = urow?.userId || "migrated";

      db.exec(`BEGIN`);
      if (existing && opts?.overwrite) {
        db.prepare(`DELETE FROM alink_session WHERE sessionId = ?`).run(sessionId);
      }

      db.prepare(
        `INSERT OR REPLACE INTO alink_session
         (sessionId, name, messages, userId, createdAt, updatedAt, cwd,
          artifacts, isFavorite, sessionType, selectedModelId, agentEngine)
         VALUES (?, ?, '[]', ?, ?, ?, ?, '[]', 0, 'normal', ?, ?)`,
      ).run(
        sessionId,
        s.title || sessionId,
        userId,
        createdS,
        updatedS,
        s.cwd || "",
        s.model || "",
        // 必须是 claude，否则领慧无法 resume
        "claude",
      );

      // legacy sessions + messages（简单聊天视图）
      const legacySid = ensureLegacySession(db, s.title || sessionId, createdS, updatedS, s.model, userId);
      let legacyCount = 0;
      for (const item of ir.items) {
        if (item.type !== "message") continue;
        if (item.role !== "user" && item.role !== "assistant") continue;
        const text = item.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .filter(Boolean)
          .join("\n");
        if (!text.trim()) continue;
        db.prepare(
          `INSERT INTO messages
           (message, createdAt, avatar, name, role, provider, model, sessionId, userName, isDeleted)
           VALUES (?, ?, '', ?, ?, 'MIGRATED', ?, ?, ?, 0)`,
        ).run(
          text,
          msToAlinkStr(item.timestamp ? Date.parse(item.timestamp) : createdMs) ?? createdS,
          item.model || "migrated",
          item.role,
          item.model || s.model || "",
          String(legacySid),
          userId,
        );
        legacyCount++;
      }
      db.exec(`COMMIT`);

      // JSONL（领慧 UI 展示格式）+ Claude Code 转录（resume 必需）
      let jsonlCount = 0;
      let jsonlPath: string | undefined;
      let ccPath: string | undefined;
      if (p.jsonlDir) {
        fs.mkdirSync(p.jsonlDir, { recursive: true });
        jsonlPath = path.join(p.jsonlDir, `${sessionId}.jsonl`);
        if (fs.existsSync(jsonlPath) && !opts?.overwrite) {
          // DB 已写，JSONL 跳过
        } else {
          jsonlCount = writeJsonl(jsonlPath, ir, sessionId);
        }
      }
      // 双写 ~/.claude/projects/<cwd编码>/<sessionId>.jsonl
      // 领慧 agentEngine=claude 时用 Claude Code 转录 resume，否则报
      // "No conversation found with session ID"
      try {
        ccPath = writeClaudeCodeTranscript(ir, sessionId);
      } catch (e) {
        return {
          status: "ok",
          sessionId,
          messageCount: jsonlCount || legacyCount,
          targetPath: jsonlPath,
          detail: {
            legacySessionId: legacySid,
            messagesSql: legacyCount,
            messagesJsonl: jsonlCount,
            warning: `Claude Code 转录写入失败: ${e instanceof Error ? e.message : e}`,
          },
        };
      }

      return {
        status: "ok",
        sessionId,
        messageCount: jsonlCount || legacyCount,
        targetPath: jsonlPath,
        detail: {
          legacySessionId: legacySid,
          messagesSql: legacyCount,
          messagesJsonl: jsonlCount,
          claudeCodePath: ccPath,
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
}

function ensureLegacySession(
  db: ReturnType<typeof openRw>,
  title: string,
  createdS: string,
  updatedS: string,
  model: string | undefined,
  userId: string,
): number {
  const row = db
    .prepare(`SELECT id FROM sessions WHERE name = ? ORDER BY id DESC LIMIT 1`)
    .get(title) as { id?: number } | undefined;
  if (row?.id != null) return Number(row.id);
  const info = db
    .prepare(
      `INSERT INTO sessions (name, createdAt, updatedAt, provider, model, userId, system_prompt, isFavorite)
       VALUES (?, ?, ?, 'MIGRATED', ?, ?, '', 0)`,
    )
    .run(title, createdS, updatedS, model || "", userId);
  return Number(info.lastInsertRowid);
}

/** 写 Claude Code 原生转录，供领慧 claude 引擎 resume */
function writeClaudeCodeTranscript(ir: HarborIR, sessionId: string): string {
  const s = ir.header.session;
  const cwd = s.cwd || process.cwd();
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const enc = claudeCwdEncode(cwd);
  const dir = path.join(home, ".claude", "projects", enc);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const createdMs = s.createdAt ? Date.parse(s.createdAt) : Date.now();
  const lines: string[] = [];
  let parentUuid: string | null = null;
  for (const item of ir.items) {
    const itemTs =
      "timestamp" in item && item.timestamp ? item.timestamp : new Date(createdMs).toISOString();
    if (item.type === "message") {
      let text = item.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter(Boolean)
        .join("\n");
      if (item.role === "user") text = stripReminders(text);
      if (!text.trim()) continue;
      const uuid = randomUUID();
      if (item.role === "user") {
        lines.push(
          JSON.stringify({
            parentUuid,
            isSidechain: false,
            promptId: `prompt_${uuid.replace(/-/g, "").slice(0, 16)}`,
            type: "user",
            message: { role: "user", content: text },
            uuid,
            timestamp: itemTs,
            userType: "external",
            cwd,
            sessionId,
            version: "sessionharbor-0.1",
            gitBranch: s.gitBranch ?? null,
          }),
        );
      } else if (item.role === "assistant") {
        lines.push(
          JSON.stringify({
            parentUuid,
            isSidechain: false,
            type: "assistant",
            message: {
              id: `msg_${uuid.replace(/-/g, "").slice(0, 24)}`,
              type: "message",
              role: "assistant",
              model: item.model || s.model || "migrated",
              content: [{ type: "text", text }],
            },
            uuid,
            timestamp: itemTs,
            cwd,
            sessionId,
            version: "sessionharbor-0.1",
          }),
        );
      } else {
        continue;
      }
      parentUuid = uuid;
    } else if (item.type === "thinking") {
      const uuid = randomUUID();
      lines.push(
        JSON.stringify({
          parentUuid,
          isSidechain: false,
          type: "assistant",
          message: {
            id: `msg_${uuid.replace(/-/g, "").slice(0, 24)}`,
            type: "message",
            role: "assistant",
            model: s.model || "migrated",
            content: [{ type: "thinking", thinking: item.text }],
          },
          uuid,
          timestamp: itemTs,
          cwd,
          sessionId,
          version: "sessionharbor-0.1",
        }),
      );
      parentUuid = uuid;
    } else if (item.type === "tool_call") {
      const uuid = randomUUID();
      lines.push(
        JSON.stringify({
          parentUuid,
          isSidechain: false,
          type: "assistant",
          message: {
            id: `msg_${uuid.replace(/-/g, "").slice(0, 24)}`,
            type: "message",
            role: "assistant",
            model: s.model || "migrated",
            content: [
              {
                type: "tool_use",
                id: item.callId,
                name: item.toolName,
                input: item.input,
              },
            ],
          },
          uuid,
          timestamp: itemTs,
          cwd,
          sessionId,
          version: "sessionharbor-0.1",
        }),
      );
      parentUuid = uuid;
    } else if (item.type === "tool_output") {
      const uuid = randomUUID();
      lines.push(
        JSON.stringify({
          parentUuid,
          isSidechain: false,
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: item.callId,
                content: item.output || "",
                is_error: Boolean(item.isError),
              },
            ],
          },
          uuid,
          timestamp: itemTs,
          cwd,
          sessionId,
          version: "sessionharbor-0.1",
        }),
      );
      parentUuid = uuid;
    }
  }
  fs.writeFileSync(filePath, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
  return filePath;
}

function writeJsonl(filePath: string, ir: HarborIR, sessionId: string): number {
  const s = ir.header.session;
  const createdMs = s.createdAt ? Date.parse(s.createdAt) : Date.now();
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "system",
      sessionId,
      timestamp: isoZ(createdMs),
      data: {
        type: "system",
        subtype: "init",
        cwd: s.cwd || "",
        session_id: sessionId,
        tools: [],
        mcp_servers: [],
        model: s.model || "migrated",
        permissionMode: "default",
        slash_commands: [],
        apiKeySource: "migrated",
        claude_code_version: "sessionharbor-0.1",
        output_style: "default",
        migrated_from: s.sourceClient,
        original_id: s.sourceSessionId || s.id,
        title: s.title,
      },
    }),
  );

  // 按 user prompt 切轮；每轮末尾写 result，恢复耗时/操作栏
  type Turn = {
    clientMessageId: string;
    promptLineIndex: number;
    promptTs: string;
    promptSummary: string;
    resultText: string;
    startMs: number;
    endMs: number;
    toolCount: number;
  };
  const turns: Turn[] = [];
  let current: Turn | null = null;
  let count = 0;

  const flushResult = (turn: Turn) => {
    const duration = Math.max(1000, turn.endMs - turn.startMs);
    const resultUuid = randomUUID();
    lines.push(
      JSON.stringify({
        type: "result",
        sessionId,
        timestamp: isoZ(turn.endMs),
        data: {
          type: "result",
          subtype: "success",
          is_error: false,
          duration_api_ms: duration,
          duration_ms: duration,
          num_turns: 1 + turn.toolCount,
          stop_reason: "end_turn",
          session_id: sessionId,
          total_cost_usd: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          result: turn.resultText,
          uuid: resultUuid,
          ttft_ms: Math.min(2000, duration),
          terminal_reason: "migrated",
        },
      }),
    );
    count++;
  };

  for (const item of ir.items) {
    const itemTs =
      "timestamp" in item && item.timestamp
        ? Date.parse(item.timestamp)
        : createdMs;
    const ts = isoZ(itemTs || createdMs);

    if (item.type === "message") {
      let text = item.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter(Boolean)
        .join("\n");
      if (item.role === "user") {
        // 剥离 system-reminder / git status 注入，避免出现在领慧对话流
        text = stripReminders(text)
          .replace(/^There are uncommitted git changes in this session workspace\.[\s\S]*?(?=\n\n|$)/i, "")
          .trim();
      }
      if (!text) continue;

      if (item.role === "user") {
        if (current) flushResult(current);
                const cmid = randomUUID();
        current = {
          clientMessageId: cmid,
          promptLineIndex: lines.length,
          promptTs: ts,
          promptSummary: text.slice(0, 120).replace(/\s+/g, " "),
          resultText: "",
          startMs: itemTs || createdMs,
          endMs: itemTs || createdMs,
          toolCount: 0,
        };
        turns.push(current);
        lines.push(
          JSON.stringify({
            type: "prompt",
            sessionId,
            timestamp: ts,
            data: { prompt: text, clientMessageId: cmid },
          }),
        );
        count++;
      } else if (item.role === "assistant") {
        if (current) {
          current.resultText = text.slice(0, 500);
          current.endMs = itemTs || current.endMs;
        }
        lines.push(
          JSON.stringify({
            type: "assistant",
            sessionId,
            timestamp: ts,
            data: {
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text }],
                model: item.model || s.model || "migrated",
                id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  total_tokens: 0,
                },
              },
              session_id: sessionId,
              uuid: randomUUID(),
              parent_tool_use_id: null,
            },
          }),
        );
        count++;
      }
    } else if (item.type === "thinking") {
      if (current) current.endMs = itemTs || current.endMs;
      lines.push(
        JSON.stringify({
          type: "assistant",
          sessionId,
          timestamp: ts,
          data: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: item.text }],
              model: s.model || "migrated",
            },
            session_id: sessionId,
            uuid: randomUUID(),
            parent_tool_use_id: null,
          },
        }),
      );
      count++;
    } else if (item.type === "tool_call") {
      if (current) {
        current.toolCount++;
        current.endMs = itemTs || current.endMs;
      }
      lines.push(
        JSON.stringify({
          type: "assistant",
          sessionId,
          timestamp: ts,
          data: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.callId,
                  name: item.toolName,
                  input: item.input,
                },
              ],
              model: s.model || "migrated",
            },
            session_id: sessionId,
            uuid: randomUUID(),
            parent_tool_use_id: null,
          },
        }),
      );
      count++;
    } else if (item.type === "tool_output") {
      if (current) current.endMs = itemTs || current.endMs;
      lines.push(
        JSON.stringify({
          type: "user",
          sessionId,
          timestamp: ts,
          data: {
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: item.callId,
                  content: [{ type: "text", text: item.output || "" }],
                  is_error: Boolean(item.isError),
                },
              ],
            },
            session_id: sessionId,
            uuid: randomUUID(),
            timestamp: ts,
            tool_use_result: item.output || "",
          },
        }),
      );
      count++;
    } else if (item.type === "checkpoint") {
      const files = item.files.length
        ? item.files.map((f) => `- ${f}`).join("\n")
        : "(无文件列表)";
      lines.push(
        JSON.stringify({
          type: "system",
          sessionId,
          timestamp: ts,
          data: {
            type: "system",
            subtype: "note",
            text: `[${item.label}]\n${files}`,
          },
        }),
      );
      count++;
    }
  }
  if (current) flushResult(current);

  fs.writeFileSync(filePath, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");

  // prompt-navigation.json 边车（fork/跳转/摘要）
  try {
    const nav = {
      version: 1,
      source: {
        size: fs.statSync(filePath).size,
        mtimeMs: Date.now(),
        ino: 0,
      },
      items: turns.map((t) => ({
        id: `client:${t.clientMessageId}`,
        promptLineIndex: t.promptLineIndex,
        promptTimestamp: t.promptTs,
        promptSummary: t.promptSummary,
        resultSummary: (t.resultText || "").slice(0, 200),
      })),
    };
    fs.writeFileSync(
      filePath.replace(/\.jsonl$/, "") + ".prompt-navigation.json",
      JSON.stringify(nav),
      "utf-8",
    );
  } catch {
    /* ignore */
  }
  return count;
}

function contentToBlocks(content: unknown): ContentBlock[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const o = item as Json;
    const t = o.type;
    if (t === "text") {
      const text = typeof o.text === "string" ? o.text : "";
      if (text) blocks.push({ type: "text", text });
    } else if (t === "thinking") {
      const text = typeof o.thinking === "string" ? o.thinking : typeof o.text === "string" ? o.text : "";
      if (text) blocks.push({ type: "thinking", text });
    } else if (t === "tool_use") {
      blocks.push({
        type: "tool_call",
        callId: String(o.id ?? randomUUID()),
        toolName: String(o.name ?? "tool"),
        input: o.input,
      });
    } else if (t === "tool_result") {
      blocks.push({
        type: "tool_output",
        callId: String(o.tool_use_id ?? ""),
        output: extractTextFromContent(o.content),
        isError: Boolean(o.is_error),
      });
    }
  }
  return blocks;
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content) || !content.length) return false;
  const types = new Set(
    content.map((c) => (c && typeof c === "object" ? (c as Json).type : typeof c)),
  );
  return types.size === 1 && types.has("tool_result");
}

function uuid5(name: string): string {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const hash = createHash("sha1").update(namespace).update(name, "utf8").digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createAlinkAdapter(paths?: ClientPathsLike): AlinkAdapter {
  return new AlinkAdapter(paths);
}
