/**
 * SessionHarbor 自建云存储 — HTTP 服务（生产加固版）
 * - 限流 / 防爆破
 * - 远端对象列表
 * - 管理端（admin token）
 * - /metrics
 * - 可选 TLS
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { ApiError, CloudDatabase, atomicWrite, quotaOf, safeRel } from "./db.js";
import { loadMailConfig, sendVerifyCode } from "./mailer.js";

const PORT = Number(
  process.env.PORT || process.env.HARBOR_CLOUD_PORT || 8787,
);
const DATA = path.resolve(
  process.env.HARBOR_CLOUD_DATA || path.join(process.cwd(), "cloud-data"),
);
const ADMIN_TOKEN = process.env.HARBOR_CLOUD_ADMIN_TOKEN || "";
const TLS_CERT = process.env.HARBOR_CLOUD_TLS_CERT || "";
const TLS_KEY = process.env.HARBOR_CLOUD_TLS_KEY || "";
const REQUIRE_EMAIL_VERIFY =
  String(process.env.HARBOR_CLOUD_REQUIRE_EMAIL_VERIFY || "").toLowerCase() === "1" ||
  String(process.env.HARBOR_CLOUD_REQUIRE_EMAIL_VERIFY || "").toLowerCase() === "true";

/** 简单滑动窗口限流：key → 时间戳列表 */
class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  check(key: string): { ok: boolean; retryAfterMs: number } {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterMs: this.windowMs - (now - (arr[0] || now)) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    // 清理
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) {
        if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
      }
    }
    return { ok: true, retryAfterMs: 0 };
  }
}

const authLimiter = new RateLimiter(10, 60_000); // 10/min/IP
const syncLimiter = new RateLimiter(300, 60_000); // 300/min/IP
const metrics = {
  startedAt: Date.now(),
  requests: 0,
  authFail: 0,
  syncPut: 0,
  syncGet: 0,
  rateLimited: 0,
};

