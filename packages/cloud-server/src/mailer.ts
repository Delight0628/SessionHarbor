/**
 * 验证码发信（自建三种通道）
 * - console: 打到服务端日志（默认，便于内网）
 * - file: 写入 data/mail/
 * - webhook: POST JSON 到外部（SMTP 中转 / 企业机器人）
 */

import fs from "node:fs";
import path from "node:path";

export type MailMode = "console" | "file" | "webhook" | "off";

export interface MailConfig {
  mode: MailMode;
  dataRoot: string;
  webhookUrl?: string;
  from?: string;
}

export function loadMailConfig(dataRoot: string): MailConfig {
  const mode = (process.env.HARBOR_CLOUD_MAIL || "console").toLowerCase() as MailMode;
  return {
    mode: ["console", "file", "webhook", "off"].includes(mode) ? mode : "console",
    dataRoot,
    webhookUrl: process.env.HARBOR_CLOUD_MAIL_WEBHOOK,
    from: process.env.HARBOR_CLOUD_MAIL_FROM || "SessionHarbor Cloud",
  };
}

export async function sendVerifyCode(
  cfg: MailConfig,
  email: string,
  code: string,
): Promise<void> {
  const subject = "SessionHarbor 邮箱验证码";
  const text = `你的验证码是 ${code}，24 小时内有效。若非本人操作请忽略。`;
  if (cfg.mode === "off") return;
  if (cfg.mode === "console") {
    console.log(`[mail:console] to=${email} subject=${subject} code=${code}`);
    return;
  }
  if (cfg.mode === "file") {
    const dir = path.join(cfg.dataRoot, "mail");
    fs.mkdirSync(dir, { recursive: true });
    const safe = email.replace(/[^\w@.-]+/g, "_");
    fs.appendFileSync(
      path.join(dir, `${Date.now()}-${safe}.txt`),
      `To: ${email}\nSubject: ${subject}\n\n${text}\n`,
      "utf8",
    );
    return;
  }
  if (cfg.mode === "webhook" && cfg.webhookUrl) {
    await fetch(cfg.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: email, subject, text, from: cfg.from }),
    });
  }
}
