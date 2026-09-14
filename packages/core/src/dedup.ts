/**
 * 去重：identity_key = 源客户端 + sourceSessionId + 内容哈希
 * 扫描期去重并识别分叉会话
 */

import { createHash } from "node:crypto";
import type { HarborIR } from "./ir.js";
import { extractText } from "./ir.js";

export interface DedupKey {
  identityKey: string;
  contentHash: string;
  sourceClient: string;
  sourceSessionId: string;
}

export interface DedupEntry extends DedupKey {
  title: string;
  createdAtMs?: number;
  messageCount: number;
}

export interface DedupResult {
  /** identityKey → 重复列表（保留最早） */
  duplicates: Map<string, DedupEntry[]>;
  unique: DedupEntry[];
  /** 可能是同一会话的分叉（内容相近但 id 不同） */
  possibleForks: Array<{ a: DedupEntry; b: DedupEntry; similarity: number }>;
}

export function contentHashOf(ir: HarborIR): string {
  const parts: string[] = [];
  for (const item of ir.items) {
    if (item.type === "message") {
      parts.push(item.role + ":" + extractText(item.content));
    } else if (item.type === "thinking") {
      parts.push("think:" + item.text);
    }
  }
  const h = createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
  return h.slice(0, 32);
}

export function identityKeyOf(sourceClient: string, sourceSessionId: string, contentHash: string): string {
  return `${sourceClient}::${sourceSessionId}::${contentHash}`;
}

export function entryFromIR(ir: HarborIR): DedupEntry {
  const s = ir.header.session;
  const contentHash = contentHashOf(ir);
  return {
    identityKey: identityKeyOf(s.sourceClient, s.sourceSessionId || s.id, contentHash),
    contentHash,
    sourceClient: s.sourceClient,
    sourceSessionId: s.sourceSessionId || s.id,
    title: s.title,
    createdAtMs: s.createdAt ? Date.parse(s.createdAt) : undefined,
    messageCount: ir.items.filter((i) => i.type === "message").length,
  };
}

/** 简单 Jaccard 相似度（字符 trigram） */
function trigramSim(a: string, b: string): number {
  if (!a || !b) return 0;
  const ta = new Set<string>();
  const tb = new Set<string>();
  for (let i = 0; i < a.length - 2; i++) ta.add(a.slice(i, i + 3));
  for (let i = 0; i < b.length - 2; i++) tb.add(b.slice(i, i + 3));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

export function analyzeDedup(
  entries: Array<DedupEntry & { textPreview?: string }>,
  opts: { forkThreshold?: number } = {},
): DedupResult {
  const byKey = new Map<string, DedupEntry[]>();
  for (const e of entries) {
    const list = byKey.get(e.identityKey) ?? [];
    list.push(e);
    byKey.set(e.identityKey, list);
  }
  const duplicates = new Map<string, DedupEntry[]>();
  const unique: DedupEntry[] = [];
  for (const [k, list] of byKey) {
    list.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
    unique.push(list[0]!);
    if (list.length > 1) duplicates.set(k, list.slice(1));
  }

  // 分叉检测：不同 id、标题含「分叉」或内容相似
  const threshold = opts.forkThreshold ?? 0.72;
  const possibleForks: DedupResult["possibleForks"] = [];
  const labeled = entries.filter((e) => (e.title || "").includes("分叉"));
  for (const fork of labeled) {
    for (const other of entries) {
      if (other.sourceSessionId === fork.sourceSessionId) continue;
      if (fork.sourceClient !== other.sourceClient) continue;
      const sim = trigramSim(fork.textPreview ?? "", other.textPreview ?? "");
      // 无 preview 时用标题前缀
      const titleSim = trigramSim(fork.title.replace(/\s*\(分叉\)\s*$/, ""), other.title);
      const score = Math.max(sim, titleSim * 0.9);
      if (score >= threshold) {
        possibleForks.push({ a: other, b: fork, similarity: score });
      }
    }
  }

  return { duplicates, unique, possibleForks };
}

export function formatDedupSummary(r: DedupResult): string {
  let dupCount = 0;
  for (const list of r.duplicates.values()) dupCount += list.length;
  return `去重：唯一 ${r.unique.length}，重复 ${dupCount}，疑似分叉 ${r.possibleForks.length}`;
}
