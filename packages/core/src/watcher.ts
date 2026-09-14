/**
 * 增量 watcher：监听各客户端数据目录，变更时回调（CLI/GUI 可挂索引刷新）
 * 使用 fs.watch + 节流，避免 chokidar 原生依赖。
 */

import fs from "node:fs";
import path from "node:path";

export interface WatchTarget {
  id: string;
  dir: string;
  /** 匹配文件名的正则；默认 jsonl/sqlite/db */
  pattern?: RegExp;
}

export interface WatchEvent {
  clientId: string;
  file: string;
  kind: "add" | "change" | "unlink";
  ts: number;
}

export interface WatcherOptions {
  debounceMs?: number;
  onEvent: (e: WatchEvent) => void;
  onError?: (e: Error) => void;
}

const DEFAULT_RE = /\.(jsonl|sqlite|db)$/i;

export class SessionWatcher {
  private watchers: fs.FSWatcher[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, WatchEvent>();
  private opts: Required<Pick<WatcherOptions, "debounceMs">> & WatcherOptions;
  private closed = false;

  constructor(opts: WatcherOptions) {
    this.opts = { debounceMs: 400, ...opts };
  }

  watch(target: WatchTarget): void {
    if (!fs.existsSync(target.dir)) return;
    const re = target.pattern ?? DEFAULT_RE;
    try {
      const w = fs.watch(target.dir, { recursive: true }, (_type, filename) => {
        if (this.closed || !filename) return;
        const name = String(filename).replace(/\\/g, "/");
        if (!re.test(name)) return;
        const full = path.join(target.dir, String(filename));
        const kind: WatchEvent["kind"] = fs.existsSync(full)
          ? this.seen.has(full)
            ? "change"
            : "add"
          : "unlink";
        if (kind !== "unlink") this.seen.add(full);
        else this.seen.delete(full);
        this.enqueue({ clientId: target.id, file: full, kind, ts: Date.now() });
      });
      w.on("error", (e) => this.opts.onError?.(e as Error));
      this.watchers.push(w);
    } catch (e) {
      this.opts.onError?.(e as Error);
    }
  }

  private seen = new Set<string>();

  private enqueue(e: WatchEvent): void {
    // 同一文件节流合并
    const key = `${e.clientId}:${e.file}`;
    this.pending.set(key, e);
    const old = this.timers.get(key);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      const ev = this.pending.get(key);
      this.pending.delete(key);
      this.timers.delete(key);
      if (ev && !this.closed) this.opts.onEvent(ev);
    }, this.opts.debounceMs);
    this.timers.set(key, t);
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers = [];
  }
}

/** 从 ClientPathsLike 推导可监听目录 */
export function watchDirsFor(paths: {
  jsonlDir?: string;
  projectsRoot?: string;
  sessionsRoot?: string;
  dataRoot: string;
}): string[] {
  const dirs = [paths.jsonlDir, paths.projectsRoot, paths.sessionsRoot].filter(Boolean) as string[];
  if (!dirs.length) dirs.push(paths.dataRoot);
  return dirs;
}
