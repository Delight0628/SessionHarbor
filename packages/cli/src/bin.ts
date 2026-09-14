#!/usr/bin/env node
/**
 * harbor CLI — SessionHarbor 命令行入口
 * 用法: harbor <info|list|scan|search|migrate|export|backup> [options]
 */

import fs from "node:fs";
import path from "node:path";
import {
  SessionIndex,
  SessionWatcher,
  defaultIndexPath,
  discoverAlink,
  discoverClaudeCode,
  discoverWorkbuddy,
  formatReport,
  migrate,
  backupMany,
  toMarkdown,
  toJson,
  toHtml,
  watchDirsFor,
  scanText,
  redactText,
  formatScanSummary,
  entryFromIR,
  analyzeDedup,
  formatDedupSummary,
  type ClientPathsLike,
  type FilterSpec,
} from "@sessionharbor/core";
import { createAlinkAdapter } from "@sessionharbor/adapter-alink";
import { createClaudeCodeAdapter } from "@sessionharbor/adapter-claude-code";
import { createWorkbuddyAdapter } from "@sessionharbor/adapter-workbuddy";
import { createCodexAdapter, discoverCodex } from "@sessionharbor/adapter-codex";
import {
  createChatGptExportAdapter,
  discoverChatGptExport,
} from "@sessionharbor/adapter-chatgpt-export";

const CLIENTS = ["alink", "claude-code", "workbuddy", "codex", "chatgpt-export"] as const;
type ClientId = (typeof CLIENTS)[number];

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let key: string;
      let val: string | boolean = true;
      if (eq > 0) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          val = next;
          i++;
        }
      }
      // multi-value flags
      const multi = ["title", "group", "id"];
      if (multi.includes(key)) {
        const arr = (args[key] as string[] | undefined) ?? [];
        arr.push(String(val));
        args[key] = arr;
      } else {
        args[key] = val;
      }
    } else {
      positional.push(a);
    }
  }
  return { args, positional };
}

function getClientPaths(
  id: ClientId,
  args: Record<string, string | boolean | string[]>,
): ClientPathsLike {
  switch (id) {
    case "alink":
      return discoverAlink(args["alink-db"] as string | undefined);
    case "claude-code":
      return discoverClaudeCode(args["claude-projects"] as string | undefined);
    case "workbuddy":
      return discoverWorkbuddy(args["wb-db"] as string | undefined);
    case "codex":
      return discoverCodex(args["codex-root"] as string | undefined);
    case "chatgpt-export":
      return discoverChatGptExport(args["chatgpt-export"] as string | undefined);
  }
}

function getAdapter(
  id: ClientId,
  args: Record<string, string | boolean | string[]>,
) {
  const paths = getClientPaths(id, args);
  if (id === "alink") return createAlinkAdapter(paths as never);
  if (id === "claude-code") return createClaudeCodeAdapter(paths);
  if (id === "codex") return createCodexAdapter(paths as never);
  if (id === "chatgpt-export") return createChatGptExportAdapter(paths as never);
  return createWorkbuddyAdapter(paths);
}

function workdir(args: Record<string, string | boolean | string[]>): string {
  return path.resolve(String(args.workdir ?? process.cwd()));
}

function filterFrom(args: Record<string, string | boolean | string[]>): FilterSpec {
  const titles = (args.title as string[] | undefined) ?? [];
  const ids = (args.id as string[] | undefined) ?? [];
  const groups = (args.group as string[] | undefined) ?? [];
  return {
    titles: titles.length ? titles : undefined,
    ids: ids.length ? ids : undefined,
    groups: groups.length ? groups : undefined,
    keyword: args.keyword ? String(args.keyword) : undefined,
    sinceMs: args.since ? Date.parse(String(args.since)) : undefined,
    untilMs: args.until ? Date.parse(String(args.until)) : undefined,
  };
}

