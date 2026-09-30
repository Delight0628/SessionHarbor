/**
 * DeepSeek Harness (dsh) 适配器
 * 存储: ~/.dsh/sessions/--<cwd>--/<sessionId>/session.jsonl.zstd
 * 格式: zstd(JSONL SessionEvent)
 *   session / user/message / assistant/message / assistant/chunk / turn/start …
 * 未加密，zstd 压缩。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
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

const require = createRequire(import.meta.url);
type Json = Record<string, unknown>;

export interface DshPaths extends ClientPathsLike {
  id: string;
  dataRoot: string;
  extraDbs: string[];
  sessionsRoot: string;
}

function loadFzstd(): { decompress: (b: Uint8Array) => Uint8Array } {
  // 优先 dsh 自带 fzstd，其次 node_modules
  const candidates = [
    "C:/Users/tc032353/.dsh/profiles/desktop/.dsh-module-fallback/node_modules/fzstd/lib/index.js",
    "fzstd",
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  throw new Error("需要 fzstd 解压 dsh 会话（npm i fzstd）");
}

export function discoverDsh(explicitRoot?: string): DshPaths {
  const home = os.homedir();
  const cands = [
    explicitRoot,
    path.join(home, ".dsh"),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".dsh") : "",
  ].filter(Boolean) as string[];
  for (const c of cands) {
    const root = path.resolve(c);
    const sessions = path.join(root, "sessions");
    if (fs.existsSync(sessions)) {
      return {
        id: "deepseek-harness",
        dataRoot: root,
        sessionsRoot: sessions,
        extraDbs: [],
      };
    }
  }
  throw new Error("未找到 DeepSeek Harness (~/.dsh/sessions)，可用 --dsh-root 指定");
}

function projectFromDirName(name: string): string {
  // --D-apaduit-- → D:\apaduit 近似；--D-deepseek-harness-- → deepseek-harness
  const m = name.replace(/^-+/, "").replace(/-+$/, "");
  return m.replace(/~/g, " ").replace(/-(?=[^-]*$)/, ":\\").replace(/-/g, "\\") || name;
}

interface DshEvent {
  type?: string;
  seq?: number;
  time?: number;
  data?: Json;
}

function parseSessionEvents(text: string): {
  meta: { id?: string; cwd?: string; createdAt?: number; parentSession?: string };
  items: HarborItem[];
  title?: string;
} {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const meta: { id?: string; cwd?: string; createdAt?: number; parentSession?: string } = {};
  const items: HarborItem[] = [];
  let title: string | undefined;
  let lastUser: string | undefined;
  let lastAssistant: string | undefined;

  for (const line of lines) {
    let ev: DshEvent;
    try {
      ev = JSON.parse(line) as DshEvent;
    } catch {
      continue;
    }
    const t = ev.type || "";
    const ts = ev.time ? new Date(ev.time).toISOString() : undefined;

    if (t === "session") {
      const d = ev.data ?? (ev as Json);
      meta.id = typeof d.id === "string" ? d.id : undefined;
      meta.cwd = typeof d.cwd === "string" ? d.cwd : undefined;
      meta.createdAt = typeof d.createdAt === "number" ? d.createdAt : undefined;
      meta.parentSession = typeof d.parentSession === "string" ? d.parentSession : undefined;
      continue;
    }
    if (t === "session/title") {
      const d = ev.data ?? {};
      if (typeof d.title === "string") title = d.title;
      continue;
    }
    if (t === "user/message") {
      const d = ev.data ?? {};
      const src = (d.source ?? {}) as Json;
      // 跳过 plugin/system 注入，只保留真实用户
      if (src.kind && src.kind !== "user") continue;
      const text2 = extractTextFromContent(d.content);
      if (!text2.trim()) continue;
      // 过滤 system-reminder 噪音可选；先保留
      items.push({
        type: "message",
        itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        role: "user",
        content: [{ type: "text", text: text2 }],
        parentItemId: lastAssistant,
        timestamp: ts,
      });
      lastUser = items[items.length - 1]!.itemId;
      continue;
    }
    if (t === "assistant/message") {
      const d = ev.data ?? {};
      const msg = (d.message ?? {}) as Json;
      const content = msg.content;
      let text = "";
      let thinking = "";
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || typeof c !== "object") continue;
          const ct = (c as Json).type;
          if (ct === "text") text += String((c as Json).text || "");
          else if (ct === "reasoning") thinking += String((c as Json).text || "");
        }
      } else {
        text = extractTextFromContent(content);
      }
      if (thinking) {
        items.push({
          type: "thinking",
          itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          text: thinking,
          parentItemId: lastUser,
          timestamp: ts,
        });
      }
      if (text.trim()) {
        items.push({
          type: "message",
          itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          role: "assistant",
          content: [{ type: "text", text }],
          parentItemId: lastUser,
          timestamp: ts,
        });
        lastAssistant = items[items.length - 1]!.itemId;
      }
      continue;
    }
  }
  return { meta, items, title };
}

export class DeepseekHarnessAdapter implements Adapter {
  id = "deepseek-harness";
  displayName = "DeepSeek Harness";
  capabilities = { read: true, write: false, incremental: false, live: false };
  private paths?: DshPaths;

  constructor(paths?: DshPaths) {
    this.paths = paths;
  }

  discover(): DshPaths {
    if (!this.paths) this.paths = discoverDsh();
    return this.paths;
  }

  private ensure(): DshPaths {
    return (this.paths ?? this.discover()) as DshPaths;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const p = this.ensure();
    const out: SessionSummary[] = [];
    const fz = loadFzstd();
    if (!fs.existsSync(p.sessionsRoot)) return out;
    for (const proj of fs.readdirSync(p.sessionsRoot)) {
      const projDir = path.join(p.sessionsRoot, proj);
      if (!fs.statSync(projDir).isDirectory()) continue;
      const group = projectFromDirName(proj);
      for (const sid of fs.readdirSync(projDir)) {
        const sidDir = path.join(projDir, sid);
        if (!fs.statSync(sidDir).isDirectory()) continue;
        // find session.jsonl or session.jsonl.zstd
        let file = path.join(sidDir, "session.jsonl");
        if (!fs.existsSync(file)) file = path.join(sidDir, "session.jsonl.zstd");
        if (!fs.existsSync(file)) {
          // v3
          file = path.join(sidDir, "session.v3.jsonl.zstd");
          if (!fs.existsSync(file)) continue;
        }
        try {
          const raw = fs.readFileSync(file);
          const buf = file.endsWith(".zstd") ? fz.decompress(raw) : raw;
          const text = Buffer.from(buf).toString("utf-8");
          const { meta, items, title } = parseSessionEvents(text);
          const realId = meta.id || sid.replace(/^session-/, "");
          out.push({
            id: realId,
            title: title || items.find((i) => i.type === "message" && i.role === "user" && "content" in i)
              ? (title || extractTextFromContent(
                  (items.find((i) => i.type === "message" && i.role === "user") as { content?: unknown })
                    ?.content,
                ).slice(0, 80))
              : sid,
            cwd: meta.cwd || undefined,
            group,
            createdAtMs: meta.createdAt,
            updatedAtMs: fs.statSync(file).mtimeMs,
            messageCount: items.filter((i) => i.type === "message").length,
            meta: { file, project: proj },
          });
        } catch {
          /* skip */
        }
      }
    }
    out.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    return out;
  }

  async readSession(id: string): Promise<HarborIR> {
    const p = this.ensure();
    const fz = loadFzstd();
    // find by dir name or meta id
    for (const proj of fs.readdirSync(p.sessionsRoot)) {
      const projDir = path.join(p.sessionsRoot, proj);
      if (!fs.statSync(projDir).isDirectory()) continue;
      for (const sid of fs.readdirSync(projDir)) {
        const sidDir = path.join(projDir, sid);
        if (!fs.statSync(sidDir).isDirectory()) continue;
        if (sid !== `session-${id}` && sid !== id && !sid.includes(id)) continue;
        let file = path.join(sidDir, "session.jsonl");
        if (!fs.existsSync(file)) file = path.join(sidDir, "session.jsonl.zstd");
        if (!fs.existsSync(file)) file = path.join(sidDir, "session.v3.jsonl.zstd");
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file);
        const buf = file.endsWith(".zstd") ? fz.decompress(raw) : raw;
        const text = Buffer.from(buf).toString("utf-8");
        const { meta, items, title } = parseSessionEvents(text);
        const realId = meta.id || id;
        const header = createHeader(
          {
            id: realId,
            sourceClient: "deepseek-harness",
            sourceSessionId: realId,
            title: title || realId,
            cwd: meta.cwd,
            createdAt: meta.createdAt ? new Date(meta.createdAt).toISOString() : undefined,
          },
          { file, parentSession: meta.parentSession, project: proj },
        );
        return { header, items };
      }
    }
    throw new Error(`DeepSeek 会话不存在: ${id}`);
  }

  async writeSession(): Promise<WriteResult> {
    return {
      status: "failed",
      sessionId: "",
      error: "DeepSeek Harness 仅支持只读解析（zstd SessionEvent 流）",
    };
  }
}

export function createDeepseekHarnessAdapter(paths?: DshPaths): DeepseekHarnessAdapter {
  return new DeepseekHarnessAdapter(paths);
}
