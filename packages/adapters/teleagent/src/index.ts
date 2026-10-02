/**
 * TeleAgent 适配器（只读源）
 *
 * 数据目录: %USERPROFILE%/.local/share/TeleAgent/users/<userId>/teleagent.db
 * 数据模型: session → message(data JSON) → part(data JSON)，与 OpenCode 系同源。
 *
 * 与同源的 MiMo 有三处实测差异，读取时必须区别对待：
 * 1. message 表没有 agent_id 列，role / modelID / parentID 全部在 data JSON 里；
 * 2. part 除了 text / tool，还有 reasoning（思维链）、compaction（压缩边界）
 *    与纯计时的 step-start / step-finish；
 * 3. **一次 assistant 回复会被拆成多条 message**（每个 step 一条），它们共享同一个
 *    parentID。若照字面把 parentID 映射成 IR 的 parentItemId，一轮回复会变成
 *    几十个同父兄弟节点，fork 检测会把它们误判成几十个分叉会话。
 *    因此这里按「连续且同 parentID 的 assistant 消息 = 同一轮回复的续写」折叠成线性链。
 *
 * 读：全量支持（列表 / IR / 导出 / 检索 / 索引 / 脱敏 / 去重），这是本适配器的全部职责。
 * 写：有意保持只读（capabilities.write = false），与 DeepSeek Harness / ChatGPT Export 同列只读源。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const DB_NAME = "teleagent.db";
/** 工具输出进索引前的长度上限，避免单个大结果把 FTS 库撑爆 */
const TOOL_OUTPUT_LIMIT = 4000;

/* ------------------------------------------------------------------ 工具函数 */

function parseJson(raw: unknown): Json {
  if (raw && typeof raw === "object") return raw as Json;
  try {
    const v = JSON.parse(String(raw ?? "{}"));
    return v && typeof v === "object" ? (v as Json) : {};
  } catch {
    return {};
  }
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function itemId(): string {
  return `item_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function clip(text: string): string {
  return text.length > TOOL_OUTPUT_LIMIT ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n…(已截断)` : text;
}

/** 客户端侧对象非字符串时（如 output 已是结构化值）转成可读文本 */
function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normRole(role: unknown): "user" | "assistant" | "system" {
  return role === "assistant" || role === "system" ? role : "user";
}

/** assistant 把模型摊在 data.modelID，user 放在 data.model.modelID */
function pickModel(data: Json): string | undefined {
  const direct = data.modelID;
  if (typeof direct === "string" && direct) return direct;
  const nested = (data.model as Json | undefined)?.modelID;
  return typeof nested === "string" && nested ? nested : undefined;
}

/* ------------------------------------------------------------------ 路径发现 */

function candidateRoots(): string[] {
  const roots = new Set<string>();
  for (const k of ["USERPROFILE", "HOME"]) {
    if (process.env[k]) roots.add(process.env[k]!);
  }
  roots.add(os.homedir());
  // %APPDATA% = ...\AppData\Roaming，%LOCALAPPDATA% = ...\AppData\Local
  // 两者的父目录都是 ...\AppData，正好覆盖 AppData\{Local,Roaming}\TeleAgent
  for (const k of ["APPDATA", "LOCALAPPDATA"]) {
    if (process.env[k]) roots.add(path.dirname(process.env[k]!));
  }
  return [...roots];
}

/** .../TeleAgent/users/<userId>/teleagent.db → .../TeleAgent */
function dataRootFor(db: string): string {
  const userDir = path.dirname(db);
  const usersDir = path.dirname(userDir);
  if (path.basename(usersDir).toLowerCase() === "users") return path.dirname(usersDir);
  return userDir;
}

function collectDbs(): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const abs = path.resolve(p);
    if (seen.has(abs) || !fs.existsSync(abs)) return;
    seen.add(abs);
    hits.push(abs);
  };

  for (const root of candidateRoots()) {
    for (const rel of [
      path.join(".local", "share", "TeleAgent"),
      "TeleAgent",
      path.join("AppData", "Local", "TeleAgent"),
      path.join("AppData", "Roaming", "TeleAgent"),
    ]) {
      const base = path.join(root, rel);
      if (!isDir(base)) continue;
      add(path.join(base, DB_NAME)); // 单用户布局
      const users = path.join(base, "users");
      if (!isDir(users)) continue;
      for (const u of listDirs(users)) add(path.join(users, u, DB_NAME));
    }
  }
  return hits;
}

