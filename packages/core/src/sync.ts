/**
 * 云同步引擎：把本地 IR 会话同步到远端存储
 * 范围：按项目 group / 单条 session / 按来源 client
 * 存储后端：directory（本地/NAS/对象存储挂载）或 http（可选）
 */

import fs from "node:fs";
import path from "node:path";
import type { Adapter } from "./adapter.js";
import { serializeHarbor, type HarborIR } from "./ir.js";
import { encryptJson, decryptJson, contentFingerprint, generatePassphrase } from "./crypto.js";
import { timestampTag } from "./time.js";

export type SyncScope = "client" | "group" | "session" | "all";

export interface SyncFilter {
  scope: SyncScope;
  /** scope=client 时必填 */
  client?: string;
  /** scope=group 时必填（cwd 目录名 / project） */
  group?: string;
  /** scope=session 时必填 */
  sessionId?: string;
  /** 可选限制到某个 adapter id（与 client 同义） */
  onlyClient?: string;
}

export interface CloudTarget {
  kind: "directory";
  /** 云端根目录（本地挂载 / 网盘 / 对象存储同步盘） */
  root: string;
}

export interface SyncManifestEntry {
  sessionId: string;
  sourceClient: string;
  group?: string;
  title: string;
  fingerprint: string;
  updatedAtMs?: number;
  syncedAt: string;
  path: string; // 相对 root
}

export interface SyncManifest {
  version: 1;
  updatedAt: string;
  entries: SyncManifestEntry[];
}

export interface SyncResult {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  notes: string[];
  items: Array<{
    sessionId: string;
    title: string;
    status: "uploaded" | "skipped" | "failed";
    message?: string;
    remotePath?: string;
  }>;
}

export interface SyncOptions {
  adapters: Adapter[];
  target: CloudTarget;
  filter: SyncFilter;
  passphrase: string;
  /** 本地配置/清单目录，默认 <cwd>/.sessionharbor/sync */
  workdir: string;
  dryRun?: boolean;
}

export function syncConfigPath(workdir: string): string {
  return path.join(workdir, ".sessionharbor", "sync", "config.json");
}

export function loadOrCreateSyncConfig(workdir: string): { passphrase: string; targetRoot?: string } {
  const p = syncConfigPath(workdir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      /* recreate */
    }
  }
  const cfg = { passphrase: generatePassphrase() };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf-8");
  return cfg;
}

function manifestPath(root: string): string {
  return path.join(root, "manifest.json");
}

function loadManifest(root: string): SyncManifest {
  const p = manifestPath(root);
  if (!fs.existsSync(p)) {
    return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as SyncManifest;
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
  }
}

function saveManifest(root: string, m: SyncManifest): void {
  fs.mkdirSync(root, { recursive: true });
  m.updatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath(root), JSON.stringify(m, null, 2), "utf-8");
}

function safeSeg(s: string): string {
  return s.replace(/[^\w一-鿿.-]+/g, "_").slice(0, 80) || "_";
}

function remoteRelPath(client: string, group: string | undefined, sessionId: string): string {
  const g = safeSeg(group || "ungrouped");
  const id = safeSeg(sessionId);
  return path.posix.join("sessions", safeSeg(client), g, `${id}.harbor.enc.json`);
}

/** 解析同步范围，得到待同步会话清单 */
async function collectSessions(
  adapters: Adapter[],
  filter: SyncFilter,
): Promise<Array<{ adapter: Adapter; id: string; title: string; group?: string; client: string }>> {
  const out: Array<{
    adapter: Adapter;
    id: string;
    title: string;
    group?: string;
    client: string;
  }> = [];
  for (const adapter of adapters) {
    if (filter.scope === "client" && filter.client && adapter.id !== filter.client) continue;
    if (filter.onlyClient && adapter.id !== filter.onlyClient) continue;
    let sessions;
    try {
      sessions = await adapter.listSessions();
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (filter.scope === "session") {
        if (filter.sessionId && !(s.id === filter.sessionId || s.id.startsWith(filter.sessionId))) {
          continue;
        }
      }
      if (filter.scope === "group") {
        const g = s.group || "";
        if (!filter.group || !g.toLowerCase().includes(filter.group.toLowerCase())) continue;
      }
      out.push({
        adapter,
        id: s.id,
        title: s.title,
        group: s.group,
        client: adapter.id,
      });
    }
  }
  return out;
}

