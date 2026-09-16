/**
 * 分叉（fork）与压缩（compaction）拓扑
 *
 * 各客户端差异（实测）：
 * - Claude Code / 领慧信封：uuid 链；分叉=同一 parentUuid 多个子
 * - WorkBuddy：message.parentId，可有多个兄弟（真分叉）
 * - MiMo：session.parent_id + message.data.parentID（fork 出新会话）
 * - 压缩：部分客户端用 summary 替换历史；IR 用 checkpoint 标记边界
 *
 * 策略：迁移写入线性「主链」保证可 resume；分叉点拆成独立目标会话，
 * 避免把兄弟分支交错写进同一 transcript 导致回滚/fork 时丢上下文。
 */

import type { HarborIR, HarborItem } from "./ir.js";
import { createHeader } from "./ir.js";

export interface ForkPoint {
  parentId: string;
  childIds: string[];
}

export interface Lineage {
  /** 主链 itemId，从根到叶 */
  path: string[];
  /** 主链 items（按 path 顺序） */
  items: HarborItem[];
}

/** 建立 itemId → item 与 children 索引 */
export function buildGraph(items: HarborItem[]): {
  byId: Map<string, HarborItem>;
  children: Map<string, HarborItem[]>;
  roots: HarborItem[];
} {
  const byId = new Map<string, HarborItem>();
  for (const it of items) byId.set(it.itemId, it);
  const children = new Map<string, HarborItem[]>();
  const roots: HarborItem[] = [];
  for (const it of items) {
    const p = "parentItemId" in it ? it.parentItemId : undefined;
    if (!p || !byId.has(p)) {
      roots.push(it);
    } else {
      const list = children.get(p) ?? [];
      list.push(it);
      children.set(p, list);
    }
  }
  return { byId, children, roots };
}

/** 是否像「正文消息」节点（参与主链/fork） */
function isBranchable(it: HarborItem): boolean {
  return it.type === "message" || it.type === "thinking";
}

/**
 * 选主链：优先深度优先最后一条 user/assistant 消息所在路径；
 * 若无 parent 链则按数组顺序线性串。
 */
export function pickMainLineage(items: HarborItem[]): Lineage {
  if (!items.length) return { path: [], items: [] };

  // 无 parent 信息：按出现顺序当线性主链
  const hasParents = items.some(
    (i) => "parentItemId" in i && i.parentItemId && items.some((x) => x.itemId === i.parentItemId),
  );
  if (!hasParents) {
    return { path: items.map((i) => i.itemId), items: [...items] };
  }

  const { byId, children, roots } = buildGraph(items);
  // 选最深叶子（分叉时取最长主链，保证上下文最完整）
  let bestLeaf: string | null = null;
  let bestDepth = -1;
  const walk = (id: string, depth: number) => {
    const kids = (children.get(id) ?? []).filter(isBranchable);
    if (!kids.length) {
      if (depth > bestDepth) {
        bestDepth = depth;
        bestLeaf = id;
      }
      return;
    }
    for (const k of kids) walk(k.itemId, depth + 1);
  };
  for (const r of roots) walk(r.itemId, 0);
  if (!bestLeaf) return { path: items.map((i) => i.itemId), items: [...items] };
  const leafId = bestLeaf as string;
  const path: string[] = [];
  let cur: string | undefined = leafId;
  const guard = new Set<string>();
  while (cur && byId.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    path.unshift(cur);
    const it: HarborItem | undefined = byId.get(cur);
    if (!it) break;
    cur = "parentItemId" in it ? it.parentItemId : undefined;
  }
  const mainItems = path.map((id) => byId.get(id)!);
  // 仅附加「非分叉子树」的孤立项（如挂在树外的 tool_output）
  const inPath = new Set(path);
  const forkRoots = new Set<string>();
  for (const [pid, kids] of children) {
    const branchable = kids.filter(isBranchable);
    if (branchable.length > 1) {
      for (const k of branchable) if (!inPath.has(k.itemId)) forkRoots.add(k.itemId);
    }
  }
  const inForkSubtree = new Set<string>();
  const mark = (id: string) => {
    if (inForkSubtree.has(id)) return;
    inForkSubtree.add(id);
    for (const k of children.get(id) ?? []) mark(k.itemId);
  };
  for (const r of forkRoots) mark(r);
  const extras = items.filter(
    (i) => !inPath.has(i.itemId) && !inForkSubtree.has(i.itemId),
  );
  return { path, items: [...mainItems, ...extras] };
}

