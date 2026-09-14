/**
 * 云同步：push / pull
 * 后端：
 *  - directory：本地目录或网盘同步盘（OneDrive / 坚果云 / 飞书云盘 挂载目录）
 *  - webdav：任意 WebDAV（坚果云/NextCloud/自建）
 * 范围：client / group / session / all
 * 端到端加密后写入远端；pull 时解密回本地 vault，可选写回目标客户端
 */

import fs from "node:fs";
import path from "node:path";
import { serializeHarbor, parseHarborJsonl, type HarborIR } from "./ir.js";
import { encryptJson, decryptJson, contentFingerprint, generatePassphrase } from "./crypto.js";
import { timestampTag } from "./time.js";
import type { Adapter } from "./adapter.js";
import { checkHostedQuota, hostedCloudEnabled, type License } from "./billing.js";

export type SyncScope = "client" | "group" | "session" | "all";
export type SyncDirection = "push" | "pull";

export interface SyncFilter {
  scope: SyncScope;
  client?: string;
  group?: string;
  sessionId?: string;
  onlyClient?: string;
}

export type CloudTarget =
  | { kind: "directory"; root: string }
  | {
      kind: "webdav";
      baseUrl: string;
      username?: string;
      password?: string;
      /** 远端根路径，默认 /sessionharbor */
      remotePath?: string;
    }
  | {
      /** SessionHarbor 官方托管云（付费） */
      kind: "hosted";
      endpoint: string;
      token?: string;
    };

export interface SyncManifestEntry {
  sessionId: string;
  sourceClient: string;
  group?: string;
  title: string;
  fingerprint: string;
  updatedAtMs?: number;
  syncedAt: string;
  path: string;
}

export interface SyncManifest {
  version: 1;
  updatedAt: string;
  entries: SyncManifestEntry[];
}

export interface SyncItemResult {
  sessionId: string;
  title: string;
  status: "uploaded" | "downloaded" | "restored" | "skipped" | "failed";
  message?: string;
  remotePath?: string;
  localPath?: string;
}

export interface SyncResult {
  direction: SyncDirection;
  total: number;
  uploaded: number;
  downloaded: number;
  restored: number;
  skipped: number;
  failed: number;
  notes: string[];
  items: SyncItemResult[];
}

export interface PushOptions {
  adapters: Adapter[];
  target: CloudTarget;
  filter: SyncFilter;
  passphrase: string;
  workdir: string;
  dryRun?: boolean;
  /** 许可证；kind=hosted 时校验额度 */
  license?: License;
}

export interface PullOptions {
  target: CloudTarget;
  filter: SyncFilter;
  passphrase: string;
  workdir: string;
  /** 解密后写入本地 vault；若提供 restoreTo 适配器则尝试写回客户端 */
  restoreTo?: Adapter;
  overwrite?: boolean;
  dryRun?: boolean;
}

// ---------- 抽象存储 ----------

export interface CloudStore {
  listManifest(): Promise<SyncManifest>;
  saveManifest(m: SyncManifest): Promise<void>;
  putFile(relPath: string, body: string): Promise<void>;
  getFile(relPath: string): Promise<string>;
  exists(relPath: string): Promise<boolean>;
  describe(): string;
}

export function createDirectoryStore(root: string): CloudStore {
  const abs = (rel: string) => path.join(root, rel);
  return {
    describe: () => `directory:${root}`,
    async listManifest() {
      const p = abs("manifest.json");
      if (!fs.existsSync(p)) return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
      try {
        return JSON.parse(fs.readFileSync(p, "utf-8")) as SyncManifest;
      } catch {
        return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
      }
    },
    async saveManifest(m) {
      fs.mkdirSync(root, { recursive: true });
      m.updatedAt = new Date().toISOString();
      fs.writeFileSync(abs("manifest.json"), JSON.stringify(m, null, 2), "utf-8");
    },
    async putFile(rel, body) {
      const p = abs(rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body, "utf-8");
    },
    async getFile(rel) {
      return fs.readFileSync(abs(rel), "utf-8");
    },
    async exists(rel) {
      return fs.existsSync(abs(rel));
    },
  };
}

