/**
 * Hermes 适配器（只读）
 * 数据源（按优先级）:
 * 1. %USERPROFILE%/.hermes-web-ui/hermes-web-ui.db
 *      sessions / messages（完整聊天，含 tool、reasoning）
 * 2. %USERPROFILE%/.hermes/sessions/session_*.json
 *      Agent/Cron 会话 dump（messages 数组）
 * 3. %USERPROFILE%/.hermes/sessions/sessions.json  会话索引
 * 安装: D:\hermes-desktop\hermes-agent.exe 等（仅 installed 判定）
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

export interface HermesPaths extends ClientPathsLike {
  webUiDb?: string;
  sessionsDir?: string;
  sessionsIndex?: string;
  installHint?: string;
}

function firstExisting(cands: string[]): string | undefined {
  for (const p of cands) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

export function discoverHermes(explicitRoot?: string): HermesPaths {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const roots: string[] = [];
  if (explicitRoot) roots.push(path.resolve(explicitRoot));
  roots.push(path.join(home, ".hermes"));
  roots.push(path.join(home, ".hermes-web-ui"));

  const webUiDb =
    firstExisting([
      path.join(home, ".hermes-web-ui", "hermes-web-ui.db"),
      path.join(process.env.APPDATA || "", "hermes-web-ui", "hermes-web-ui.db"),
    ]) ??
    roots
      .map((r) => path.join(r, "hermes-web-ui.db"))
      .find((p) => fs.existsSync(p));

  const sessionsDir =
    firstExisting([
      path.join(home, ".hermes", "sessions"),
      path.join(home, ".hermes", "desktop", "sessions"),
    ]) ??
    roots.map((r) => path.join(r, "sessions")).find((p) => fs.existsSync(p));

  const sessionsIndex = sessionsDir ? path.join(sessionsDir, "sessions.json") : undefined;

  if (!webUiDb && !sessionsDir) {
    throw new Error("未找到 Hermes 数据目录（~/.hermes 或 ~/.hermes-web-ui）");
  }

  const installHint = firstExisting([
    "D:\\hermes-desktop\\hermes-agent.exe",
    "C:\\Program Files\\hermes-desktop\\hermes-agent.exe",
    path.join(home, "AppData", "Local", "Programs", "hermes-desktop", "hermes-agent.exe"),
  ]);

  return {
    id: "hermes",
    dataRoot: webUiDb
      ? path.dirname(webUiDb)
      : sessionsDir
        ? path.dirname(sessionsDir)
        : path.join(home, ".hermes"),
    primaryDb: webUiDb,
    webUiDb,
    sessionsDir,
    sessionsIndex: sessionsIndex && fs.existsSync(sessionsIndex) ? sessionsIndex : undefined,
    installHint,
    extraDbs: [webUiDb, sessionsDir].filter(Boolean) as string[],
  };
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

function contentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return extractTextFromContent(content);
  if (typeof content === "object") {
    const o = content as Json;
    return extractTextFromContent(o.content ?? o.text ?? o.message);
  }
  return String(content);
}

function tsToIso(v: unknown): string | undefined {
  if (v == null) return undefined;
  const n = typeof v === "string" ? Number(v) : Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    if (typeof v === "string" && v) {
      const t = Date.parse(v);
      return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
    }
    return undefined;
  }
  // 秒或毫秒
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

interface CachedMeta {
  title: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  messageCount?: number;
  model?: string;
  group?: string;
  source: "web-ui" | "agent-dump";
  file?: string;
}

export class HermesAdapter implements Adapter {
  id = "hermes";
  displayName = "Hermes";
  capabilities = { read: true, write: false, incremental: false, live: false };
  private paths?: HermesPaths;
  private cache = new Map<string, CachedMeta>();

  constructor(paths?: HermesPaths) {
    this.paths = paths;
  }

  discover(): HermesPaths {
    if (!this.paths) this.paths = discoverHermes();
    return this.paths;
  }

  private ensure(): HermesPaths {
    return (this.paths ?? this.discover()) as HermesPaths;
  }

  private listWebUi(): SessionSummary[] {
    const p = this.ensure();
    if (!p.webUiDb || !fs.existsSync(p.webUiDb)) return [];
    const out: SessionSummary[] = [];
    let db: ReturnType<typeof openRo>;
    try {
      db = openRo(p.webUiDb);
    } catch {
      return out;
    }
    try {
      const rows = db
        .prepare(
          `SELECT id, title, source, model, started_at, ended_at, message_count, profile
           FROM sessions ORDER BY COALESCE(ended_at, started_at) DESC`,
        )
        .all() as Array<Json>;
      for (const r of rows) {
        const id = String(r.id);
        const title = String(r.title || id);
        const started = tsToIso(r.started_at);
        const ended = tsToIso(r.ended_at);
        const meta: CachedMeta = {
          title,
          createdAtMs: started ? Date.parse(started) : undefined,
          updatedAtMs: ended ? Date.parse(ended) : started ? Date.parse(started) : undefined,
          messageCount: r.message_count != null ? Number(r.message_count) : undefined,
          model: r.model ? String(r.model) : undefined,
          group: r.source ? String(r.source) : "hermes",
          source: "web-ui",
        };
        this.cache.set(id, meta);
        out.push({
          id,
          title,
          createdAtMs: meta.createdAtMs,
          updatedAtMs: meta.updatedAtMs,
          group: meta.group,
          model: meta.model,
          messageCount: meta.messageCount,
          meta: { kind: "hermes_web_ui", profile: r.profile, source: r.source },
        });
      }
    } catch {
      /* ignore */
    } finally {
      db.close();
    }
    return out;
  }

  private listAgentDumps(): SessionSummary[] {
    const p = this.ensure();
    if (!p.sessionsDir || !fs.existsSync(p.sessionsDir)) return [];
    const out: SessionSummary[] = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(p.sessionsDir).filter((f) => /^session_.*\.json$/i.test(f));
    } catch {
      return out;
    }
    for (const f of files) {
      const fp = path.join(p.sessionsDir, f);
      try {
        const st = fs.statSync(fp);
        if (!st.isFile() || st.size > 20 * 1024 * 1024) continue;
        const data = JSON.parse(fs.readFileSync(fp, "utf-8")) as Json;
        const sid = String(data.session_id || path.basename(f, ".json"));
        const msgs = (data.messages ?? []) as unknown[];
        const firstUser = msgs.find(
          (m) => m && typeof m === "object" && (m as Json).role === "user",
        );
        const title =
          (firstUser ? contentToText((firstUser as Json).content) : "").trim().slice(0, 100) ||
          sid;
        const start = data.session_start ? Date.parse(String(data.session_start)) : st.mtimeMs;
        const end = data.last_updated ? Date.parse(String(data.last_updated)) : st.mtimeMs;
        const meta: CachedMeta = {
          title,
          createdAtMs: Number.isFinite(start) ? start : undefined,
          updatedAtMs: Number.isFinite(end) ? end : undefined,
          messageCount: msgs.length,
          model: data.model ? String(data.model) : undefined,
          group: data.platform ? String(data.platform) : "agent",
          source: "agent-dump",
          file: fp,
        };
        // web-ui 已有同 id 则跳过，避免重复
        if (this.cache.has(sid)) continue;
        this.cache.set(sid, meta);
        out.push({
          id: sid,
          title,
          createdAtMs: meta.createdAtMs,
          updatedAtMs: meta.updatedAtMs,
          group: meta.group,
          model: meta.model,
          messageCount: meta.messageCount,
          meta: { kind: "hermes_agent_dump", platform: data.platform, file: f },
        });
      } catch {
        /* skip bad file */
      }
    }
    return out;
  }

  async listSessions(): Promise<SessionSummary[]> {
    this.cache.clear();
    const fromDb = this.listWebUi();
    const fromFiles = this.listAgentDumps();
    const all = [...fromDb, ...fromFiles];
    all.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    return all;
  }

  private readWebUi(id: string): HarborIR | null {
    const p = this.ensure();
    if (!p.webUiDb || !fs.existsSync(p.webUiDb)) return null;
    const db = openRo(p.webUiDb);
    const items: HarborItem[] = [];
    let title = id;
    let model: string | undefined;
    let createdAt: string | undefined;
    let updatedAt: string | undefined;
    let source = "cli";
    try {
      const srow = db
        .prepare(
          `SELECT id, title, source, model, started_at, ended_at FROM sessions WHERE id = ?`,
        )
        .get(id) as Json | undefined;
      if (srow) {
        title = String(srow.title || id);
        model = srow.model ? String(srow.model) : undefined;
        source = srow.source ? String(srow.source) : "cli";
        createdAt = tsToIso(srow.started_at);
        updatedAt = tsToIso(srow.ended_at);
      }
      const rows = db
        .prepare(
          `SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp,
                  reasoning, reasoning_content, display_role
           FROM messages WHERE session_id = ? ORDER BY timestamp ASC, id ASC`,
        )
        .all(id) as Array<Json>;
      for (const r of rows) {
        const ts = tsToIso(r.timestamp);
        const roleRaw = String(r.display_role || r.role || "user").toLowerCase();
        const reasoning =
          (typeof r.reasoning_content === "string" && r.reasoning_content) ||
          (typeof r.reasoning === "string" && r.reasoning) ||
          "";
        if (reasoning.trim()) {
          items.push({
            type: "thinking",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            text: reasoning.trim().slice(0, 20000),
            timestamp: ts,
          });
        }
        const content = r.content;
        const text = contentToText(content);
        if (roleRaw === "tool") {
          items.push({
            type: "tool_output",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            callId: String(r.tool_call_id || r.id),
            output: (text || JSON.stringify(content)).slice(0, 20000),
            timestamp: ts,
          });
          if (r.tool_name) {
            items.push({
              type: "tool_call",
              itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
              callId: String(r.tool_call_id || r.id),
              toolName: String(r.tool_name),
              input: null,
              timestamp: ts,
            });
          }
          continue;
        }
        // tool_calls 字段（assistant 发起调用）
        if (r.tool_calls) {
          const calls = decodeValue(r.tool_calls);
          if (Array.isArray(calls)) {
            for (const c of calls) {
              if (!c || typeof c !== "object") continue;
              const o = c as Json;
              const fn = (o.function ?? {}) as Json;
              items.push({
                type: "tool_call",
                itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
                callId: String(o.id ?? randomUUID()),
                toolName: String(fn.name ?? o.name ?? "tool"),
                input: fn.arguments ?? o.input ?? null,
                timestamp: ts,
              });
            }
          }
        }
        if (!text.trim()) continue;
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
    } finally {
      db.close();
    }
    if (!items.length) return null;
    const header = createHeader(
      {
        id,
        sourceClient: "hermes",
        sourceSessionId: id,
        title: title.slice(0, 200),
        createdAt,
        updatedAt,
        model,
      },
      { store: "hermes-web-ui", source },
    );
    return { header, items };
  }

  private readAgentDump(id: string): HarborIR | null {
    const p = this.ensure();
    const meta = this.cache.get(id);
    const fp =
      meta?.file ??
      (p.sessionsDir ? path.join(p.sessionsDir, `session_${id}.json`) : undefined);
    if (!fp || !fs.existsSync(fp)) {
      // 尝试按 session_id 扫
      if (p.sessionsDir && fs.existsSync(p.sessionsDir)) {
        for (const f of fs.readdirSync(p.sessionsDir)) {
          if (!f.startsWith("session_") || !f.endsWith(".json")) continue;
          const cand = path.join(p.sessionsDir, f);
          try {
            const d = JSON.parse(fs.readFileSync(cand, "utf-8")) as Json;
            if (String(d.session_id) === id) return this.readAgentDumpFile(cand, d);
          } catch {
            /* skip */
          }
        }
      }
      return null;
    }
    const data = JSON.parse(fs.readFileSync(fp, "utf-8")) as Json;
    return this.readAgentDumpFile(fp, data);
  }

  private readAgentDumpFile(_fp: string, data: Json): HarborIR {
    const id = String(data.session_id || "unknown");
    const msgs = (data.messages ?? []) as Array<Json>;
    const items: HarborItem[] = [];
    let title = id;
    for (const m of msgs) {
      const roleRaw = String(m.role || "user").toLowerCase();
      const ts = undefined;
      if (roleRaw === "tool" || roleRaw === "toolresult" || roleRaw === "tool_result") {
        items.push({
          type: "tool_output",
          itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          callId: String(m.tool_call_id ?? m.id ?? randomUUID()),
          output: contentToText(m.content).slice(0, 20000),
          timestamp: ts,
        });
        continue;
      }
      if (m.tool_calls) {
        const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        for (const c of calls) {
          if (!c || typeof c !== "object") continue;
          const o = c as Json;
          const fn = (o.function ?? {}) as Json;
          items.push({
            type: "tool_call",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            callId: String(o.id ?? randomUUID()),
            toolName: String(fn.name ?? "tool"),
            input: fn.arguments ?? o.input,
            timestamp: ts,
          });
        }
      }
      const text = contentToText(m.content);
      if (!text.trim()) continue;
      const role = roleRaw === "assistant" ? "assistant" : roleRaw === "system" ? "system" : "user";
      if (role === "user" && title === id) title = text.trim().slice(0, 80);
      items.push({
        type: "message",
        itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        role,
        content: [{ type: "text", text: text.trim() }],
        timestamp: ts,
      });
    }
    const header = createHeader(
      {
        id,
        sourceClient: "hermes",
        sourceSessionId: id,
        title: title.slice(0, 200),
        createdAt: data.session_start ? String(data.session_start) : undefined,
        updatedAt: data.last_updated ? String(data.last_updated) : undefined,
        model: data.model ? String(data.model) : undefined,
      },
      { store: "agent-dump", platform: data.platform },
    );
    return { header, items };
  }

  async readSession(id: string): Promise<HarborIR> {
    const fromDb = this.readWebUi(id);
    if (fromDb && fromDb.items.length) return fromDb;
    const fromFile = this.readAgentDump(id);
    if (fromFile) return fromFile;
    if (fromDb) return fromDb;
    throw new Error(`Hermes 会话不存在: ${id}`);
  }

  async writeSession(): Promise<WriteResult> {
    return {
      status: "failed",
      sessionId: "",
      error: "Hermes 本地库仅支持只读；可作为迁移源",
    };
  }
}

export function createHermesAdapter(paths?: HermesPaths): HermesAdapter {
  return new HermesAdapter(paths);
}
