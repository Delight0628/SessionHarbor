/**
 * 本机已安装客户端自动探测
 * 对每个已知适配器调用 discover，返回「已安装/路径/错误」
 */

import { discoverAlink } from "./paths.js";
import { discoverClaudeCode } from "./paths.js";
import { discoverWorkbuddy } from "./paths.js";
import type { ClientPathsLike } from "./adapter.js";

export interface DetectedClient {
  id: string;
  displayName: string;
  installed: boolean;
  dataRoot?: string;
  primaryDb?: string;
  jsonlDir?: string;
  projectsRoot?: string;
  sessionsRoot?: string;
  error?: string;
  /** 读能力 */
  canRead: boolean;
  canWrite: boolean;
}

export interface DetectOptions {
  /** 额外探测器：codex / mimo / chatgpt-export 等在适配器包内 */
  extra?: Array<{
    id: string;
    displayName: string;
    discover: () => ClientPathsLike;
    canRead?: boolean;
    canWrite?: boolean;
  }>;
}

export function detectClients(opts: DetectOptions = {}): DetectedClient[] {
  const out: DetectedClient[] = [];

  const tryOne = (
    id: string,
    displayName: string,
    fn: () => ClientPathsLike,
    canRead = true,
    canWrite = true,
  ) => {
    try {
      const p = fn();
      out.push({
        id,
        displayName,
        installed: true,
        dataRoot: p.dataRoot,
        primaryDb: p.primaryDb,
        jsonlDir: p.jsonlDir,
        projectsRoot: p.projectsRoot,
        sessionsRoot: (p as ClientPathsLike & { sessionsRoot?: string }).sessionsRoot,
        canRead,
        canWrite,
      });
    } catch (e) {
      out.push({
        id,
        displayName,
        installed: false,
        error: e instanceof Error ? e.message : String(e),
        canRead: false,
        canWrite: false,
      });
    }
  };

  tryOne("alink", "领慧AI工作台", () => discoverAlink());
  tryOne("claude-code", "Claude Code", () => discoverClaudeCode());
  tryOne("workbuddy", "WorkBuddy", () => discoverWorkbuddy());

  for (const e of opts.extra ?? []) {
    tryOne(e.id, e.displayName, e.discover, e.canRead ?? true, e.canWrite ?? true);
  }

  return out;
}

export function formatDetectSummary(list: DetectedClient[]): string {
  const ok = list.filter((c) => c.installed);
  const no = list.filter((c) => !c.installed);
  const lines = [
    `已检测到 ${ok.length} 个客户端: ${ok.map((c) => c.displayName).join("、") || "无"}`,
  ];
  if (no.length) {
    lines.push(`未检测到: ${no.map((c) => c.displayName).join("、")}`);
  }
  for (const c of ok) {
    const parts = [c.primaryDb, c.jsonlDir, c.projectsRoot, c.sessionsRoot].filter(Boolean);
    lines.push(`  · ${c.id}: ${parts[0] || c.dataRoot || ""}`);
  }
  return lines.join("\n");
}