function webdavAuth(t: Extract<CloudTarget, { kind: "webdav" }>): string | undefined {
  if (!t.username) return undefined;
  return "Basic " + Buffer.from(`${t.username}:${t.password || ""}`).toString("base64");
}

function webdavUrl(t: Extract<CloudTarget, { kind: "webdav" }>, rel: string): string {
  const base = t.baseUrl.replace(/\/+$/, "");
  const root = (t.remotePath || "/sessionharbor").replace(/\/+$/, "");
  const r = rel.replace(/^\/+/, "");
  return `${base}${root}/${r}`;
}

export function createWebdavStore(t: Extract<CloudTarget, { kind: "webdav" }>): CloudStore {
  const headers = () => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const auth = webdavAuth(t);
    if (auth) h.Authorization = auth;
    return h;
  };
  async function ensureDir(relDir: string) {
    // 逐级 MKCOL（已存在忽略）
    const base = t.baseUrl.replace(/\/+$/, "");
    const root = (t.remotePath || "/sessionharbor").replace(/\/+$/, "");
    const parts = root.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur += "/" + part;
      try {
        await fetch(base + cur, { method: "MKCOL", headers: headers() });
      } catch {
        /* exists or no perm */
      }
    }
    const segs = relDir.split("/").filter(Boolean);
    let fromRoot = root;
    for (const s of segs) {
      fromRoot += "/" + s;
      try {
        await fetch(base + fromRoot, { method: "MKCOL", headers: headers() });
      } catch {
        /* ignore */
      }
    }
  }
  return {
    describe: () => `webdav:${webdavUrl(t, "")}`,
    async listManifest() {
      try {
        const res = await fetch(webdavUrl(t, "manifest.json"), { headers: headers() });
        if (!res.ok) return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
        return (await res.json()) as SyncManifest;
      } catch {
        return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
      }
    },
    async saveManifest(m) {
      m.updatedAt = new Date().toISOString();
      await ensureDir("");
      await fetch(webdavUrl(t, "manifest.json"), {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify(m, null, 2),
      });
    },
    async putFile(rel, body) {
      const dir = path.posix.dirname(rel);
      if (dir && dir !== ".") await ensureDir(dir);
      const res = await fetch(webdavUrl(t, rel), {
        method: "PUT",
        headers: headers(),
        body,
      });
      if (!res.ok) throw new Error(`WebDAV PUT ${res.status} ${rel}`);
    },
    async getFile(rel) {
      const res = await fetch(webdavUrl(t, rel), { headers: headers() });
      if (!res.ok) throw new Error(`WebDAV GET ${res.status} ${rel}`);
      return await res.text();
    },
    async exists(rel) {
      const res = await fetch(webdavUrl(t, rel), { method: "HEAD", headers: headers() });
      return res.ok;
    },
  };
}

export function createStore(target: CloudTarget): CloudStore {
  if (target.kind === "webdav") return createWebdavStore(target);
  if (target.kind === "hosted") {
    // 托管云：REST API（与 WebDAV 类似的 PUT/GET + Authorization Bearer）
    const headers = () => {
      const h: Record<string, string> = { "Content-Type": "application/json" };
      if (target.token) h.Authorization = `Bearer ${target.token}`;
      return h;
    };
    const url = (rel: string) => `${target.endpoint.replace(/\/+$/, "")}/v1/sync/${rel.replace(/^\/+/, "")}`;
    return {
      describe: () => `hosted:${target.endpoint}`,
      async listManifest() {
        try {
          const res = await fetch(url("manifest.json"), { headers: headers() });
          if (!res.ok) return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
          return (await res.json()) as SyncManifest;
        } catch {
          return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
        }
      },
      async saveManifest(m) {
        m.updatedAt = new Date().toISOString();
        const res = await fetch(url("manifest.json"), {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify(m),
        });
        if (!res.ok) throw new Error(`Hosted manifest PUT ${res.status}`);
      },
      async putFile(rel, body) {
        const res = await fetch(url(rel), { method: "PUT", headers: headers(), body });
        if (res.status === 402) throw new Error("托管云额度不足，请升级套餐（或改用 BYO 网盘/WebDAV）");
        if (!res.ok) throw new Error(`Hosted PUT ${res.status} ${rel}`);
      },
      async getFile(rel) {
        const res = await fetch(url(rel), { headers: headers() });
        if (!res.ok) throw new Error(`Hosted GET ${res.status} ${rel}`);
        return await res.text();
      },
      async exists(rel) {
        const res = await fetch(url(rel), { method: "HEAD", headers: headers() });
        return res.ok;
      },
    };
  }
  return createDirectoryStore(target.root);
}

