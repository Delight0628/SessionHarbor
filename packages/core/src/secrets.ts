/**
 * 脱敏扫描器：识别密钥/token/密码/私钥/内网地址
 * 用途：迁移前告警、上云前强制脱敏（对齐开发文档 §13）
 */

export type SecretKind =
  | "private_key"
  | "aws_access_key"
  | "github_token"
  | "openai_key"
  | "anthropic_key"
  | "slack_token"
  | "jwt"
  | "generic_api_key"
  | "password_assignment"
  | "bearer_token"
  | "internal_ip"
  | "internal_domain"
  | "email";

export interface SecretHit {
  kind: SecretKind;
  /** 脱敏后的预览，如 sk-…abc */
  preview: string;
  /** 在文本中的起止下标 */
  start: number;
  end: number;
  /** 置信度 high/medium/low */
  confidence: "high" | "medium" | "low";
}

export interface ScanResult {
  hits: SecretHit[];
  /** 按 kind 聚合计数 */
  byKind: Record<string, number>;
  /** 是否建议阻断上云 */
  shouldBlockCloud: boolean;
}

const RULES: Array<{
  kind: SecretKind;
  re: RegExp;
  confidence: SecretHit["confidence"];
  blockCloud?: boolean;
}> = [
  {
    kind: "private_key",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]{20,}?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    confidence: "high",
    blockCloud: true,
  },
  {
    kind: "aws_access_key",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    confidence: "high",
    blockCloud: true,
  },
  {
    kind: "github_token",
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    confidence: "high",
    blockCloud: true,
  },
  {
    kind: "openai_key",
    re: /\bsk-(?:proj-|ant-|-[A-Za-z0-9]{4})?[A-Za-z0-9_-]{20,}\b/g,
    confidence: "high",
    blockCloud: true,
  },
  {
    kind: "anthropic_key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    confidence: "high",
    blockCloud: true,
  },
  {
    kind: "slack_token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    confidence: "high",
    blockCloud: true,
  },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    confidence: "medium",
    blockCloud: true,
  },
  {
    kind: "bearer_token",
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
    confidence: "medium",
    blockCloud: true,
  },
  {
    kind: "password_assignment",
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?([^\s"']{8,})["']?/gi,
    confidence: "medium",
    blockCloud: true,
  },
  {
    kind: "generic_api_key",
    re: /\b(?:key|token|secret)["']?\s*[=:]\s*["']([A-Za-z0-9_\-./+=]{24,})["']/gi,
    confidence: "low",
  },
  {
    // RFC1918 内网 IPv4
    kind: "internal_ip",
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    confidence: "high",
    blockCloud: true,
  },
  {
    // 常见内网域名后缀
    kind: "internal_domain",
    re: /\b[a-z0-9.-]+\.(?:local|internal|corp|intranet|sfcloud\.local|int\.[a-z]+)\b/gi,
    confidence: "medium",
    blockCloud: true,
  },
  {
    kind: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: "low",
  },
];

function maskPreview(s: string): string {
  if (s.length <= 8) return s[0] + "…" + s[s.length - 1];
  return s.slice(0, 4) + "…" + s.slice(-4);
}

export function scanText(text: string): ScanResult {
  const hits: SecretHit[] = [];
  const byKind: Record<string, number> = {};
  let shouldBlockCloud = false;

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = rule.re.exec(text)) !== null && guard++ < 500) {
      const raw = m[0];
      hits.push({
        kind: rule.kind,
        preview: maskPreview(raw),
        start: m.index,
        end: m.index + raw.length,
        confidence: rule.confidence,
      });
      byKind[rule.kind] = (byKind[rule.kind] || 0) + 1;
      if (rule.blockCloud) shouldBlockCloud = true;
      // 避免零宽死循环
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return { hits, byKind, shouldBlockCloud };
}

/** 将命中片段替换为 ***REDACTED:kind*** */
export function redactText(text: string, hits: SecretHit[]): string {
  if (!hits.length) return text;
  let out = "";
  let last = 0;
  for (const h of hits) {
    out += text.slice(last, h.start) + `***REDACTED:${h.kind}***`;
    last = h.end;
  }
  out += text.slice(last);
  return out;
}

export function formatScanSummary(r: ScanResult): string {
  if (!r.hits.length) return "未发现敏感信息";
  const parts = Object.entries(r.byKind)
    .map(([k, n]) => `${k}×${n}`)
    .join(", ");
  return `发现 ${r.hits.length} 处敏感信息（${parts}）${r.shouldBlockCloud ? "；建议阻断上云" : ""}`;
}
