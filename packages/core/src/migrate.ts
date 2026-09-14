/** 迁移引擎：筛选、备份、通过适配器读→IR→写 */

import path from "node:path";
import fs from "node:fs";
import type { Adapter, WriteResult } from "./adapter.js";
import type { HarborIR } from "./ir.js";
import { backupMany } from "./backup.js";
import { timestampTag } from "./time.js";
import { toMarkdown, toJson } from "./export.js";
import { stripReminders } from "./text.js";
import { scanText, formatScanSummary } from "./secrets.js";

/** tool_call ↔ tool_output 配对完整性统计 */
export function pairingStats(ir: HarborIR): {
  toolCalls: number;
  toolOutputs: number;
  paired: number;
  orphanCalls: string[];
  orphanOutputs: string[];
} {
  const calls = new Map<string, string>(); // callId -> toolName
  const outputs = new Set<string>();
  for (const item of ir.items) {
    if (item.type === "tool_call") calls.set(item.callId, item.toolName);
    else if (item.type === "tool_output") outputs.add(item.callId);
  }
  const orphanCalls: string[] = [];
  const orphanOutputs: string[] = [];
  let paired = 0;
  for (const [id, name] of calls) {
    if (outputs.has(id)) paired++;
    else orphanCalls.push(`${name}:${id}`);
  }
  for (const id of outputs) {
    if (!calls.has(id)) orphanOutputs.push(id);
  }
  return {
    toolCalls: calls.size,
    toolOutputs: outputs.size,
    paired,
    orphanCalls,
    orphanOutputs,
  };
}

export interface FilterSpec {
  titles?: string[];
  ids?: string[];
  groups?: string[];
  sinceMs?: number;
  untilMs?: number;
  keyword?: string;
  hasMessages?: boolean;
}