// ---------- helpers ----------

function safeSeg(s: string): string {
  return s.replace(/[^\w一-鿿.-]+/g, "_").slice(0, 80) || "_";
}

function remoteRelPath(client: string, group: string | undefined, sessionId: string): string {
  return path.posix.join(
    "sessions",
    safeSeg(client),
    safeSeg(group || "ungrouped"),
    `${safeSeg(sessionId)}.harbor.enc.json`,
  );
}

function vaultRoot(workdir: string): string {
  return path.join(workdir, ".sessionharbor", "vault");
}

function matchFilter(
  e: { sessionId: string; sourceClient: string; group?: string },
  filter: SyncFilter,
): boolean {
  if (filter.scope === "client" && filter.client && e.sourceClient !== filter.client) return false;
  if (filter.onlyClient && e.sourceClient !== filter.onlyClient) return false;
  if (filter.scope === "group" && filter.group) {
    const g = (e.group || "").toLowerCase();
    if (!g.includes(filter.group.toLowerCase())) return false;
  }
  if (filter.scope === "session" && filter.sessionId) {
    if (!(e.sessionId === filter.sessionId || e.sessionId.startsWith(filter.sessionId))) return false;
  }
  return true;
}

function emptyResult(direction: SyncDirection): SyncResult {
  return {
    direction,
    total: 0,
    uploaded: 0,
    downloaded: 0,
    restored: 0,
    skipped: 0,
    failed: 0,
    notes: [],
    items: [],
  };
}

// ---------- push ----------

