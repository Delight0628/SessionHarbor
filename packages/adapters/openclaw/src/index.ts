/**
 * OpenClaw 适配器（只读）
 * 数据: %USERPROFILE%/.openclaw/agents/<agentId>/sessions/*.jsonl
 * 行类型: session | message | model_change | thinking_level_change | custom | custom_message
 * message: { message: { role: user|assistant|toolResult, content: [...] } }
 * 安装: D:\openclaw、QClaw 等（仅 installed 判定）
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  createHeader,
  extractTextFromContent,
  type Adapter,
  type ClientPathsLike,
  type HarborIR,
  type HarborItem,
  type SessionSummary,
  type WriteResult,
} from "@sessionharbor/core";

type Json = Record<string, unknown>;

export interface OpenClawPaths extends ClientPathsLike {
  agentsRoot?: string;
  installHint?: string;
}

function firstExisting(cands: string[]): string | undefined {
  for (const p of cands) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

export function discoverOpenClaw(explicitRoot?: string): OpenClawPaths {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const roots: string[] = [];
  if (explicitRoot) roots.push(path.resolve(explicitRoot));
  roots.push(path.join(home, ".openclaw"));
  roots.push(path.join(home, "AppData", "Roaming", "QClaw", "openclaw"));

  for (const r of roots) {
    const agentsRoot = path.join(r, "agents");
    if (fs.existsSync(agentsRoot)) {
      const installHint = firstExisting([
        "D:\\openclaw\\openclaw.cmd",
        "D:\\QClaw\\QClaw.exe",
        path.join(home, ".openclaw", "openclaw.json"),
      ]);
      return {
        id: "openclaw",
        dataRoot: r,
        agentsRoot,
        installHint,
        extraDbs: [],
      };
    }
  }
  throw new Error("未找到 OpenClaw 数据目录（~/.openclaw/agents）");
}

function contentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return extractTextFromContent(content);
  if (typeof content === "object") {
    const o = content as Json;
    return extractTextFromContent(o.content ?? o.text);
  }
  return String(content);
}

interface SessionFile {
  agentId: string;
  sessionId: string;
  file: string;
}

function listSessionFiles(agentsRoot: string): SessionFile[] {
  const out: SessionFile[] = [];
  let agents: string[] = [];
  try {
    agents = fs.readdirSync(agentsRoot);
  } catch {
    return out;
  }
  for (const agent of agents) {
    const sessDir = path.join(agentsRoot, agent, "sessions");
    if (!fs.existsSync(sessDir)) continue;
    let files: string[] = [];
    try {
      files = fs.readdirSync(sessDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      if (f.includes(".trajectory.")) continue;
      if (f.startsWith(".")) continue;
      const sid = f.replace(/\.jsonl$/i, "");
      out.push({ agentId: agent, sessionId: sid, file: path.join(sessDir, f) });
    }
  }
  return out;
}

function parseSessionFile(file: string): {
  title: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  cwd?: string;
  model?: string;
  items: HarborItem[];
  messageCount: number;
} {
  const items: HarborItem[] = [];
  let title = "";
  let cwd: string | undefined;
  let model: string | undefined;
  let createdAtMs: number | undefined;
  let updatedAtMs: number | undefined;
  let messageCount = 0;
  let firstUser = "";

  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let o: Json;
    try {
      o = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const t = String(o.type || "");
    if (t === "session") {
      cwd = typeof o.cwd === "string" ? o.cwd : cwd;
      if (typeof o.timestamp === "string") {
        const ms = Date.parse(o.timestamp);
        if (Number.isFinite(ms)) createdAtMs = ms;
      }
      continue;
    }
    if (t === "model_change") {
      if (o.modelId) model = String(o.modelId);
      continue;
    }
    if (t !== "message") continue;

    const msg = (o.message ?? {}) as Json;
    const roleRaw = String(msg.role || "user").toLowerCase();
    const ts =
      typeof o.timestamp === "string"
        ? (() => {
            const ms = Date.parse(o.timestamp);
            return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
          })()
        : undefined;
    if (ts) {
      const ms = Date.parse(ts);
      if (Number.isFinite(ms)) {
        if (!createdAtMs || ms < createdAtMs) createdAtMs = ms;
        if (!updatedAtMs || ms > updatedAtMs) updatedAtMs = ms;
      }
    }

    const content = msg.content;
    if (roleRaw === "toolresult" || roleRaw === "tool_result" || roleRaw === "tool") {
      items.push({
        type: "tool_output",
        itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        callId: String(msg.toolCallId ?? msg.id ?? randomUUID()),
        output: contentToText(content).slice(0, 20000),
        timestamp: ts,
      });
      continue;
    }

    // assistant 可能含 thinking / toolCall content blocks
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Json;
        if (b.type === "thinking") {
          const th = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
          if (th.trim()) {
            items.push({
              type: "thinking",
              itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
              text: th.trim().slice(0, 20000),
              timestamp: ts,
            });
          }
        } else if (b.type === "toolCall" || b.type === "tool_use") {
          items.push({
            type: "tool_call",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            callId: String(b.toolCallId ?? b.id ?? randomUUID()),
            toolName: String(b.toolName ?? b.name ?? "tool"),
            input: b.args ?? b.input,
            timestamp: ts,
          });
        }
      }
    }

    const text = contentToText(content);
    if (!text.trim()) continue;
    messageCount++;
    if (roleRaw === "user" && !firstUser) firstUser = text.trim();
    const role = roleRaw === "assistant" ? "assistant" : roleRaw === "system" ? "system" : "user";
    items.push({
      type: "message",
      itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      role,
      content: [{ type: "text", text: text.trim() }],
      model: role === "assistant" ? model : undefined,
      timestamp: ts,
    });
  }

  title = firstUser.slice(0, 120).replace(/\s+/g, " ") || path.basename(file, ".jsonl");
  return { title, createdAtMs, updatedAtMs, cwd, model, items, messageCount };
}

export class OpenClawAdapter implements Adapter {
  id = "openclaw";
  displayName = "OpenClaw";
  capabilities = { read: true, write: false, incremental: false, live: false };
  private paths?: OpenClawPaths;
  private fileIndex = new Map<string, SessionFile>();
  private parsed = new Map<string, ReturnType<typeof parseSessionFile>>();

  constructor(paths?: OpenClawPaths) {
    this.paths = paths;
  }

  discover(): OpenClawPaths {
    if (!this.paths) this.paths = discoverOpenClaw();
    return this.paths;
  }

  private ensure(): OpenClawPaths {
    return (this.paths ?? this.discover()) as OpenClawPaths;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const p = this.ensure();
    this.fileIndex.clear();
    this.parsed.clear();
    if (!p.agentsRoot) return [];
    const files = listSessionFiles(p.agentsRoot);
    const out: SessionSummary[] = [];
    for (const sf of files) {
      // 同 sessionId 多 agent 时用 agent 前缀避免冲突
      const id = files.filter((x) => x.sessionId === sf.sessionId).length > 1
        ? `${sf.agentId}:${sf.sessionId}`
        : sf.sessionId;
      this.fileIndex.set(id, sf);
      try {
        const st = fs.statSync(sf.file);
        const parsed = parseSessionFile(sf.file);
        this.parsed.set(id, parsed);
        out.push({
          id,
          title: parsed.title || sf.sessionId,
          createdAtMs: parsed.createdAtMs ?? st.birthtimeMs,
          updatedAtMs: parsed.updatedAtMs ?? st.mtimeMs,
          cwd: parsed.cwd,
          group: parsed.cwd ? path.basename(parsed.cwd) : sf.agentId,
          model: parsed.model,
          messageCount: parsed.messageCount,
          meta: { kind: "openclaw_jsonl", agent: sf.agentId, file: sf.file },
        });
      } catch {
        /* skip */
      }
    }
    out.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    return out;
  }

  async readSession(id: string): Promise<HarborIR> {
    if (!this.fileIndex.has(id)) await this.listSessions();
    const sf = this.fileIndex.get(id);
    if (!sf) throw new Error(`OpenClaw 会话不存在: ${id}`);
    const parsed = this.parsed.get(id) ?? parseSessionFile(sf.file);
    const header = createHeader(
      {
        id,
        sourceClient: "openclaw",
        sourceSessionId: sf.sessionId,
        title: (parsed.title || sf.sessionId).slice(0, 200),
        createdAt: parsed.createdAtMs ? new Date(parsed.createdAtMs).toISOString() : undefined,
        updatedAt: parsed.updatedAtMs ? new Date(parsed.updatedAtMs).toISOString() : undefined,
        cwd: parsed.cwd,
        model: parsed.model,
      },
      { agent: sf.agentId, note: "openclaw-local-readonly" },
    );
    return { header, items: parsed.items };
  }

  async writeSession(): Promise<WriteResult> {
    return {
      status: "failed",
      sessionId: "",
      error: "OpenClaw 本地库仅支持只读；可作为迁移源",
    };
  }
}

export function createOpenClawAdapter(paths?: OpenClawPaths): OpenClawAdapter {
  return new OpenClawAdapter(paths);
}
