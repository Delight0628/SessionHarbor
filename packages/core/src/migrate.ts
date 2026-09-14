/** 迁移引擎：筛选、备份、通过适配器读→IR→写 */

import path from "node:path";
import fs from "node:fs";
import type { Adapter, WriteResult } from "./adapter.js";
import type { HarborIR } from "./ir.js";
import { backupMany } from "./backup.js";
import { timestampTag } from "./time.js";
import { toMarkdown, toJson } from "./export.js";
import { stripReminders } from "./text.js";

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
          message: "dry-run，未写入",
          detail: {
            title: ir.header.session.title,
            items: ir.items.length,
            cwd: ir.header.session.cwd,
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
          message: `写入 ${result.messageCount ?? 0} 条`,
          detail: result.detail ?? { targetPath: result.targetPath, sessionId: result.sessionId },
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