export async function pushToCloud(opts: PushOptions): Promise<SyncResult> {
  const result = emptyResult("push");
  const store = createStore(opts.target);
  result.notes.push(`后端: ${store.describe()}`);
  const manifest = await store.listManifest();
  const byId = new Map(manifest.entries.map((e) => [`${e.sourceClient}::${e.sessionId}`, e]));

  const selected: Array<{
    adapter: Adapter;
    id: string;
    title: string;
    group?: string;
    client: string;
  }> = [];
  for (const adapter of opts.adapters) {
    if (opts.filter.scope === "client" && opts.filter.client && adapter.id !== opts.filter.client) continue;
    if (opts.filter.onlyClient && adapter.id !== opts.filter.onlyClient) continue;
    let sessions;
    try {
      sessions = await adapter.listSessions();
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!matchFilter({ sessionId: s.id, sourceClient: adapter.id, group: s.group }, opts.filter))
        continue;
      selected.push({ adapter, id: s.id, title: s.title, group: s.group, client: adapter.id });
    }
  }
  result.total = selected.length;
  result.notes.push(
    `push 范围=${opts.filter.scope}${opts.filter.group ? " group=" + opts.filter.group : ""}${opts.filter.client ? " client=" + opts.filter.client : ""}${opts.filter.sessionId ? " session=" + opts.filter.sessionId : ""}，命中 ${selected.length}`,
  );
  result.notes.push(
    opts.target.kind === "hosted"
      ? "后端=托管云（付费能力）"
      : opts.target.kind === "webdav"
        ? "后端=自备 WebDAV（免费 BYO）"
        : "后端=网盘/本地目录（免费 BYO）",
  );

  // 托管云额度闸门
  if (opts.target.kind === "hosted") {
    const enabled = hostedCloudEnabled(opts.license);
    if (!enabled) {
      result.notes.push("托管云需要有效订阅（Free 托管额度 / Pro / Team）。未订阅时请使用 BYO 目录或 WebDAV。");
      if (!opts.dryRun) {
        result.failed++;
        result.items.push({
          sessionId: "-",
          title: "托管云",
          status: "failed",
          message: "无有效托管云订阅",
        });
        return result;
      }
    } else {
      const usage = { sessions: manifest.entries.length, storageMb: 0 };
      const qc = checkHostedQuota(opts.license, usage);
      result.notes.push(`套餐额度: ${qc.plan}，已用会话 ${usage.sessions}`);
      if (!qc.ok) {
        result.notes.push(qc.reason + (qc.upgradeHint ? ` · ${qc.upgradeHint}` : ""));
        if (!opts.dryRun) {
          result.failed++;
          result.items.push({
            sessionId: "-",
            title: "托管云",
            status: "failed",
            message: qc.reason || "额度不足",
          });
          return result;
        }
      }
    }
  }

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
    return result;
  }

  for (const s of selected) {
    try {
      const ir = await s.adapter.readSession(s.id);
      const fp = contentFingerprint({
        session: ir.header.session,
        items: ir.items.map((i) => {
          const a = i as { type: string; itemId?: string };
          return `${a.itemId || ""}:${a.type}`;
        }),
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
      const blob = encryptJson(
        {
          header: ir.header,
          text: serializeHarbor(ir),
          meta: {
            sourceClient: s.client,
            group: s.group,
            title: ir.header.session.title,
            updatedAtMs: ir.header.session.updatedAt
              ? Date.parse(ir.header.session.updatedAt)
              : undefined,
          },
        },
        opts.passphrase,
        s.id,
      );
      await store.putFile(rel, JSON.stringify(blob));
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
      if (prev) Object.assign(prev, entry);
      else {
        manifest.entries.push(entry);
        byId.set(key, entry);
      }
      result.uploaded++;
      result.items.push({ sessionId: s.id, title: s.title, status: "uploaded", remotePath: rel });
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
  await store.saveManifest(manifest);
  result.notes.push(`清单已更新 ${manifest.entries.length} 条 · ${timestampTag()}`);
  return result;
}

// ---------- pull ----------

export async function pullFromCloud(opts: PullOptions): Promise<SyncResult> {
  const result = emptyResult("pull");
  const store = createStore(opts.target);
  result.notes.push(`后端: ${store.describe()}`);
  const manifest = await store.listManifest();
  let entries = manifest.entries.filter((e) => matchFilter(e, opts.filter));
  if (opts.filter.scope === "client" && opts.filter.client) {
    entries = entries.filter((e) => e.sourceClient === opts.filter.client);
  }
  if (opts.filter.scope === "group" && opts.filter.group) {
    entries = entries.filter((e) =>
      (e.group || "").toLowerCase().includes(opts.filter.group!.toLowerCase()),
    );
  }
  if (opts.filter.scope === "session" && opts.filter.sessionId) {
    entries = entries.filter(
      (e) =>
        e.sessionId === opts.filter.sessionId ||
        e.sessionId.startsWith(opts.filter.sessionId!),
    );
  }
  result.total = entries.length;
  result.notes.push(
    `pull 范围=${opts.filter.scope}，云端命中 ${entries.length}/${manifest.entries.length}`,
  );

  if (opts.dryRun) {
    for (const e of entries) {
      result.skipped++;
      result.items.push({
        sessionId: e.sessionId,
        title: e.title,
        status: "skipped",
        message: "dry-run",
        remotePath: e.path,
      });
    }
    return result;
  }

  const vroot = vaultRoot(opts.workdir);
  fs.mkdirSync(vroot, { recursive: true });

  for (const entry of entries) {
    try {
      const raw = await store.getFile(entry.path);
      const payload = decryptJson<{
        header: { session: Record<string, unknown> };
        text: string;
        meta?: { title?: string; group?: string };
      }>(JSON.parse(raw), opts.passphrase);
      const ir = parseHarborJsonl(payload.text);
      const localRel = path.posix.join(
        safeSeg(entry.sourceClient),
        safeSeg(entry.group || "ungrouped"),
        `${safeSeg(entry.sessionId)}.harbor.jsonl`,
      );
      const localAbs = path.join(vroot, localRel);
      fs.mkdirSync(path.dirname(localAbs), { recursive: true });
      fs.writeFileSync(localAbs, payload.text, "utf-8");
      result.downloaded++;
      result.items.push({
        sessionId: entry.sessionId,
        title: entry.title,
        status: "downloaded",
        remotePath: entry.path,
        localPath: localAbs,
      });

      if (opts.restoreTo) {
        try {
          const wr = await opts.restoreTo.writeSession(ir, { overwrite: opts.overwrite });
          if (wr.status === "ok") {
            result.restored++;
            result.items.push({
              sessionId: entry.sessionId,
              title: entry.title,
              status: "restored",
              message: `已写回 ${opts.restoreTo.id}`,
            });
          } else if (wr.status === "skipped") {
            result.skipped++;
            result.items.push({
              sessionId: entry.sessionId,
              title: entry.title,
              status: "skipped",
              message: wr.reason || "目标已存在",
            });
          } else {
            result.failed++;
            result.items.push({
              sessionId: entry.sessionId,
              title: entry.title,
              status: "failed",
              message: wr.error || "写回失败",
            });
          }
        } catch (re) {
          result.failed++;
          result.items.push({
            sessionId: entry.sessionId,
            title: entry.title,
            status: "failed",
            message: re instanceof Error ? re.message : String(re),
          });
        }
      }
    } catch (err) {
      result.failed++;
      result.items.push({
        sessionId: entry.sessionId,
        title: entry.title,
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  result.notes.push(`本地 vault: ${vroot}`);
  return result;
}

// ---------- config ----------

export function syncConfigPath(workdir: string): string {
  return path.join(workdir, ".sessionharbor", "sync", "config.json");
}

export interface SyncConfig {
  passphrase: string;
  targetKind?: "directory" | "webdav" | "hosted";
  cloudRoot?: string;
  webdavUrl?: string;
  webdavUser?: string;
  webdavPassword?: string;
  webdavRemotePath?: string;
  hostedEndpoint?: string;
  hostedToken?: string;
  license?: import("./billing.js").License;
}

export function loadOrCreateSyncConfig(workdir: string): SyncConfig {
  const p = syncConfigPath(workdir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) {
    try {
      return { ...{ passphrase: generatePassphrase() }, ...JSON.parse(fs.readFileSync(p, "utf-8")) };
    } catch {
      /* recreate */
    }
  }
  const cfg: SyncConfig = { passphrase: generatePassphrase(), targetKind: "directory" };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf-8");
  return cfg;
}

export function saveSyncConfig(workdir: string, cfg: SyncConfig): void {
  const p = syncConfigPath(workdir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf-8");
}

export function resolveTarget(cfg: SyncConfig, workdir: string, overrideRoot?: string): CloudTarget {
  if (cfg.targetKind === "hosted" && cfg.hostedEndpoint) {
    return {
      kind: "hosted",
      endpoint: cfg.hostedEndpoint,
      token: cfg.hostedToken,
    };
  }
  if (cfg.targetKind === "webdav" && cfg.webdavUrl) {
    return {
      kind: "webdav",
      baseUrl: cfg.webdavUrl,
      username: cfg.webdavUser,
      password: cfg.webdavPassword,
      remotePath: cfg.webdavRemotePath || "/sessionharbor",
    };
  }
  return {
    kind: "directory",
    root: path.resolve(overrideRoot || cfg.cloudRoot || path.join(workdir, ".sessionharbor", "cloud")),
  };
}

/** 兼容旧 API 名 */
export const syncToCloud = pushToCloud;

export function listCloudSessions(root: string): SyncManifestEntry[] {
  // directory only sync helper
  const p = path.join(root, "manifest.json");
  if (!fs.existsSync(p)) return [];
  try {
    return (JSON.parse(fs.readFileSync(p, "utf-8")) as SyncManifest).entries;
  } catch {
    return [];
  }
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
    `同步方向: ${r.direction}`,
    `合计 ${r.total} · 上传 ${r.uploaded} · 下载 ${r.downloaded} · 写回 ${r.restored} · 跳过 ${r.skipped} · 失败 ${r.failed}`,
    "",
  ];
  for (const n of r.notes) lines.push(`[note] ${n}`);
  for (const i of r.items) {
    lines.push(`[${i.status}] ${i.title} (${i.sessionId})${i.message ? " | " + i.message : ""}`);
  }
  return lines.join("\n");
}