/** 主链之外的分叉：每个分叉点的一条子树 */
export function findForks(items: HarborItem[]): ForkPoint[] {
  const { children } = buildGraph(items);
  const out: ForkPoint[] = [];
  for (const [pid, kids] of children) {
    const branchable = kids.filter(isBranchable);
    if (branchable.length > 1) {
      out.push({ parentId: pid, childIds: branchable.map((k) => k.itemId) });
    }
  }
  return out;
}

/** 从 fork 子节点收集整条子树 items（含非 message） */
function collectSubtree(
  rootId: string,
  items: HarborItem[],
  stopAt?: Set<string>,
): HarborItem[] {
  const { byId, children } = buildGraph(items);
  const out: HarborItem[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id) || stopAt?.has(id)) return;
    seen.add(id);
    const it = byId.get(id);
    if (it) out.push(it);
    for (const k of children.get(id) ?? []) walk(k.itemId);
  };
  walk(rootId);
  return out;
}

/** 主链 ancestors（不含 fork 点本身可选） */
function ancestorsOf(itemId: string, items: HarborItem[]): HarborItem[] {
  const { byId } = buildGraph(items);
  const path: string[] = [];
  let cur: string | undefined = itemId;
  const guard = new Set<string>();
  while (cur && byId.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    path.unshift(cur);
    const it: HarborItem | undefined = byId.get(cur);
    if (!it) break;
    cur = "parentItemId" in it ? it.parentItemId : undefined;
  }
  path.pop(); // 去掉 itemId 自身
  return path.map((id) => byId.get(id)!);
}

export interface ForkSessionPlan {
  /** 分叉会话标题后缀 */
  titleSuffix: string;
  /** 从哪个源消息分出（用于 MiMo parent_id 关联说明） */
  forkFromItemId: string;
  /** 完整 IR：祖先 + 该分支 */
  ir: HarborIR;
}

/**
 * 为每个分叉点生成可独立写入的会话（主链 + 一条分支）
 * 第 0 个子树沿用主链时跳过。
 */
export function planForkSessions(ir: HarborIR): {
  main: HarborIR;
  forks: ForkSessionPlan[];
} {
  const lineage = pickMainLineage(ir.items);
  const main: HarborIR = {
    header: ir.header,
    items: lineage.items,
  };
  const forks: ForkSessionPlan[] = [];
  const mainPathSet = new Set(lineage.path);
  const points = findForks(ir.items);
  let n = 0;
  for (const fp of points) {
    for (const childId of fp.childIds) {
      if (mainPathSet.has(childId)) continue; // 主链分支不重复
      const branch = collectSubtree(childId, ir.items);
      if (!branch.length) continue;
      n++;
      const anc = ancestorsOf(fp.parentId, ir.items);
      // 祖先只保留可 branchable + 相关 tool
      const ancIds = new Set(anc.map((a) => a.itemId));
      const ancItems = ir.items.filter((i) => ancIds.has(i.itemId));
      const merged = [...ancItems, ...branch];
      forks.push({
        titleSuffix: ` (fork #${n})`,
        forkFromItemId: fp.parentId,
        ir: {
          header: createHeader(
            {
              ...ir.header.session,
              id: `${ir.header.session.id}-fork-${n}`,
              sourceSessionId: `${ir.header.session.sourceSessionId}-fork-${n}`,
              title: `${ir.header.session.title} (fork #${n})`,
            },
            { ...ir.header.extensions, forkFrom: fp.parentId, forkChild: childId },
          ),
          items: merged,
        },
      });
    }
  }
  return { main, forks };
}

/** 压缩边界：IR 中 checkpoint 且 label 含 compact/摘要 */
export function isCompactionCheckpoint(it: HarborItem): boolean {
  if (it.type !== "checkpoint") return false;
  const l = it.label.toLowerCase();
  return l.includes("compact") || l.includes("压缩") || l.includes("摘要") || l.includes("summary");
}

/** 在压缩点前截断主链（可选策略 keep=all|post-compact） */
export function applyCompactionPolicy(
  items: HarborItem[],
  policy: "keep-all" | "post-compact" = "keep-all",
): HarborItem[] {
  if (policy === "keep-all") return items;
  let lastCk = -1;
  items.forEach((it, i) => {
    if (isCompactionCheckpoint(it)) lastCk = i;
  });
  if (lastCk < 0) return items;
  // 保留压缩摘要 + 之后的消息
  return items.slice(Math.max(0, lastCk));
}
