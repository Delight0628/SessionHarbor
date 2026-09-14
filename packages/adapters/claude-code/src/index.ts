/**
 * Claude Code 适配器
 * 正文: ~/.claude/projects/<路径转义目录>/<uuid>.jsonl
 * 行: {parentUuid, uuid, type, message, timestamp, cwd, gitBranch, ...}
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  claudeCwdEncode,
  createHeader,
  discoverClaudeCode,
  extractTextFromContent,
  isoToMs,
  msToIso,
  type Adapter,
  type ClientPathsLike,
  type HarborIR,
  type HarborItem,
  type SessionSummary,
  type WriteResult,
  type ContentBlock,
} from "@sessionharbor/core";

type Json = Record<string, unknown>;

export class ClaudeCodeAdapter implements Adapter {
  id = "claude-code";
  displayName = "Claude Code";
  capabilities = { read: true, write: true, incremental: false, live: false };
  constructor(private paths?: ClientPathsLike) {}

  discover(): ClientPathsLike {
    if (!this.paths) this.paths = discoverClaudeCode();
    return this.paths;
  }

  private ensure(): ClientPathsLike {
    return this.paths ?? this.discover();
  }

  async listSessions(opts?: { loadMessages?: boolean }): Promise<SessionSummary[]> {
    const p = this.ensure();
    const root = p.projectsRoot!;
    const out: SessionSummary[] = [];
    if (!fs.existsSync(root)) return out;
    for (const dir of fs.readdirSync(root)) {
      const dirPath = path.join(root, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      if (dir === "memory") continue;
      for (const f of fs.readdirSync(dirPath)) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = path.join(dirPath, f);
        const id = f.replace(/\.jsonl$/, "");
        let title = id;
        let cwd: string | undefined;
        let createdAtMs: number | undefined;
        let updatedAtMs: number | undefined;
        let messageCount = 0;
        try {
          const lines = fs.readFileSync(fp, "utf-8").split(/\r?\n/).filter(Boolean);
          for (const line of lines) {
            let o: Json;
            try {
              o = JSON.parse(line) as Json;
            } catch {
              continue;
            }
            const t = o.type;
            if (t === "user" || t === "assistant") {
              messageCount++;
              if (!createdAtMs) createdAtMs = isoToMs(o.timestamp);
              updatedAtMs = isoToMs(o.timestamp) ?? updatedAtMs;
              if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
              if (t === "user" && title === id) {
                const text = extractTextFromContent((o.message as Json | undefined)?.content);
                const cleaned = text.replace(/<system-reminder\b[\s\S]*?<\/system-reminder>/g, "").trim();
                if (cleaned) title = cleaned.slice(0, 80).replace(/\s+/g, " ");
              }
            }
          }
        } catch {
          /* skip unreadable */
        }
        out.push({
          id,
          title,
          cwd,
          group: cwd ? path.basename(cwd) : undefined,
          createdAtMs,
          updatedAtMs,
          messageCount: opts?.loadMessages === false ? undefined : messageCount,
          meta: { projectDir: dir, filePath: fp },
        });
      }
    }
    out.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    return out;
  }

  async readSession(id: string): Promise<HarborIR> {
    const p = this.ensure();
    const root = p.projectsRoot!;
    // find file
    let filePath: string | undefined;
    let projectDir: string | undefined;
    for (const dir of fs.readdirSync(root)) {
      const cand = path.join(root, dir, `${id}.jsonl`);
      if (fs.existsSync(cand)) {
        filePath = cand;
        projectDir = dir;
        break;
      }
    }
    if (!filePath) throw new Error(`Claude Code 会话不存在: ${id}`);

    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
    const items: HarborItem[] = [];
    let title = id;
    let cwd: string | undefined;
    let gitBranch: string | undefined;
    let model: string | undefined;
    let createdAt: string | undefined;
    let updatedAt: string | undefined;
    let parentMap = new Map<string, string>(); // uuid -> itemId
    let lastUserItemId: string | undefined;

    for (const line of lines) {
      let o: Json;
      try {
        o = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      const type = o.type as string;
      const ts = typeof o.timestamp === "string" ? o.timestamp : undefined;
      if (ts) {
        if (!createdAt) createdAt = ts;
        updatedAt = ts;
      }
      if (typeof o.cwd === "string" && o.cwd) cwd = o.cwd;
      if (typeof o.gitBranch === "string" && o.gitBranch) gitBranch = o.gitBranch;
      const uuid = typeof o.uuid === "string" ? o.uuid : randomUUID();
      const parentUuid = typeof o.parentUuid === "string" ? o.parentUuid : undefined;
      const parentItemId = parentUuid ? parentMap.get(parentUuid) : undefined;

      if (type === "user" || type === "assistant") {
        const msg = (o.message ?? {}) as Json;
        if (!model && typeof msg.model === "string") model = msg.model;
        if (type === "user" && title === id) {
          const text = extractTextFromContent(msg.content).replace(
            /<system-reminder\b[\s\S]*?<\/system-reminder>/g,
            "",
          ).trim();
          if (text) title = text.slice(0, 80).replace(/\s+/g, " ");
        }
        const content = contentToBlocks(msg.content);
        const itemId = `item_${uuid.replace(/-/g, "").slice(0, 20)}`;
        items.push({
          type: "message",
          itemId,
          role: type === "user" ? "user" : "assistant",
          content,
          parentItemId,
          timestamp: ts,
          model: typeof msg.model === "string" ? msg.model : undefined,
        });
        parentMap.set(uuid, itemId);
        if (type === "user") lastUserItemId = itemId;
      } else if (type === "assistant_thinking" || type === "thinking") {
        // rare
      } else if (type === "system") {
        // skip agent system noise in IR body
      } else if (type === "attachment") {
        const itemId = `item_${uuid.replace(/-/g, "").slice(0, 20)}`;
        items.push({
          type: "file_ref",
          itemId,
          uri: String((o.attachment as Json | undefined)?.filePath ?? o.uuid ?? "attachment"),
          kind: "attachment",
        });
        parentMap.set(uuid, itemId);
      }
    }

    const header = createHeader(
      {
        id,
        sourceClient: "claude-code",
        sourceSessionId: id,
        title,
        createdAt,
        updatedAt,
        cwd,
        gitBranch,
        model,
      },
      { projectDir },
    );
    return { header, items };
  }

  async writeSession(ir: HarborIR, opts?: { overwrite?: boolean }): Promise<WriteResult> {
    const p = this.ensure();
    const s = ir.header.session;
    const cwd = s.cwd || process.cwd();
    const encoded = claudeCwdEncode(cwd);
    const dir = path.join(p.projectsRoot!, encoded);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = s.sourceSessionId || s.id;
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(filePath) && !opts?.overwrite) {
      return {
        status: "skipped",
        sessionId,
        reason: `已存在 ${filePath}`,
        targetPath: filePath,
      };
    }

    const lines: string[] = [];
    let parentUuid: string | null = null;
    let msgCount = 0;
    for (const item of ir.items) {
      if (item.type !== "message") {
        // thinking → 也写成 assistant 消息块的一部分？简化：跳过独立 thinking，或并入后续
        if (item.type === "thinking") {
          // 写成一条 assistant thinking 消息
          const uuid = randomUUID();
          const ts = item.timestamp ?? s.updatedAt ?? s.createdAt ?? new Date().toISOString();
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
              timestamp: ts,
              cwd,
              sessionId,
              version: "sessionharbor-0.1",
              gitBranch: s.gitBranch ?? null,
            }),
          );
          parentUuid = uuid;
          msgCount++;
        }
        continue;
      }
      const uuid = randomUUID();
      const ts = item.timestamp ?? s.updatedAt ?? s.createdAt ?? new Date().toISOString();
      const text = item.content
        .map((b) => (b.type === "text" ? b.text : b.type === "thinking" ? b.text : ""))
        .filter(Boolean)
        .join("\n");
      if (!text.trim()) continue;
      if (item.role === "user") {
        lines.push(
          JSON.stringify({
            parentUuid,
            isSidechain: false,
            promptId: `prompt_${uuid.replace(/-/g, "").slice(0, 16)}`,
            type: "user",
            message: { role: "user", content: text },
            uuid,
            timestamp: ts,
            cwd,
            sessionId,
            version: "sessionharbor-0.1",
            gitBranch: s.gitBranch ?? null,
            userType: "external",
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
            timestamp: ts,
            cwd,
            sessionId,
            version: "sessionharbor-0.1",
            gitBranch: s.gitBranch ?? null,
          }),
        );
      } else {
        lines.push(
          JSON.stringify({
            parentUuid,
            type: "system",
            message: { role: "system", content: text },
            uuid,
            timestamp: ts,
            cwd,
            sessionId,
            version: "sessionharbor-0.1",
          }),
        );
      }
      parentUuid = uuid;
      msgCount++;
    }

    fs.writeFileSync(filePath, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
    return {
      status: "ok",
      sessionId,
      messageCount: msgCount,
      targetPath: filePath,
      detail: { projectDir: encoded, title: s.title },
    };
  }
}

function contentToBlocks(content: unknown): ContentBlock[] {
  if (content == null) return [];
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
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
        callId: String(o.tool_use_id ?? o.toolUseId ?? ""),
        output: extractTextFromContent(o.content),
        isError: Boolean(o.is_error ?? o.isError),
      });
    }
  }
  return blocks;
}

export function createClaudeCodeAdapter(paths?: ClientPathsLike): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter(paths);
}
