/** 适配器统一接口与公共类型 */

import type { HarborIR, SessionMeta } from "./ir.js";

export interface AdapterCapabilities {
  read: boolean;
  write: boolean;
  incremental: boolean;
  live: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  cwd?: string;
  group?: string;
  model?: string;
  messageCount?: number;
  deleted?: boolean;
  meta?: Record<string, unknown>;
}

export interface WriteResult {
  status: "ok" | "skipped" | "failed";
  sessionId: string;
  messageCount?: number;
  reason?: string;
  error?: string;
  targetPath?: string;
  detail?: Record<string, unknown>;
}

export interface Adapter {
  id: string;
  displayName: string;
  capabilities: AdapterCapabilities;
  discover(): ClientPathsLike;
  listSessions(opts?: { loadMessages?: boolean }): Promise<SessionSummary[]>;
  readSession(id: string): Promise<HarborIR>;
  writeSession(ir: HarborIR, opts?: { overwrite?: boolean }): Promise<WriteResult>;
}

export interface ClientPathsLike {
  id: string;
  dataRoot: string;
  primaryDb?: string;
  jsonlDir?: string;
  projectsRoot?: string;
  extraDbs: string[];
}

export type { HarborIR, SessionMeta };
