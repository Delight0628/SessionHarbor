/** 本地 FTS 索引：SQLite FTS5（trigram 中文友好） */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HarborIR } from "./ir.js";
import { extractText } from "./ir.js";

export interface IndexEntry {
  sessionId: string;
  sourceClient: string;
  title: string;
  cwd?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  body: string;
}

const BODY_LIMIT = 80_000;

export class SessionIndex {
  private db: DatabaseSync;
  private inTx = false;
  private bulk = false;
  private stmts: {
    upsertSession?: ReturnType<DatabaseSync["prepare"]>;
    delFts?: ReturnType<DatabaseSync["prepare"]>;
    insFts?: ReturnType<DatabaseSync["prepare"]>;
  } = {};

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -128000;
      PRAGMA mmap_size = 268435456;
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        source_client TEXT NOT NULL,
        title TEXT,
        cwd TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        session_id UNINDEXED,
        title,
        body,
        tokenize = 'trigram'
      );
    `);
  }

  begin(): void {
    if (!this.inTx) {
      this.db.exec(`BEGIN`);
      this.inTx = true;
    }
  }

  commit(): void {
    if (this.inTx) {
      this.db.exec(`COMMIT`);
      this.inTx = false;
    }
  }

  rollback(): void {
    if (this.inTx) {
      try {
        this.db.exec(`ROLLBACK`);
      } catch {
        /* ignore */
      }
      this.inTx = false;
    }
  }

  /** 全量重建：清空后只插入，不做 per-row delete */
  beginBulkRebuild(): void {
    this.begin();
    this.db.exec(`DELETE FROM sessions; DELETE FROM sessions_fts;`);
    this.bulk = true;
  }

  endBulkRebuild(): void {
    this.bulk = false;
    this.commit();
  }

  private ensureStmts() {
    if (!this.stmts.upsertSession) {
      this.stmts.upsertSession = this.db.prepare(
        `INSERT OR REPLACE INTO sessions
         (session_id, source_client, title, cwd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      this.stmts.delFts = this.db.prepare(`DELETE FROM sessions_fts WHERE session_id = ?`);
      this.stmts.insFts = this.db.prepare(
        `INSERT INTO sessions_fts (session_id, title, body) VALUES (?, ?, ?)`,
      );
    }
  }

  upsert(entry: IndexEntry): void {
    this.ensureStmts();
    const body = entry.body.length > BODY_LIMIT ? entry.body.slice(0, BODY_LIMIT) : entry.body;
    this.stmts.upsertSession!.run(
      entry.sessionId,
      entry.sourceClient,
      entry.title,
      entry.cwd ?? null,
      entry.createdAtMs ?? null,
      entry.updatedAtMs ?? null,
    );
    if (!this.bulk) {
      this.stmts.delFts!.run(entry.sessionId);
    }
    this.stmts.insFts!.run(entry.sessionId, entry.title, body);
  }

  upsertIR(ir: HarborIR): void {
    const s = ir.header.session;
    const parts: string[] = [];
    for (const item of ir.items) {
      if (item.type === "message") parts.push(extractText(item.content));
      else if (item.type === "thinking") parts.push(item.text);
      else if (item.type === "tool_output") parts.push(item.output);
    }
    this.upsert({
      sessionId: s.id,
      sourceClient: s.sourceClient,
      title: s.title,
      cwd: s.cwd,
      createdAtMs: s.createdAt ? Date.parse(s.createdAt) : undefined,
      updatedAtMs: s.updatedAt ? Date.parse(s.updatedAt) : undefined,
      body: parts.join("\n"),
    });
  }

  search(
    query: string,
    opts: { limit?: number; source?: string } = {},
  ): Array<{ sessionId: string; title: string; sourceClient: string; snippet?: string; rank?: number }> {
    const limit = opts.limit ?? 20;
    const q = query.trim();
    if (!q) return [];
    if ([...q].length >= 3) {
      const escaped = q.replace(/"/g, '""');
      // detail=off 时 snippet 不可用，改用子串截取
      const sql = `
        SELECT s.session_id, s.title, s.source_client, bm25(sessions_fts) AS rank
        FROM sessions_fts f
        JOIN sessions s ON s.session_id = f.session_id
        WHERE sessions_fts MATCH ?
        ${opts.source ? "AND s.source_client = ?" : ""}
        ORDER BY rank
        LIMIT ?
      `;
      const params: Array<string | number> = [`"${escaped}"`];
      if (opts.source) params.push(opts.source);
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as Array<{
        session_id: string;
        title: string;
        source_client: string;
        rank: number;
      }>;
      return rows.map((r) => ({
        sessionId: r.session_id,
        title: r.title,
        sourceClient: r.source_client,
        rank: r.rank,
      }));
    }
    const like = `%${q}%`;
    const rows = this.db
      .prepare(
        `SELECT session_id, title, source_client FROM sessions
         WHERE title LIKE ? ${opts.source ? "AND source_client = ?" : ""}
         LIMIT ?`,
      )
      .all(...(opts.source ? [like, opts.source, limit] : [like, limit])) as Array<{
      session_id: string;
      title: string;
      source_client: string;
    }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      title: r.title,
      sourceClient: r.source_client,
    }));
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
    return row.n;
  }

  close(): void {
    this.commit();
    this.db.close();
  }
}

export function defaultIndexPath(workdir: string): string {
  return path.join(workdir, ".sessionharbor", "index.db");
}