export async function syncToCloud(opts: SyncOptions): Promise<SyncResult> {
  const { target, filter, passphrase, workdir } = opts;
  const result: SyncResult = {
    total: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    notes: [],
    items: [],
  };

  fs.mkdirSync(target.root, { recursive: true });
  const manifest = loadManifest(target.root);
  const byId = new Map(manifest.entries.map((e) => [`${e.sourceClient}::${e.sessionId}`, e]));

  const selected = await collectSessions(opts.adapters, filter);
  result.total = selected.length;
  result.notes.push(
    `范围 scope=${filter.scope}` +
      (filter.client ? ` client=${filter.client}` : "") +
      (filter.group ? ` group=${filter.group}` : "") +
      (filter.sessionId ? ` session=${filter.sessionId}` : "") +
      `，命中 ${selected.length} 条`,
  );

  if (opts.dryRun) {
    for (const s of selected) {
      result.skipped++;
      result.items.push({
        sessionId: s.id,
        title: s.title,
        status: "skipped",
        message: "dry-run",
        remotePath: remoteRelPath(s.client, s.group, s.id),
      });
    }
    result.notes.push("dry-run 未写入远端");
    return result;
  }

  for (const s of selected) {
    try {
      const ir: HarborIR = await s.adapter.readSession(s.id);
      const fp = contentFingerprint({
        session: ir.header.session,
        items: ir.items.map((i) => ("itemId" in i ? i.itemId : i.type) + i.type),
      });
      const key = `${s.client}::${s.id}`;
      const prev = byId.get(key);
      if (prev && prev.fingerprint === fp) {
        result.skipped++;
        result.items.push({
          sessionId: s.id,
          title: s.title,
          status: "skipped",
          message: "内容未变更",
          remotePath: prev.path,
        });
        continue;
      }

      const rel = remoteRelPath(s.client, s.group, s.id);
      const abs = path.join(target.root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const plain = serializeHarbor(ir);
      const blob = encryptJson(
        {
          header: ir.header,
          text: plain,
          meta: {
            sourceClient: s.client,
            group: s.group,
            title: ir.header.session.title,
            updatedAtMs: ir.header.session.updatedAt
              ? Date.parse(ir.header.session.updatedAt)
              : undefined,
          },
        },
        passphrase,
        s.id,
      );
      fs.writeFileSync(abs, JSON.stringify(blob), "utf-8");

      const entry: SyncManifestEntry = {
        sessionId: s.id,
        sourceClient: s.client,
        group: s.group,
        title: ir.header.session.title,
        fingerprint: fp,
        updatedAtMs: ir.header.session.updatedAt
          ? Date.parse(ir.header.session.updatedAt)
          : undefined,
        syncedAt: new Date().toISOString(),
        path: rel,
      };
      if (prev) {
        Object.assign(prev, entry);
      } else {
        manifest.entries.push(entry);
        byId.set(key, entry);
      }
      result.uploaded++;
      result.items.push({
        sessionId: s.id,
        title: s.title,
        status: "uploaded",
        remotePath: rel,
      });
    } catch (e) {
      result.failed++;
      result.items.push({
        sessionId: s.id,
        title: s.title,
        status: "failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  saveManifest(target.root, manifest);
  result.notes.push(`清单: ${manifestPath(target.root)}`);
  result.notes.push(`同步时间戳: ${timestampTag()}`);
  return result;
}

export function listCloudSessions(root: string): SyncManifestEntry[] {
  return loadManifest(root).entries;
}

export function downloadCloudSession(
  root: string,
  entry: SyncManifestEntry,
  passphrase: string,
): { header: unknown; text: string } {
  const abs = path.join(root, entry.path);
  const blob = JSON.parse(fs.readFileSync(abs, "utf-8"));
  return decryptJson(blob, passphrase);
}

export function formatSyncResult(r: SyncResult): string {
  const lines = [
    `同步: 共 ${r.total}  上传 ${r.uploaded}  跳过 ${r.skipped}  失败 ${r.failed}`,
    "",
  ];
  for (const n of r.notes) lines.push(`[note] ${n}`);
  for (const i of r.items) {
    lines.push(`[${i.status}] ${i.title} (${i.sessionId})${i.message ? " | " + i.message : ""}`);
  }
  return lines.join("\n");
}