function json(res: http.ServerResponse, code: number, body: unknown, extra?: Record<string, string>) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,PUT,POST,HEAD,OPTIONS",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > 64 * 1024 * 1024) {
        reject(new ApiError("请求体过大", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function bearer(req: http.IncomingMessage): string {
  const a = req.headers.authorization || "";
  return a.startsWith("Bearer ") ? a.slice(7) : "";
}

function clientIp(req: http.IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0]!.trim();
  return req.socket.remoteAddress || "unknown";
}

function requireAdmin(req: http.IncomingMessage) {
  if (!ADMIN_TOKEN) throw new ApiError("未配置 HARBOR_CLOUD_ADMIN_TOKEN，管理端关闭", 403);
  const t = bearer(req);
  if (!t || t !== ADMIN_TOKEN) throw new ApiError("管理员鉴权失败", 401);
}

export function createCloudServer(dataRoot: string) {
  const db = new CloudDatabase(dataRoot);
  const mail = loadMailConfig(dataRoot);

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    metrics.requests++;
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const p = url.pathname;
    const method = req.method || "GET";
    const ip = clientIp(req);
    try {
      if (method === "OPTIONS") {
        json(res, 204, {});
        return;
      }
      if (p === "/healthz") {
        json(res, 200, { ok: true, service: "sessionharbor-cloud", ts: Date.now() });
        return;
      }
      if (p === "/metrics" && method === "GET") {
        json(res, 200, { ...metrics, uptimeMs: Date.now() - metrics.startedAt, db: db.stats() });
        return;
      }

      // ---------- admin ----------
      if (p === "/v1/admin/users" && method === "GET") {
        requireAdmin(req);
        json(res, 200, { users: db.listUsers() });
        return;
      }
      if (p === "/v1/admin/plan" && method === "POST") {
        requireAdmin(req);
        const body = JSON.parse(await readBody(req)) as { userId?: string; plan?: string };
        const plan = String(body.plan || "");
        if (!["free", "pro", "team"].includes(plan)) throw new ApiError("非法 plan", 400);
        if (!body.userId) throw new ApiError("缺少 userId", 400);
        db.setPlan(String(body.userId), plan as "free" | "pro" | "team");
        json(res, 200, { ok: true });
        return;
      }
      if (p === "/v1/admin/disable" && method === "POST") {
        requireAdmin(req);
        const body = JSON.parse(await readBody(req)) as { userId?: string; disabled?: boolean };
        if (!body.userId) throw new ApiError("缺少 userId", 400);
        db.setDisabled(String(body.userId), Boolean(body.disabled));
        json(res, 200, { ok: true });
        return;
      }
      if (p === "/v1/admin/verify-email" && method === "POST") {
        requireAdmin(req);
        const body = JSON.parse(await readBody(req)) as { userId?: string };
        if (!body.userId) throw new ApiError("缺少 userId", 400);
        db.adminMarkVerified(String(body.userId));
        json(res, 200, { ok: true });
        return;
      }

      // ---------- auth（限流） ----------
      if (p === "/v1/auth/register" || p === "/v1/auth/login" || p === "/v1/auth/change-password") {
        const rl = authLimiter.check(`${ip}:${p}`);
        if (!rl.ok) {
          metrics.rateLimited++;
          json(res, 429, { error: "请求过于频繁，请稍后再试" }, {
            "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
          });
          return;
        }
      }
      if (p === "/v1/auth/register" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as { email?: string; password?: string };
        const email = String(body.email || "").toLowerCase().trim();
        const r = db.register(email, String(body.password || ""));
        try {
          await sendVerifyCode(mail, email, r.verifyCode || "");
        } catch (e) {
          console.error("[mail] send failed", e);
        }
        // 开发/内网：console/file 模式把 code 回传，便于联调
        const expose =
          mail.mode === "console" || mail.mode === "file" ? r.verifyCode : undefined;
        json(res, 201, {
          userId: r.userId,
          token: r.token,
          plan: r.plan,
          emailVerified: r.emailVerified,
          verifyCode: expose,
        });
        return;
      }
      if (p === "/v1/auth/verify-email" && method === "POST") {
        const rl = authLimiter.check(`${ip}:${p}`);
        if (!rl.ok) {
          metrics.rateLimited++;
          json(res, 429, { error: "请求过于频繁，请稍后再试" });
          return;
        }
        const body = JSON.parse(await readBody(req)) as { email?: string; code?: string };
        const r = db.verifyEmail(String(body.email || "").toLowerCase().trim(), String(body.code || ""));
        json(res, 200, { ok: true, ...r, emailVerified: true });
        return;
      }
      if (p === "/v1/auth/resend-verify" && method === "POST") {
        const rl = authLimiter.check(`${ip}:${p}`);
        if (!rl.ok) {
          metrics.rateLimited++;
          json(res, 429, { error: "请求过于频繁，请稍后再试" });
          return;
        }
        const body = JSON.parse(await readBody(req)) as { email?: string };
        const email = String(body.email || "").toLowerCase().trim();
        const r = db.resendVerifyCode(email);
        try {
          await sendVerifyCode(mail, email, r.code);
        } catch (e) {
          console.error("[mail] send failed", e);
        }
        json(res, 200, {
          ok: true,
          verifyCode: mail.mode === "console" || mail.mode === "file" ? r.code : undefined,
        });
        return;
      }
      if (p === "/v1/auth/login" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as { email?: string; password?: string };
        try {
          const r = db.login(String(body.email || "").toLowerCase().trim(), String(body.password || ""));
          json(res, 200, r);
        } catch (e) {
          metrics.authFail++;
          throw e;
        }
        return;
      }

      if (p.startsWith("/v1/")) {
        const token = bearer(req);
        if (!token) {
          json(res, 401, { error: "缺少 Authorization: Bearer <token>" });
          return;
        }
        const user = db.auth(token);

        if (p === "/v1/auth/change-password" && method === "POST") {
          const body = JSON.parse(await readBody(req)) as {
            oldPassword?: string;
            newPassword?: string;
          };
          const r = db.changePassword(
            user.userId,
            String(body.oldPassword || ""),
            String(body.newPassword || ""),
          );
          json(res, 200, { ...r, userId: user.userId, email: user.email });
          return;
        }
        if (p === "/v1/auth/logout" && method === "POST") {
          db.logout(token);
          json(res, 200, { ok: true });
          return;
        }
        if (p === "/v1/auth/me" && method === "GET") {
          const usage = db.usage(user.userId);
          json(res, 200, {
            userId: user.userId,
            email: user.email,
            plan: user.plan,
            usage,
            quota: quotaOf(user.plan),
          });
          return;
        }
        // 用户自助列表（远端对象）
        if (p === "/v1/sync/list" && method === "GET") {
          const rl = syncLimiter.check(ip);
          if (!rl.ok) {
            metrics.rateLimited++;
            json(res, 429, { error: "过于频繁" });
            return;
          }
          const files = db.listUserObjects(user.userId);
          json(res, 200, { files, count: files.length });
          return;
        }

        // ---------- sync objects ----------
        if (p.startsWith("/v1/sync/") && (method === "GET" || method === "HEAD" || method === "PUT")) {
          const rl = syncLimiter.check(ip);
          if (!rl.ok) {
            metrics.rateLimited++;
            json(res, 429, { error: "过于频繁" });
            return;
          }
          const rel = safeRel(p.slice("/v1/sync/".length));
          if (rel === "list") {
            // /v1/sync/list 已处理，防止落到文件
            json(res, 404, { error: "not found" });
            return;
          }
          const root = db.userDir(user.userId);
          const abs = path.resolve(path.join(root, rel));
          if (!abs.startsWith(path.resolve(root) + path.sep)) {
            throw new ApiError("路径越界", 403);
          }

          if (method === "PUT") {
            metrics.syncPut++;
            if (REQUIRE_EMAIL_VERIFY && !db.isEmailVerified(user.userId)) {
              json(res, 403, { error: "请先验证邮箱后再同步", code: "EMAIL_NOT_VERIFIED" });
              return;
            }
            const body = await readBody(req);
            if (rel.endsWith(".harbor.enc.json")) {
              const usage = db.usage(user.userId);
              const quota = quotaOf(user.plan);
              if (!fs.existsSync(abs) && usage.sessions >= quota.maxSessions) {
                json(res, 402, {
                  error: `会话数已达套餐上限（${user.plan}: ${quota.maxSessions}）`,
                  upgrade: true,
                });
                return;
              }
            }
            atomicWrite(abs, body);
            json(res, 200, { ok: true, path: rel, bytes: Buffer.byteLength(body) });
            return;
          }
          if (!fs.existsSync(abs)) {
            json(res, 404, { error: "not found" });
            return;
          }
          metrics.syncGet++;
          if (method === "HEAD") {
            res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
            res.end();
            return;
          }
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(fs.readFileSync(abs));
          return;
        }
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof ApiError) {
        json(res, e.status, { error: e.message });
        return;
      }
      json(res, 500, { error: e instanceof Error ? e.message : "server error" });
    }
  };

  const useTls = Boolean(TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY));
  const server = useTls
    ? https.createServer(
        {
          cert: fs.readFileSync(TLS_CERT),
          key: fs.readFileSync(TLS_KEY),
        },
        handler,
      )
    : http.createServer(handler);

  return { server, db, useTls };
}

const isMain = process.argv[1] && /server\.js$/.test(process.argv[1]);
if (isMain) {
  const { server, useTls } = createCloudServer(DATA);
  server.listen(PORT, () => {
    const scheme = useTls ? "https" : "http";
    console.log(`SessionHarbor Cloud  ${scheme}://127.0.0.1:${PORT}`);
    console.log(`数据目录: ${DATA}`);
    console.log(`管理端: ${ADMIN_TOKEN ? "已启用 (HARBOR_CLOUD_ADMIN_TOKEN)" : "未设置 ADMIN_TOKEN"}`);
    console.log(`邮件通道: ${process.env.HARBOR_CLOUD_MAIL || "console"}`);
    console.log(`强制邮箱验证: ${REQUIRE_EMAIL_VERIFY ? "开" : "关"}`);
    console.log(`TLS: ${useTls ? "已启用" : "未启用（生产建议 Nginx/Caddy 反代）"}`);
  });
}
