/**
 * 云订阅权益（对齐开发文档 §5 Obsidian 模式）
 * - 本地层永久免费
 * - BYO 云（网盘目录 / 自有 WebDAV）永久免费
 * - SessionHarbor 托管云按套餐计费
 */

export type PlanId = "free" | "pro" | "team";

export interface PlanQuota {
  /** 托管云会话条数上限 */
  maxSessions: number;
  /** 托管云密文总量 MB */
  maxStorageMb: number;
  /** 是否启用 Web/移动阅读端 */
  webReader: boolean;
  /** 是否团队共享库 */
  teamLibrary: boolean;
  /** 是否优先同步队列 */
  prioritySync: boolean;
}

export const PLANS: Record<PlanId, PlanQuota> = {
  free: {
    maxSessions: 50,
    maxStorageMb: 100,
    webReader: false,
    teamLibrary: false,
    prioritySync: false,
  },
  pro: {
    maxSessions: 10_000,
    maxStorageMb: 20_000,
    webReader: true,
    teamLibrary: false,
    prioritySync: true,
  },
  team: {
    maxSessions: 100_000,
    maxStorageMb: 200_000,
    webReader: true,
    teamLibrary: true,
    prioritySync: true,
  },
};

export interface License {
  plan: PlanId;
  /** 托管云账号 id（可选；BYO 可为空） */
  accountId?: string;
  /** 激活码 / 订阅 token（本地存，不上传明文密钥） */
  seatId?: string;
  expiresAt?: string; // ISO
  /** 托管云 endpoint；空表示未订阅托管云 */
  hostedEndpoint?: string;
}

export function isLicenseActive(lic: License | undefined, now = new Date()): boolean {
  if (!lic) return false;
  if (!lic.expiresAt) return lic.plan !== "free";
  const t = Date.parse(lic.expiresAt);
  return Number.isFinite(t) && t > now.getTime();
}

export function effectivePlan(lic: License | undefined): PlanId {
  if (!lic) return "free";
  if (lic.plan === "free") return "free";
  return isLicenseActive(lic) ? lic.plan : "free";
}

export interface QuotaUsage {
  sessions: number;
  storageMb: number;
}

export interface QuotaCheck {
  ok: boolean;
  plan: PlanId;
  reason?: string;
  upgradeHint?: string;
}

export function checkHostedQuota(lic: License | undefined, usage: QuotaUsage): QuotaCheck {
  const plan = effectivePlan(lic);
  const q = PLANS[plan];
  if (usage.sessions >= q.maxSessions) {
    return {
      ok: false,
      plan,
      reason: `托管云会话数已达套餐上限（${plan}: ${q.maxSessions}）`,
      upgradeHint: "升级 Pro/Team，或改用自备网盘/WebDAV（免费）",
    };
  }
  if (usage.storageMb >= q.maxStorageMb) {
    return {
      ok: false,
      plan,
      reason: `托管云容量已达上限（${plan}: ${q.maxStorageMb}MB）`,
      upgradeHint: "升级套餐或清理云端会话",
    };
  }
  return { ok: true, plan };
}

export function planDisplay(lic: License | undefined): string {
  const plan = effectivePlan(lic);
  if (plan === "free") {
    return "免费版 · 本地+BYO云无限 / 托管云 50 条";
  }
  return `${plan === "pro" ? "Pro" : "Team"} · 至 ${lic?.expiresAt?.slice(0, 10) || "长期"}`;
}

/** 托管云是否启用：配置了 endpoint 即可用（Free 也允许，受额度限制） */
export function hostedCloudEnabled(lic: License | undefined): boolean {
  return Boolean(lic?.hostedEndpoint);
}

export function formatPricing(): string {
  return [
    "SessionHarbor 商业模式（Obsidian 式）",
    "",
    "本地层（永久免费）",
    "  · 多客户端聚合 / 统一搜索 / 互迁 / 导出 / 分支",
    "  · 自备云：网盘同步盘目录 或 自有 WebDAV（加密推送/拉取）",
    "",
    "云订阅层（托管云，按月）",
    "  · Free   $0   托管 50 会话 / 100MB",
    "  · Pro    $5-8/月  托管 1 万会话 / 20GB + Web 阅读端 + 优先同步",
    "  · Team   按席位   团队会话库 + 审计 + 企业 SSO",
    "",
    "付费叙事：不是网盘，是「个人 AI 工作史成为可检索资产」的流通/检索/共享。",
  ].join("\n");
}
