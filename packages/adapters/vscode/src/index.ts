/**
 * VS Code 适配器（只读，Copilot Chat）
 * 数据:
 *   %APPDATA%/Code/User/globalStorage/state.vscdb → chat.ChatSessionStore.index
 *   %APPDATA%/Code/User/globalStorage/emptyWindowChatSessions/<sessionId>.json
 * 安装目录: D:\Microsoft VS Code 等（仅用于 installed 判定）
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  createHeader,
  openRo,
  type Adapter,
  type ClientPathsLike,
  type HarborIR,
  type HarborItem,
  type SessionSummary,
  type WriteResult,
} from "@sessionharbor/core";

type Json = Record<string, unknown>;

export interface VsCodePaths extends ClientPathsLike {
  stateDb?: string;
  emptyChatDir?: string;
  workspaceStorage?: string;
  installHint?: string;
}

function firstExisting(cands: string[]): string | undefined {
  for (const p of cands) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

export function discoverVsCode(explicitRoot?: string): VsCodePaths {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

  const roots: string[] = [];
  if (explicitRoot) roots.push(path.resolve(explicitRoot));
  roots.push(path.join(appData, "Code"));
  roots.push(path.join(home, "AppData", "Roaming", "Code"));

  for (const r of roots) {
    const stateDb = path.join(r, "User", "globalStorage", "state.vscdb");
    const emptyChatDir = path.join(r, "User", "globalStorage", "emptyWindowChatSessions");
    const workspaceStorage = path.join(r, "User", "workspaceStorage");
    if (fs.existsSync(stateDb) || fs.existsSync(emptyChatDir)) {
      const installHint = firstExisting([
        "D:\\Microsoft VS Code\\Code.exe",
        "C:\\Program Files\\Microsoft VS Code\\Code.exe",
        path.join(home, "AppData", "Local", "Programs", "Microsoft VS Code", "Code.exe"),
      ]);
      return {
        id: "vscode",
        dataRoot: r,
        primaryDb: fs.existsSync(stateDb) ? stateDb : undefined,
        stateDb: fs.existsSync(stateDb) ? stateDb : undefined,
        emptyChatDir: fs.existsSync(emptyChatDir) ? emptyChatDir : undefined,
        workspaceStorage: fs.existsSync(workspaceStorage) ? workspaceStorage : undefined,
        installHint,
        extraDbs: [],
      };
    }
  }
  throw new Error("未找到 VS Code 数据目录（%APPDATA%/Code）");
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

function responseToText(resp: unknown): string {
  if (!Array.isArray(resp)) return typeof resp === "string" ? resp : "";
  const parts: string[] = [];
  for (const item of resp) {
    if (!item || typeof item !== "object") continue;
    const o = item as Json;
    if (typeof o.value === "string" && o.value.trim()) parts.push(o.value.trim());
    else if (o.kind === "toolInvocationSerialized" && o.invocationMessage) {
      parts.push(`[tool] ${String(o.invocationMessage)}`);
    }
  }
  return parts.join("\n");
}

export class VsCodeAdapter implements Adapter {
  id = "vscode";
  displayName = "VS Code";
  capabilities = { read: true, write: false, incremental: false, live: false };
  private paths?: VsCodePaths;
  private fileCache = new Map<string, string>();

  constructor(paths?: VsCodePaths) {
    this.paths = paths;
  }

  discover(): VsCodePaths {
    if (!this.paths) this.paths = discoverVsCode();
    return this.paths;
  }

  private ensure(): VsCodePaths {
    return (this.paths ?? this.discover()) as VsCodePaths;
  }

  private listEmptyChatFiles(): string[] {
    const p = this.ensure();
    if (!p.emptyChatDir) return [];
    return fs
      .readdirSync(p.emptyChatDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(p.emptyChatDir!, f));
  }

  async listSessions(): Promise<SessionSummary[]> {
    const p = this.ensure();
    this.fileCache.clear();
    const out: SessionSummary[] = [];
    const seen = new Set<string>();

    // 1) emptyWindowChatSessions 正文
    for (const fp of this.listEmptyChatFiles()) {
      try {
        const raw = fs.readFileSync(fp, "utf-8");
        const d = JSON.parse(raw) as Json;
        const sid = String(d.sessionId || path.basename(fp, ".json"));
        this.fileCache.set(sid, fp);
        const reqs = (d.requests ?? []) as Json[];
        let title =
          (typeof d.customTitle === "string" && d.customTitle.trim()) ||
          (typeof d.title === "string" && d.title.trim()) ||
          "";
        if (!title && typeof (reqs[0]?.message as Json | undefined)?.text === "string") {
          title = String((reqs[0]!.message as Json).text).slice(0, 80).replace(/\s+/g, " ");
        }
        if (!title) title = sid;
        out.push({
          id: sid,
          title,
          createdAtMs: typeof d.creationDate === "number" ? d.creationDate : undefined,
          updatedAtMs: typeof d.lastMessageDate === "number" ? d.lastMessageDate : undefined,
          group: "copilot-chat",
          messageCount: reqs.length,
          meta: { kind: "vscode_empty_chat", file: fp, isEmpty: !reqs.length },
        });
        seen.add(sid);
      } catch {
        /* skip bad file */
      }
    }

    // 2) ChatSessionStore.index（可能包含工作区会话标题）
    if (p.stateDb && fs.existsSync(p.stateDb)) {
      try {
        const db = openRo(p.stateDb);
        try {
          const row = db
            .prepare(`SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'`)
            .get() as { value?: unknown } | undefined;
          if (row?.value != null) {
            const idx = decodeValue(row.value) as Json;
            const entries = (idx?.entries ?? {}) as Record<string, Json>;
            for (const [sid, e] of Object.entries(entries)) {
              const idxTitle = typeof e.title === "string" ? e.title.trim() : "";
              if (seen.has(sid)) {
                const hit = out.find((x) => x.id === sid);
                if (hit && idxTitle && (hit.title === sid || !hit.title)) hit.title = idxTitle;
                continue;
              }
              const title = idxTitle || sid;
              out.push({
                id: sid,
                title,
                createdAtMs: typeof e.creationDate === "number" ? e.creationDate : undefined,
                updatedAtMs:
                  typeof e.lastMessageDate === "number" ? e.lastMessageDate : undefined,
                group: "copilot-chat",
                messageCount: e.isEmpty ? 0 : undefined,
                meta: { kind: "vscode_chat_index", isEmpty: Boolean(e.isEmpty) },
              });
            }
          }
        } finally {
          db.close();
        }
      } catch {
        /* ignore */
      }
    }

    out.sort((a, b) => {
      const ac = a.messageCount ? 1 : 0;
      const bc = b.messageCount ? 1 : 0;
      if (ac !== bc) return bc - ac;
      return (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
    });
    return out;
  }

  async readSession(id: string): Promise<HarborIR> {
    const p = this.ensure();
    const items: HarborItem[] = [];
    let title = id;
    let createdAt: number | undefined;
    let updatedAt: number | undefined;
    let model: string | undefined;

    const fp = this.fileCache.get(id) ?? path.join(p.emptyChatDir || "", `${id}.json`);
    if (p.emptyChatDir && fs.existsSync(fp)) {
      const d = JSON.parse(fs.readFileSync(fp, "utf-8")) as Json;
      title =
        (typeof d.customTitle === "string" && d.customTitle.trim()) ||
        (typeof d.title === "string" && d.title.trim()) ||
        title;
      createdAt = typeof d.creationDate === "number" ? d.creationDate : undefined;
      updatedAt = typeof d.lastMessageDate === "number" ? d.lastMessageDate : undefined;
      const reqs = (d.requests ?? []) as Json[];
      for (const r of reqs) {
        const msg = (r.message ?? {}) as Json;
        const userText =
          typeof msg.text === "string" ? msg.text : typeof r.message === "string" ? r.message : "";
        if (userText.trim()) {
          if (title === id) title = userText.trim().slice(0, 80);
          items.push({
            type: "message",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            role: "user",
            content: [{ type: "text", text: userText.trim() }],
            timestamp:
              typeof r.timestamp === "number" ? new Date(r.timestamp).toISOString() : undefined,
          });
        }
        const respText = responseToText(r.response);
        if (respText) {
          items.push({
            type: "message",
            itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            role: "assistant",
            content: [{ type: "text", text: respText }],
            model: typeof r.modelId === "string" ? r.modelId : undefined,
            timestamp:
              typeof r.timestamp === "number" ? new Date(r.timestamp).toISOString() : undefined,
          });
          model = typeof r.modelId === "string" ? r.modelId : model;
        }
      }
    } else if (p.stateDb && fs.existsSync(p.stateDb)) {
      // 仅有 index 元数据
      const db = openRo(p.stateDb);
      try {
        const row = db
          .prepare(`SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'`)
          .get() as { value?: unknown } | undefined;
        if (row?.value != null) {
          const idx = decodeValue(row.value) as Json;
          const e = ((idx?.entries ?? {}) as Record<string, Json>)[id];
          if (e) {
            title = typeof e.title === "string" && e.title.trim() ? e.title.trim() : id;
            updatedAt = typeof e.lastMessageDate === "number" ? e.lastMessageDate : undefined;
          }
        }
      } finally {
        db.close();
      }
      items.push({
        type: "message",
        itemId: `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        role: "system",
        content: [
          {
            type: "text",
            text: "该会话仅在 ChatSessionStore.index 中有元数据，本地未找到 emptyWindowChatSessions 正文文件。",
          },
        ],
      });
    }

    const header = createHeader(
      {
        id,
        sourceClient: "vscode",
        sourceSessionId: id,
        title: title.slice(0, 200),
        createdAt: createdAt ? new Date(createdAt).toISOString() : undefined,
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : undefined,
        model,
      },
      { note: "vscode-copilot-chat-readonly" },
    );
    return { header, items };
  }

  async writeSession(): Promise<WriteResult> {
    return {
      status: "failed",
      sessionId: "",
      error: "VS Code Copilot Chat 本地格式仅支持只读；可作为迁移源",
    };
  }
}

export function createVsCodeAdapter(paths?: VsCodePaths): VsCodeAdapter {
  return new VsCodeAdapter(paths);
}