export function discoverTeleagent(explicitDb?: string): ClientPathsLike {
  const explicit = explicitDb || process.env.HARBOR_TELEAGENT_DB;
  if (explicit) {
    const p = path.resolve(explicit.replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!fs.existsSync(p)) throw new Error(`teleagent.db 不存在: ${p}`);
    return { id: "teleagent", dataRoot: dataRootFor(p), primaryDb: p, extraDbs: [] };
  }

  const hits = collectDbs();
  if (!hits.length) {
    throw new Error("未找到 teleagent.db，可用 --teleagent-db 指定或设置 HARBOR_TELEAGENT_DB");
  }
  // 多账号目录时取最近写入的那个，其余作为 extraDbs 供备份
  hits.sort((a, b) => (fs.statSync(b).mtimeMs || 0) - (fs.statSync(a).mtimeMs || 0));
  return {
    id: "teleagent",
    dataRoot: dataRootFor(hits[0]!),
    primaryDb: hits[0]!,
    extraDbs: hits.slice(1),
  };
}

/** 回收站：客户端把已删会话的 id 记进 state/deleted-session-ids.json（行可能已不在库中） */
function readDeletedIds(dbPath: string): Set<string> {
  const out = new Set<string>();
  try {
    const raw = parseJson(
      fs.readFileSync(path.join(path.dirname(dbPath), "state", "deleted-session-ids.json"), "utf-8"),
    );
    const map = (raw.deletedSessionIds ?? raw) as Json;
    if (map && typeof map === "object") for (const k of Object.keys(map)) out.add(k);
  } catch {
    /* 无回收站记录 */
  }
  return out;
}

/* ------------------------------------------------------------------ 适配器 */

export class TeleagentAdapter implements Adapter {
  id = "teleagent";
  displayName = "TeleAgent";
  capabilities = { read: true, write: false, incremental: false, live: false };
  private paths?: ClientPathsLike;

  constructor(paths?: ClientPathsLike) {
    this.paths = paths;
  }

  discover(): ClientPathsLike {
    if (!this.paths) this.paths = discoverTeleagent();
    return this.paths;
  }

  private ensure(): ClientPathsLike {
    return this.paths ?? this.discover();
  }

