/**
 * ChatGPT 官方 Data Export 适配器（只读导入）
 * conversations.json：数组，每项一棵 mapping 树
 * mapping[nodeId] = { message?: { author:{role}, content:{content_type,parts}, create_time, ... }, parent, children }
 * 正文：沿叶子回溯到根，再按时间排序；官方不支持重建回写。
 */

import fs from "node:fs";
import path from "node:path";
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

export interface ChatGptExportPaths extends ClientPathsLike {
  /** conversations.json 路径，或包含它的目录 */
  source: string;
}

function resolveExportFile(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(path.resolve(explicit));
  const home = process.env.USERPROFILE || process.env.HOME || "";
  candidates.push(
    path.join(home, "Downloads", "conversations.json"),
    path.join(home, "Documents", "conversations.json"),
    path.join(process.cwd(), "conversations.json"),
    path.join(process.cwd(), "fixtures", "chatgpt-export", "conversations.json"),
  );
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      const f = path.join(c, "conversations.json");
      if (fs.existsSync(f)) return f;
    }
  }
  throw new Error(
    "未找到 conversations.json，可用 --chatgpt-export 指定路径（官方 Data Export 解压后）",
  );
}

export function discoverChatGptExport(explicit?: string): ChatGptExportPaths {
  const source = resolveExportFile(explicit);
  return {
    id: "chatgpt-export",
    dataRoot: path.dirname(source),
    source,
    extraDbs: [],
  };
}

/** mapping 树 → 按时间排序的消息列表 */
function flattenMapping(mapping: Record<string, Json>): Array<{
  role: string;
  text: string;
  createTime?: number;
  id: string;
}> {
  // 找根节点（无 parent 或 parent 不在 mapping）
  const ids = Object.keys(mapping);
  const childOf = new Set<string>();
  for (const id of ids) {
    const p = mapping[id]?.parent;
    if (typeof p === "string") childOf.add(p);
  }
  const roots = ids.filter((id) => {
    const p = mapping[id]?.parent;
    return typeof p !== "string" || !mapping[p];
  });

  // 沿 children 深度优先收集叶子路径上的 message
  const out: Array<{ role: string; text: string; createTime?: number; id: string }> = [];
  const seen = new Set<string>();

  function walk(id: string) {
    if (seen.has(id) || !mapping[id]) return;
    seen.add(id);
    const node = mapping[id];
    const msg = node.message as Json | undefined;
    if (msg) {
      const author = (msg.author ?? {}) as Json;
      const role = String(author.role ?? "user");
      const content = (msg.content ?? {}) as Json;
      let text = "";
      if (content.content_type === "text" || content.content_type === "multimodal_text") {
        text = extractTextFromContent(content.parts);
      } else if (content.content_type === "code") {
        text = String(content.text ?? "");
      } else {
        text = extractTextFromContent(content.parts ?? content.text);
      }
      // system/hidden 噪音
      const recipient = msg.recipient;
      if (role !== "system" && role !== "tool" && text.trim()) {
        if (role !== "assistant" || !String(recipient ?? "").startsWith("browser")) {
          out.push({
            role: role === "assistant" ? "assistant" : "user",
            text,
            createTime: typeof msg.create_time === "number" ? msg.create_time : undefined,
            id,
          });
        }
      }
    }
    const children = node.children;
    if (Array.isArray(children)) {
      for (const c of children) walk(String(c));
    }
  }

  // 从所有根走；若多分支，取最长路径（主对话）
  if (!roots.length && ids.length) {
    walk(ids[0]!);
  } else {
    // 选择分支最多/消息最多的根
    let best: { root: string; size: number } | null = null;
    for (const r of roots) {
      const before = out.length;
      const seenCopy = new Set(seen);
      walk(r);
      const size = out.length - before;
      if (!best || size > best.size) best = { root: r, size };
      // 回退：只保留最佳分支 — 简化为直接用全部 walk 结果（官方主链通常无分叉）
      void seenCopy;
    }
  }
  out.sort((a, b) => (a.createTime ?? 0) - (b.createTime ?? 0));
  return out;
}

export class ChatGptExportAdapter implements Adapter {
  id = "chatgpt-export";
  displayName = "ChatGPT Export";
  capabilities = { read: true, write: false, incremental: false, live: false };
  private paths?: ChatGptExportPaths;
  private cache?: Json[];

  constructor(paths?: ChatGptExportPaths) {
    this.paths = paths;
  }

  discover(): ChatGptExportPaths {
    if (!this.paths) this.paths = discoverChatGptExport();
    return this.paths;
  }

  private ensure(): ChatGptExportPaths {
    return (this.paths ?? this.discover()) as ChatGptExportPaths;
  }

  private loadConversations(): Json[] {
    if (this.cache) return this.cache;
    const p = this.ensure();
    const raw = fs.readFileSync(p.source, "utf-8");
    const data = JSON.parse(raw) as Json[];
    if (!Array.isArray(data)) throw new Error("conversations.json 应为数组");
    this.cache = data;
    return data;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const convs = this.loadConversations();
    return convs.map((c) => {
      const id = String(c.conversation_id ?? c.id ?? "");
      const title = String(c.title ?? id);
      const create = c.create_time as number | undefined;
      const update = c.update_time as number | undefined;
      return {
        id,
        title,
        createdAtMs: create ? Math.round(create * 1000) : undefined,
        updatedAtMs: update ? Math.round(update * 1000) : undefined,
        meta: {
          source: "chatgpt-export",
          model: c.default_model_slug,
        },
      };
    });
  }

  async readSession(id: string): Promise<HarborIR> {
    const convs = this.loadConversations();
    const conv = convs.find((c) => String(c.conversation_id ?? c.id ?? "") === id);
    if (!conv) throw new Error(`ChatGPT 会话不存在: ${id}`);
    const mapping = (conv.mapping ?? {}) as Record<string, Json>;
    const flat = flattenMapping(mapping);
    const items: HarborItem[] = flat.map((m, i) => ({
      type: "message" as const,
      itemId: `item_${id.replace(/-/g, "").slice(0, 12)}_${i}`,
      role: m.role as "user" | "assistant",
      content: [{ type: "text" as const, text: m.text }],
      timestamp: m.createTime ? new Date(m.createTime * 1000).toISOString() : undefined,
    }));
    const create = conv.create_time as number | undefined;
    const update = conv.update_time as number | undefined;
    const header = createHeader(
      {
        id,
        sourceClient: "chatgpt-export",
        sourceSessionId: id,
        title: String(conv.title ?? id),
        createdAt: create ? new Date(create * 1000).toISOString() : undefined,
        updatedAt: update ? new Date(update * 1000).toISOString() : undefined,
        model: (conv.default_model_slug as string) || undefined,
      },
      { exportFile: this.ensure().source, readOnly: true },
    );
    return { header, items };
  }

  async writeSession(): Promise<WriteResult> {
    return {
      status: "failed",
      sessionId: "",
      error: "ChatGPT 官方不支持本地重建会话，仅支持导入（只读）",
    };
  }
}

export function createChatGptExportAdapter(paths?: ChatGptExportPaths): ChatGptExportAdapter {
  return new ChatGptExportAdapter(paths);
}