export interface MigrationItem {
  status: "success" | "skipped" | "failed";
  sessionId: string;
  title: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface MigrationReport {
  startedAt: string;
  direction: string;
  total: number;
  success: number;
  skipped: number;
  failed: number;
  notes: string[];
  items: MigrationItem[];
  logPath?: string;
  /** 全量 tool 配对汇总 */
  pairing?: {
    toolCalls: number;
    toolOutputs: number;
    paired: number;
    orphanCalls: number;
    orphanOutputs: number;
  };
  /** 敏感信息扫描（若启用） */
  secrets?: { totalHits: number; shouldBlockCloud: boolean; byKind: Record<string, number> };
}

export interface MigrateOptions {
  source: Adapter;
  target: Adapter;
  workdir: string;
  filter?: FilterSpec;
  backup?: boolean;
  dryRun?: boolean;
  overwrite?: boolean;
  limit?: number;
  backupPaths?: string[];
  /** 默认剥离 user 消息中的 system-reminder */
  stripReminders?: boolean;
  /** 迁移前敏感信息扫描并写入报告 */
  scanSecrets?: boolean;
  /** 发现高危敏感信息时阻断写入（dry-run 仍会报告） */
  blockOnSecrets?: boolean;
}

function matchesFilter(
  summary: { id: string; title?: string; group?: string; cwd?: string; createdAtMs?: number; updatedAtMs?: number },
  ir: HarborIR | undefined,
  filter: FilterSpec,
): boolean {
  if (filter.ids?.length) {
    if (!filter.ids.some((id) => summary.id === id || summary.id.startsWith(id))) return false;
  }
  if (filter.titles?.length) {
    const t = (summary.title || "").toLowerCase();
    if (!filter.titles.some((k) => t.includes(k.toLowerCase()))) return false;
  }
  if (filter.groups?.length) {
    const g = (summary.group || "").toLowerCase();
    const d = (summary.cwd || "").toLowerCase();
    if (!filter.groups.some((x) => g.includes(x.toLowerCase()) || d.includes(x.toLowerCase()))) return false;
  }
  if (filter.sinceMs) {
    const ts = summary.updatedAtMs || summary.createdAtMs || 0;
    if (ts < filter.sinceMs) return false;
  }
  if (filter.untilMs) {
    const ts = summary.createdAtMs || summary.updatedAtMs || 0;
    if (ts > filter.untilMs) return false;
  }
  if (filter.keyword && ir) {
    const kw = filter.keyword.toLowerCase();
    const hit =
      (summary.title || "").toLowerCase().includes(kw) ||
      ir.items.some((item) => {
        if (item.type === "message") {
          return item.content.some(
            (b) => (b.type === "text" || b.type === "thinking") && b.text.toLowerCase().includes(kw),
          );
        }
        if (item.type === "thinking") return item.text.toLowerCase().includes(kw);
        return false;
      });
    if (!hit) return false;
  }
  return true;
}

export async function migrate(opts: MigrateOptions): Promise<MigrationReport> {
  const { source, target, workdir } = opts;
  const report: MigrationReport = {
    startedAt: new Date().toISOString(),
    direction: `${source.id} -> ${target.id}`,
    total: 0,
    success: 0,
    skipped: 0,
    failed: 0,
    notes: [],
    items: [],
  };

  const backupDir = path.join(workdir, "backups");
  const logDir = path.join(workdir, "logs");
  const exportDir = path.join(workdir, "exports");
  for (const d of [backupDir, logDir, exportDir]) fs.mkdirSync(d, { recursive: true });

  const tag = timestampTag();
  if (opts.backup !== false && !opts.dryRun) {
    const paths = opts.backupPaths?.length ? opts.backupPaths : [];
    const backed = backupMany(paths, backupDir, tag);
    report.notes.push(...backed.map((p) => `备份: ${p}`));
  }

  const sessions = await source.listSessions({ loadMessages: false });
  let selected = sessions.filter((s) => matchesFilter(s, undefined, opts.filter ?? {}));
  if (opts.limit != null) selected = selected.slice(0, opts.limit);
  report.total = selected.length;
  report.notes.push(`源会话 ${sessions.length}，筛选后 ${selected.length}`);

  const pairingAgg = { toolCalls: 0, toolOutputs: 0, paired: 0, orphanCalls: 0, orphanOutputs: 0 };
  const secretAgg = { totalHits: 0, shouldBlockCloud: false, byKind: {} as Record<string, number> };

  for (const s of selected) {
    try {
      const ir = await source.readSession(s.id);
      if (opts.stripReminders !== false) {
        for (const item of ir.items) {
          if (item.type === "message" && item.role === "user") {
            item.content = item.content.map((b) =>
              b.type === "text" ? { ...b, text: stripReminders(b.text) } : b,
            ).filter((b) => b.type !== "text" || b.text.trim().length > 0);
          }
        }
      }

      // 配对统计
      const ps = pairingStats(ir);
      pairingAgg.toolCalls += ps.toolCalls;
      pairingAgg.toolOutputs += ps.toolOutputs;
      pairingAgg.paired += ps.paired;
      pairingAgg.orphanCalls += ps.orphanCalls.length;
      pairingAgg.orphanOutputs += ps.orphanOutputs.length;

      // 敏感信息扫描
      let secretNote: string | undefined;
      if (opts.scanSecrets !== false) {
        const body = ir.items
          .map((item) => {
            if (item.type === "message")
              return item.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
            if (item.type === "thinking") return item.text;
            if (item.type === "tool_output") return item.output;
            return "";
          })
          .join("\n");
        const scan = scanText(body + "\n" + ir.header.session.title);
        if (scan.hits.length) {
          secretAgg.totalHits += scan.hits.length;
          if (scan.shouldBlockCloud) secretAgg.shouldBlockCloud = true;
          for (const [k, n] of Object.entries(scan.byKind)) {
            secretAgg.byKind[k] = (secretAgg.byKind[k] || 0) + n;
          }
          secretNote = formatScanSummary(scan);
          if (opts.blockOnSecrets && scan.shouldBlockCloud && !opts.dryRun) {
            report.failed++;
            report.items.push({
              status: "failed",
              sessionId: s.id,
              title: s.title,
              message: `阻断：${secretNote}`,
            });
            continue;
          }
        }
      }

      const pairingNote =
        ps.orphanCalls.length || ps.orphanOutputs.length
          ? `配对: ${ps.paired}/${ps.toolCalls} 调用, 孤立调用 ${ps.orphanCalls.length} 孤立输出 ${ps.orphanOutputs.length}`
          : ps.toolCalls
            ? `配对: ${ps.paired}/${ps.toolCalls}`
            : undefined;

      if (opts.filter?.keyword && !matchesFilter(s, ir, opts.filter)) {
        report.skipped++;
        report.items.push({
          status: "skipped",
          sessionId: s.id,
          title: s.title,
          message: "关键词未命中正文",
        });
        continue;
      }
      if (opts.dryRun) {
        report.skipped++;
        report.items.push({
          status: "skipped",
          sessionId: s.id,
          title: s.title,
          message: ["dry-run，未写入", pairingNote, secretNote].filter(Boolean).join("；"),
          detail: {
            title: ir.header.session.title,
            items: ir.items.length,
            cwd: ir.header.session.cwd,
            pairing: ps,
            secrets: secretNote,
          },
        });
        continue;
      }
      const result: WriteResult = await target.writeSession(ir, {
        overwrite: opts.overwrite,
      });
      if (result.status === "ok") {
        report.success++;
        report.items.push({
          status: "success",
          sessionId: s.id,
          title: s.title,
          message: [`写入 ${result.messageCount ?? 0} 条`, pairingNote, secretNote]
            .filter(Boolean)
            .join("；"),
          detail: {
            ...(result.detail ?? {}),
            targetPath: result.targetPath,
            sessionId: result.sessionId,
            pairing: ps,
          },
        });
      } else if (result.status === "skipped") {
        report.skipped++;
        report.items.push({
          status: "skipped",
          sessionId: s.id,
          title: s.title,
          message: result.reason || "skipped",
        });
      } else {
        report.failed++;
        report.items.push({
          status: "failed",
          sessionId: s.id,
          title: s.title,
          message: result.error || "failed",
        });
      }
    } catch (e) {
      report.failed++;
      report.items.push({
        status: "failed",
        sessionId: s.id,
        title: s.title,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  report.pairing = pairingAgg;
  report.secrets = secretAgg;
  if (pairingAgg.toolCalls) {
    report.notes.push(
      `tool 配对: ${pairingAgg.paired}/${pairingAgg.toolCalls}，孤立调用 ${pairingAgg.orphanCalls}，孤立输出 ${pairingAgg.orphanOutputs}`,
    );
  }
  if (secretAgg.totalHits) {
    report.notes.push(
      `敏感信息: ${secretAgg.totalHits} 处${secretAgg.shouldBlockCloud ? "（含高危，建议勿上云）" : ""}`,
    );
  }

  const logPath = path.join(logDir, `migrate_${source.id}_to_${target.id}_${tag}.json`);
  fs.writeFileSync(logPath, JSON.stringify(report, null, 2), "utf-8");
  report.logPath = logPath;
  report.notes.push(`日志: ${logPath}`);
  return report;
}

export function formatReport(r: MigrationReport): string {
  const lines = [
    `迁移方向: ${r.direction}`,
    `开始时间: ${r.startedAt}`,
    `合计: ${r.total}  成功: ${r.success}  跳过: ${r.skipped}  失败: ${r.failed}`,
    "",
  ];
  for (const n of r.notes) lines.push(`[note] ${n}`);
  for (const i of r.items) {
    lines.push(`[${i.status}] ${i.title} (${i.sessionId})${i.message ? " | " + i.message : ""}`);
  }
  return lines.join("\n");
}

export { toMarkdown, toJson };