  async listSessions(): Promise<SessionSummary[]> {
    const p = this.ensure();
    const db = openRo(p.primaryDb!);
    try {
      // 一次聚合拿到全部消息数，避免逐会话子查询
      const counts = new Map<string, number>();
      for (const r of db
        .prepare(`SELECT session_id, count(*) AS c FROM message GROUP BY session_id`)
        .all() as Json[]) {
        counts.set(String(r.session_id), Number(r.c));
      }

      const deleted = readDeletedIds(p.primaryDb!);
      const rows = db
        .prepare(
          `SELECT id, project_id, parent_id, slug, directory, title, version,
                  time_created, time_updated, time_archived
           FROM session ORDER BY time_updated DESC`,
        )
        .all() as Json[];

      return rows.map((r) => {
        const id = String(r.id);
        const directory = (r.directory as string) || undefined;
        const parentId = (r.parent_id as string) || undefined;
        return {
          id,
          title: String(r.title || r.slug || id),
          cwd: directory,
          group: directory ? path.basename(directory) || directory : (r.project_id as string) || undefined,
          createdAtMs: num(r.time_created),
          updatedAtMs: num(r.time_updated),
          messageCount: counts.get(id),
          deleted: r.time_archived != null || deleted.has(id),
          meta: {
            project_id: r.project_id,
            slug: r.slug,
            version: r.version,
            parentSessionId: parentId,
          },
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
          `SELECT id, project_id, parent_id, slug, directory, title, version,
                  time_created, time_updated
           FROM session WHERE id = ?`,
        )
        .get(id) as Json | undefined;
      if (!row) throw new Error(`TeleAgent 会话不存在: ${id}`);

      const msgs = db
        .prepare(
          `SELECT id, data, time_created FROM message WHERE session_id = ?
           ORDER BY time_created ASC, id ASC`,
        )
        .all(id) as Json[];

      const partsByMsg = new Map<string, Json[]>();
      for (const pr of db
        .prepare(
          `SELECT message_id, data FROM part WHERE session_id = ?
           ORDER BY time_created ASC, id ASC`,
        )
        .all(id) as Json[]) {
        const key = String(pr.message_id);
        const list = partsByMsg.get(key) ?? [];
        list.push(pr);
        partsByMsg.set(key, list);
      }

      // 会话模型取首条 assistant 的取值，避免把 user 消息标成模型拥有者
      let model: string | undefined;
      let pathCwd: string | undefined;
      for (const m of msgs) {
        const data = parseJson(m.data);
        if (!model && normRole(data.role) === "assistant") model = pickModel(data);
        if (!pathCwd) {
          const cwd = (data.path as Json | undefined)?.cwd;
          if (typeof cwd === "string" && cwd) pathCwd = cwd;
        }
        if (model && pathCwd) break;
      }

      const items: HarborItem[] = [];
      /** DB message id → 该消息最后一个 IR item 的 id */
      const tailOf = new Map<string, string>();
      let prevTail: string | undefined;
      let prevRole: string | undefined;
      let prevParentKey: string | undefined;

      for (const m of msgs) {
        const msgId = String(m.id);
        const data = parseJson(m.data);
        const role = normRole(data.role);
        const ts = num((data.time as Json | undefined)?.created) ?? num(m.time_created);
        const timestamp = ts ? new Date(ts).toISOString() : undefined;
        const parentKey = typeof data.parentID === "string" ? data.parentID : undefined;

        // step 续写：上一条也是 assistant 且同 parentID，说明是同一轮回复的后续步骤，
        // 直接接在上一条尾巴上；否则才按 parentID 挂回父消息（这才是真正的分叉点）
        let chain: string | undefined;
        if (prevRole === "assistant" && parentKey && parentKey === prevParentKey) {
          chain = prevTail;
        } else {
          chain = (parentKey ? tailOf.get(parentKey) : undefined) ?? prevTail;
        }

        for (const pr of partsByMsg.get(msgId) ?? []) {
          const pd = parseJson(pr.data);
          const type = String(pd.type ?? "");
          const iid = itemId();

          if (type === "text") {
            const text = String(pd.text ?? "");
            if (!text.trim()) continue;
            items.push({
              type: "message",
              itemId: iid,
              role,
              content: [{ type: "text", text }],
              parentItemId: chain,
              timestamp,
              model,
            });
            chain = iid;
          } else if (type === "reasoning") {
            const text = String(pd.text ?? "");
            if (!text.trim()) continue;
            items.push({ type: "thinking", itemId: iid, text, parentItemId: chain, timestamp });
            chain = iid;
          } else if (type === "tool") {
            const state = (pd.state ?? {}) as Json;
            const callId = String(pd.callID ?? iid);
            items.push({
              type: "tool_call",
              itemId: iid,
              callId,
              toolName: String(pd.tool ?? "tool"),
              input: state.input ?? {},
              parentItemId: chain,
              timestamp,
            });
            chain = iid;
            const output = clip(stringify(state.output));
            if (output) {
              const outId = itemId();
              items.push({
                type: "tool_output",
                itemId: outId,
                callId,
                output,
                isError: state.status === "error" || state.status === "denied",
                timestamp,
              });
              chain = outId;
            }
          } else if (type === "compaction") {
            items.push({
              type: "checkpoint",
              itemId: iid,
              label: pd.auto ? "自动压缩（compaction）" : "压缩（compaction）",
              files: [],
            });
            chain = iid;
          }
          // step-start / step-finish 只是计时标记，不进 IR
        }

        if (chain) tailOf.set(msgId, chain);
        prevTail = chain;
        prevRole = role;
        prevParentKey = parentKey;
      }

      const createdMs = num(row.time_created);
      const updatedMs = num(row.time_updated);
      const header = createHeader(
        {
          id,
          sourceClient: "teleagent",
          sourceSessionId: id,
          title: String(row.title || row.slug || id),
          createdAt: createdMs ? new Date(createdMs).toISOString() : undefined,
          updatedAt: updatedMs ? new Date(updatedMs).toISOString() : undefined,
          cwd: (row.directory as string) || pathCwd,
          model,
        },
        {
          projectId: row.project_id,
          slug: row.slug,
          version: row.version,
          parentSessionId: row.parent_id || undefined,
        },
      );
      return { header, items };
    } finally {
      db.close();
    }
  }

  async writeSession(): Promise<WriteResult> {
    return {
      status: "failed",
      sessionId: "",
      error: "TeleAgent 为只读源，暂不支持迁入写入",
    };
  }
}

export function createTeleagentAdapter(paths?: ClientPathsLike): TeleagentAdapter {
  return new TeleagentAdapter(paths);
}