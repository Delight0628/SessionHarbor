/**
 * DeepSeek Harness (dsh) 适配器
 * 存储: <root>/--<cwd>--/<encoded-id>/session.jsonl[.zstd]
 * 默认 zstd 压缩；compression:none 时为纯 JSONL SessionEvent 流。
 * 本机实测 (2026-09-14)：APPDATA/deepseek-harness/sessions 几乎为空（云端/未用本地持久化）。
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

export interface DshPaths extends ClientPathsLike {
  sessionsRoot?: string;
}

function discoverDsh(explicitRoot?: string): DshPaths {
  const candidates: string[] = [];
  if (explicitRoot) candidates.push(path.resolve(explicitRoot));
  const homes = [os.homedir()];
  if (process.env.USERPROFILE) homes.push(process.env.USERPROFILE);
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "deepseek-harness"));
    candidates.push(path.join(process.env.APPDATA, "alink", "deepseek-harness"));
  }
  for (const h of homes) {
    candidates.push(path.join(h, ".deepseek-harness"));
    candidates.push(path.join(h, "deepseek-harness", "sessions"));
  }
  candidates.push(path.join(process.env.APPDATA || "", "deepseek-harness", "sessions"));

  let root: string | undefined;
  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    const st = fs.statSync(c);
    if (st.isDirectory()) {
      root = c;
      break;
    }
  }
  if (!root) {
    // 允许发现“已安装但无会话”的目录
    const fallback =
      (process.env.APPDATA && path.join(process.env.APPDATA, "deepseek-harness")) ||
      path.join(os.homedir(), ".deepseek-harness");
    if (fs.existsSync(fallback)) {
      const sessionsRoot = path.join(fallback, "sessions");
      return {
        id: "deepseek-harness",
        dataRoot: fallback,
        sessionsRoot: fs.existsSync(sessionsRoot) ? sessionsRoot : fallback,
        extraDbs: [],
      };
    }
    throw new Error("未找到 DeepSeek Harness 数据目录，可用 --dsh-root 指定");
  }
  const sessionsRoot = path.join(root, "sessions");
  return {
    id: "deepseek-harness",
    dataRoot: root,
    sessionsRoot: fs.existsSync(sessionsRoot) ? sessionsRoot : root,
    extraDbs: [],
  };
}

/** 收集所有 session.jsonl（未压缩） */
function collectSessionFiles(sessionsRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth = 0) => {
    if (depth > 6 || !fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && (e.name === "session.jsonl" || e.name.endsWith(".jsonl"))) {
        // 跳过明显 zstd 二进制
        if (e.name.endsWith(".zstd")) continue;
        out.push(full);
      }
    }
  };
  walk(sessionsRoot);
  return out;
}

function sessionIdFromFile(file: string): string {
  // .../<encoded-id>/session.jsonl
  const dir = path.dirname(file);
  const base = path.basename(dir);
  if (base === "sessions" || base.startsWith("--")) {
    return path.basename(file, path.extname(file));
  }
  return base;
}

function parseEventLine(line: string): Json | null {
  try {
    return JSON.parse(line) as Json;
  } catch {
    return null;
  }
}

function eventsToItems(events: Json[]): HarborItem[] {
  const items: HarborItem[] = [];
  for (const ev of events) {
    const type = String(ev.type || ev.kind || "");
    const ts = ev.timestamp || ev.time || ev.createdAt;
    const timestamp =
      typeof ts === "number"
        ? new Date(ts > 1e12 ? ts : ts * 1000).toISOString()
        : typeof ts === "string"
          ? ts
          : undefined;
    // 常见角色
    const role = String(ev.role || ev.author || "");
    const text =
      extractTextFromContent(ev.content) ||
      extractTextFromContent(ev.message) ||
      (typeof ev.text === "string" ? ev.text : "");
    if ((type.includes("user") || role === "user") && text) {
      items.push({
        type: "message",
        itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        role: "user",
        content: [{ type: "text", text }],
        timestamp,
      });
    } else if ((type.includes("assistant") || type.includes("message") || role === "assistant") && text) {
      items.push({
        type: "message",
        itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp,
      });
    }
  }
  return items;
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
    const root = p.sessionsRoot || p.dataRoot;
    const files = collectSessionFiles(root);
    return files.map((f) => {
      const id = sessionIdFromFile(f);
      const st = fs.statSync(f);
      let title = id;
      let msgCount = 0;
      try {
        const lines = fs.readFileSync(f, "utf-8").split(/\r?\n/).filter(Boolean);
        msgCount = lines.length;
        for (const line of lines.slice(0, 20)) {
          const ev = parseEventLine(line);
          if (!ev) continue;
          const t = extractTextFromContent(ev.content) || extractTextFromContent(ev.message) || "";
          if (t && (String(ev.role || ev.type || "").includes("user") || String(ev.type || "").includes("prompt"))) {
            title = t.slice(0, 80).replace(/\s+/g, " ");
            break;
          }
        }
      } catch {
        /* binary / compressed */
      }
      const project = path.basename(path.dirname(path.dirname(f)));
      return {
        id,
        title,
        group: project.startsWith("--") ? project.slice(2, -2) || "deepseek" : project,
        createdAtMs: Math.round(st.birthtimeMs || st.mtimeMs),
        updatedAtMs: Math.round(st.mtimeMs),
        messageCount: msgCount,
        meta: { file: f, compressedHint: title === id && msgCount === 0 },
      };
    });
  }

  async readSession(id: string): Promise<HarborIR> {
    const p = this.ensure();
    const files = collectSessionFiles(p.sessionsRoot || p.dataRoot);
    const file = files.find((f) => sessionIdFromFile(f) === id);
    if (!file) throw new Error(`DeepSeek 会话不存在: ${id}`);
    const st = fs.statSync(file);
    let events: Json[] = [];
    try {
      const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
      events = lines.map(parseEventLine).filter(Boolean) as Json[];
    } catch {
      events = [];
    }
    const items = eventsToItems(events);
    const header = createHeader(
      {
        id,
        sourceClient: "deepseek-harness",
        sourceSessionId: id,
        title: items.find((i) => i.type === "message") &&
          (items.find((i) => i.type === "message") as { content: Array<{ text?: string }> }).content[0]?.text?.slice(0, 80) ||
          id,
        createdAt: new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
        updatedAt: new Date(st.mtimeMs).toISOString(),
        cwd: path.basename(path.dirname(path.dirname(file))),
      },
      { file, storage: "jsonl" },
    );
    return { header, items };
  }

  async writeSession(): Promise<WriteResult> {
    return {
      status: "failed",
      sessionId: "",
      error: "DeepSeek Harness 默认 zstd 持久化且本机未暴露稳定写入口，仅支持只读解析",
    };
  }
}

export function createDeepseekHarnessAdapter(paths?: DshPaths): DeepseekHarnessAdapter {
  return new DeepseekHarnessAdapter(paths);
}
export { discoverDsh };