function help(): void {
  console.log(`SessionHarbor harbor CLI v0.1

用法:
  harbor info
  harbor list --client alink|claude-code|workbuddy|codex|chatgpt-export [--json] [--title 关键字]
  harbor scan [--client ...]          构建/刷新本地 FTS 索引
  harbor search <关键词> [--limit N]   统一全文检索
  harbor migrate --from A --to B [--title ...] [--id ...] [--dry-run] [--overwrite] [--yes]
  harbor export --client A --id <sessionId> --format md|json|html [--out 文件]
  harbor backup [--client A]
  harbor watch [--client A] [--debounce ms]   增量监听并刷新索引
  harbor secrets --client A [--id ...] [--limit N]   敏感信息扫描
  harbor dedup [--client A] [--limit N]               去重与分叉检测

全局选项:
  --workdir DIR       备份/日志/索引目录（默认 cwd）
  --alink-db PATH     指定领慧主库
  --claude-projects   指定 ~/.claude/projects
  --wb-db PATH        指定 workbuddy.db
  --codex-root PATH   指定 ~/.codex
  --chatgpt-export    conversations.json 路径（只读导入）
`);
}

async function cmdInfo(args: Record<string, string | boolean | string[]>): Promise<number> {
  for (const id of CLIENTS) {
    try {
      const p = getClientPaths(id, args);
      console.log(`=== ${id} ===`);
      console.log(`  dataRoot: ${p.dataRoot}`);
      if (p.primaryDb) console.log(`  primaryDb: ${p.primaryDb}`);
      if (p.jsonlDir) console.log(`  jsonlDir: ${p.jsonlDir}`);
      if (p.projectsRoot) console.log(`  projectsRoot: ${p.projectsRoot}`);
      for (const e of p.extraDbs) console.log(`  extra: ${e}`);
    } catch (e) {
      console.log(`=== ${id} ===`);
      console.log(`  [未发现] ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\nworkdir: ${workdir(args)}`);
  return 0;
}

async function cmdList(args: Record<string, string | boolean | string[]>): Promise<number> {
  const client = String(args.client ?? "all");
  const clients: ClientId[] =
    client === "all" ? [...CLIENTS] : [client as ClientId];
  const filt = filterFrom(args);
  const all: Array<Record<string, unknown>> = [];
  for (const id of clients) {
    let adapter;
    try {
      adapter = getAdapter(id, args);
    } catch (e) {
      console.error(`[${id}] 发现失败: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const sessions = await adapter.listSessions();
    for (const s of sessions) {
      if (filt.ids?.length && !filt.ids.some((i) => s.id.startsWith(i))) continue;
      if (filt.titles?.length && !filt.titles.some((t) => (s.title || "").toLowerCase().includes(t.toLowerCase())))
        continue;
      if (filt.groups?.length && !filt.groups.some((g) => (s.group || "").toLowerCase().includes(g.toLowerCase())))
        continue;
      all.push({ client: id, ...s });
    }
  }
  if (args.json) {
    console.log(JSON.stringify(all, null, 2));
    return 0;
  }
  console.log(`共 ${all.length} 个会话\n`);
  for (const [i, s] of all.entries()) {
    const created = s.createdAtMs ? new Date(Number(s.createdAtMs)).toISOString().slice(0, 19) : "-";
    console.log(
      `${String(i + 1).padStart(3)}. [${s.client}] ${String(s.title).slice(0, 50)}`,
    );
    console.log(
      `     id=${String(s.id).slice(0, 36)}  msgs=${s.messageCount ?? "-"}  group=${s.group ?? "-"}  ${created}`,
    );
  }
  return 0;
}

async function cmdScan(args: Record<string, string | boolean | string[]>): Promise<number> {
  const wd = workdir(args);
  const indexPath = (args.index as string) || defaultIndexPath(wd);
  const index = new SessionIndex(indexPath);
  let n = 0;
  const t0 = Date.now();
  const client = String(args.client ?? "all");
  const allClients: ClientId[] = client === "all" ? [...CLIENTS] : [client as ClientId];
  // 探测可用客户端
  const usable: ClientId[] = [];
  for (const id of allClients) {
    try {
      getAdapter(id, args);
      usable.push(id);
    } catch (e) {
      console.error(`[${id}] 不可用: ${e instanceof Error ? e.message : e}`);
    }
  }
  index.beginBulkRebuild();
  for (const id of usable) {
    const adapter = getAdapter(id, args);
    const sessions = await adapter.listSessions();
    console.log(`[${id}] ${sessions.length} 个会话，索引中…`);
    let batch = 0;
    for (const s of sessions) {
      try {
        const ir = await adapter.readSession(s.id);
        index.upsertIR(ir);
        n++;
        batch++;
        if (batch >= 200) {
          index.commit();
          index.begin();
          batch = 0;
          console.log(`  … ${n}`);
        }
      } catch (e) {
        console.error(`  跳过 ${s.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  index.endBulkRebuild();
  const ms = Date.now() - t0;
  console.log(`\n索引完成: ${n} 个会话 / ${ms}ms → ${indexPath}`);
  console.log(`索引库总量: ${index.count()}`);
  index.close();
  return 0;
}

async function cmdSearch(args: Record<string, string | boolean | string[]>, positional: string[]): Promise<number> {
  const q = positional[0] || String(args.q ?? "");
  if (!q) {
    console.error("用法: harbor search <关键词>");
    return 2;
  }
  const wd = workdir(args);
  const indexPath = (args.index as string) || defaultIndexPath(wd);
  if (!fs.existsSync(indexPath)) {
    console.error(`索引不存在: ${indexPath}\n请先运行: harbor scan`);
    return 1;
  }
  const index = new SessionIndex(indexPath);
  const t0 = Date.now();
  const hits = index.search(q, {
    limit: Number(args.limit ?? 20),
    source: args.client ? String(args.client) : undefined,
  });
  const ms = Date.now() - t0;
  console.log(`「${q}」命中 ${hits.length} 条（${ms}ms）\n`);
  for (const h of hits) {
    console.log(`[${h.sourceClient}] ${h.title}`);
    console.log(`  id=${h.sessionId}`);
    if (h.snippet) console.log(`  ${h.snippet}`);
    console.log();
  }
  index.close();
  return 0;
}

async function cmdMigrate(args: Record<string, string | boolean | string[]>, positional: string[]): Promise<number> {
  // support: harbor migrate --from X --to Y
  // also:   harbor migrate X Y
  const from = (args.from as string) || positional[0];
  const to = (args.to as string) || positional[1];
  if (!from || !to) {
    console.error("用法: harbor migrate --from <client> --to <client>");
    console.error("clients: alink | claude-code | workbuddy");
    return 2;
  }
  if (from === to) {
    console.error("源与目标不能相同");
    return 2;
  }
  const source = getAdapter(from as ClientId, args);
  const target = getAdapter(to as ClientId, args);
  const wd = workdir(args);
  const backupPaths: string[] = [];
  for (const id of [from, to] as ClientId[]) {
    try {
      const p = getClientPaths(id, args);
      if (p.primaryDb) backupPaths.push(p.primaryDb);
      backupPaths.push(...p.extraDbs);
    } catch {
      /* ignore */
    }
  }

  if (!args["no-confirm"] && !args.yes && !args["dry-run"]) {
    // non-interactive default: require --yes
    if (!args.yes) {
      console.error("写入迁移需要 --yes 确认（或加 --dry-run 仅预览）");
      return 2;
    }
  }

  const report = await migrate({
    source,
    target,
    workdir: wd,
    filter: filterFrom(args),
    backup: !args["no-backup"],
    dryRun: Boolean(args["dry-run"]),
    overwrite: Boolean(args.overwrite),
    limit: args.limit ? Number(args.limit) : undefined,
    backupPaths,
  });
  console.log(formatReport(report));
  return report.failed === 0 ? 0 : 1;
}

async function cmdExport(args: Record<string, string | boolean | string[]>, positional: string[]): Promise<number> {
  const client = String(args.client ?? "");
  const id = String(args.id ?? positional[0] ?? "");
  const format = String(args.format ?? "md");
  if (!client || !id) {
    console.error("用法: harbor export --client <client> --id <sessionId> --format md|json|html");
    return 2;
  }
  const adapter = getAdapter(client as ClientId, args);
  // support id prefix
  let sid = id;
  const sessions = await adapter.listSessions();
  const hit = sessions.find((s) => s.id === id || s.id.startsWith(id));
  if (hit) sid = hit.id;
  const ir = await adapter.readSession(sid);
  let out: string;
  if (format === "json") out = toJson(ir);
  else if (format === "html") out = toHtml(ir);
  else out = toMarkdown(ir);
  const outPath = args.out
    ? path.resolve(String(args.out))
    : path.join(workdir(args), "exports", `${sid}.${format === "md" ? "md" : format}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out, "utf-8");
  console.log(`已导出: ${outPath}`);
  return 0;
}

async function cmdBackup(args: Record<string, string | boolean | string[]>): Promise<number> {
  const wd = workdir(args);
  const dest = path.join(wd, "backups");
  const client = String(args.client ?? "all");
  const clients: ClientId[] = client === "all" ? [...CLIENTS] : [client as ClientId];
  const files: string[] = [];
  for (const id of clients) {
    try {
      const p = getClientPaths(id, args);
      if (p.primaryDb) files.push(p.primaryDb);
      files.push(...p.extraDbs);
    } catch (e) {
      console.error(`[${id}] ${e instanceof Error ? e.message : e}`);
    }
  }
  const out = backupMany(files, dest);
  for (const p of out) console.log(`已备份: ${p}`);
  console.log(`\n共 ${out.length} 个文件 → ${dest}`);
  return out.length ? 0 : 1;
}

async function cmdWatch(args: Record<string, string | boolean | string[]>): Promise<number> {
  const wd = workdir(args);
  const indexPath = (args.index as string) || defaultIndexPath(wd);
  const index = new SessionIndex(indexPath);
  const client = String(args.client ?? "all");
  const clients: ClientId[] =
    client === "all"
      ? CLIENTS.filter((c) => c !== "chatgpt-export")
      : [client as ClientId];

  const watcher = new SessionWatcher({
    debounceMs: Number(args.debounce ?? 500),
    onEvent: async (e) => {
      console.log(`[watch] ${e.kind} ${e.clientId} ${path.basename(e.file)}`);
      try {
        const adapter = getAdapter(e.clientId as ClientId, args);
        const id = path.basename(e.file).replace(/\.(jsonl|sqlite|db)$/i, "");
        try {
          const ir = await adapter.readSession(id);
          index.upsertIR(ir);
          console.log(`  索引已更新: ${id}`);
        } catch {
          // 文件可能刚创建尚无完整会话；整源重扫该客户端元数据太重，仅跳过
          console.log(`  跳过（未能读出完整会话）: ${id}`);
        }
      } catch (err) {
        console.error(`  处理失败: ${err instanceof Error ? err.message : err}`);
      }
    },
    onError: (e) => console.error(`[watch] error: ${e.message}`),
  });

  for (const id of clients) {
    try {
      const p = getClientPaths(id, args) as ClientPathsLike & {
        sessionsRoot?: string;
        jsonlDir?: string;
        projectsRoot?: string;
      };
      for (const dir of watchDirsFor(p)) {
        watcher.watch({ id, dir });
        console.log(`监听 ${id}: ${dir}`);
      }
    } catch (e) {
      console.error(`[${id}] 不监听: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log("\n增量 watcher 运行中，Ctrl+C 退出…");
  const stop = () => {
    watcher.close();
    index.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // 保持进程
  await new Promise(() => {});
  return 0;
}

async function cmdSecrets(args: Record<string, string | boolean | string[]>): Promise<number> {
  const client = String(args.client ?? "");
  if (!client) {
    console.error("用法: harbor secrets --client <client> [--id ...] [--limit N] [--redact]");
    return 2;
  }
  const adapter = getAdapter(client as ClientId, args);
  let sessions = await adapter.listSessions();
  const ids = (args.id as string[] | undefined) ?? [];
  if (ids.length) sessions = sessions.filter((s) => ids.some((i) => s.id.startsWith(i)));
  if (args.limit) sessions = sessions.slice(0, Number(args.limit));
  let total = 0;
  let blocked = 0;
  for (const s of sessions) {
    const ir = await adapter.readSession(s.id);
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
    if (!scan.hits.length) continue;
    total += scan.hits.length;
    if (scan.shouldBlockCloud) blocked++;
    console.log(`[${s.id.slice(0, 12)}] ${s.title}`);
    console.log(`  ${formatScanSummary(scan)}`);
    for (const h of scan.hits.slice(0, 5)) {
      console.log(`  · ${h.kind} (${h.confidence}) ${h.preview}`);
    }
    if (args.redact) {
      const red = redactText(body, scan.hits);
      console.log(`  (已展示脱敏预览 ${red.length} 字符，未写回源)`);
    }
  }
  console.log(`\n合计命中 ${total} 处，涉及高危会话 ${blocked} 个`);
  return 0;
}

async function cmdDedup(args: Record<string, string | boolean | string[]>): Promise<number> {
  const client = String(args.client ?? "all");
  const clients: ClientId[] =
    client === "all" ? CLIENTS.filter((c) => c !== "chatgpt-export") : [client as ClientId];
  const entries = [];
  for (const id of clients) {
    try {
      const adapter = getAdapter(id, args);
      const sessions = await adapter.listSessions();
      let n = 0;
      for (const s of sessions) {
        if (args.limit && n >= Number(args.limit)) break;
        try {
          const ir = await adapter.readSession(s.id);
          const e = entryFromIR(ir);
          const preview = ir.items
            .filter((i) => i.type === "message")
            .slice(0, 3)
            .map((i) =>
              i.type === "message"
                ? i.content.map((b) => (b.type === "text" ? b.text : "")).join(" ")
                : "",
            )
            .join(" ");
          entries.push({ ...e, textPreview: preview.slice(0, 500) });
          n++;
        } catch {
          /* skip */
        }
      }
    } catch (e) {
      console.error(`[${id}] ${e instanceof Error ? e.message : e}`);
    }
  }
  const r = analyzeDedup(entries);
  console.log(formatDedupSummary(r));
  for (const [k, dups] of r.duplicates) {
    console.log(`重复键 ${k.slice(0, 40)}… ×${dups.length + 1}`);
  }
  for (const f of r.possibleForks) {
    console.log(
      `疑似分叉: 「${f.b.title}」 ↔ 「${f.a.title}」 sim=${f.similarity.toFixed(2)}`,
    );
  }
  return 0;
}

async function main(): Promise<void> {
  const { args, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] || String(args._ ?? "") || "help";
  try {
    switch (cmd) {
      case "info":
        process.exit(await cmdInfo(args));
        break;
      case "list":
        process.exit(await cmdList(args));
        break;
      case "scan":
        process.exit(await cmdScan(args));
        break;
      case "search":
        process.exit(await cmdSearch(args, positional.slice(1)));
        break;
      case "migrate":
        process.exit(await cmdMigrate(args, positional.slice(1)));
        break;
      case "export":
        process.exit(await cmdExport(args, positional.slice(1)));
        break;
      case "backup":
        process.exit(await cmdBackup(args));
        break;
      case "watch":
        process.exit(await cmdWatch(args));
        break;
      case "secrets":
        process.exit(await cmdSecrets(args));
        break;
      case "dedup":
        process.exit(await cmdDedup(args));
        break;
      case "help":
      case "--help":
      case "-h":
        help();
        process.exit(0);
        break;
      default:
        console.error(`未知命令: ${cmd}\n`);
        help();
        process.exit(2);
    }
  } catch (e) {
    console.error(`错误: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

main();
