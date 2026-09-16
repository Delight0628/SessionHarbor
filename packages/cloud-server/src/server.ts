/**
 * SessionHarbor 自建云存储 — HTTP 服务
 * 账户隔离 · 并发 WAL · 登录/改密/登出 · 同步写入
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ApiError, CloudDatabase, atomicWrite, quotaOf, safeRel } from "./db.js";

const PORT = Number(process.env.HARBOR_CLOUD_PORT || 8787);
const DATA = path.resolve(
  process.env.HARBOR_CLOUD_DATA || path.join(process.cwd(), "cloud-data"),
);

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,PUT,POST,HEAD,OPTIONS",
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

export function createCloudServer(dataRoot: string) {
  const db = new CloudDatabase(dataRoot);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const p = url.pathname;
    const method = req.method || "GET";
    try {
      if (method === "OPTIONS") {
        json(res, 204, {});
        return;
      }
      if (p === "/healthz") {
        json(res, 200, { ok: true, service: "sessionharbor-cloud", ts: Date.now() });
        return;
      }

      // ---------- auth ----------
      if (p === "/v1/auth/register" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as { email?: string; password?: string };
        const r = db.register(String(body.email || "").toLowerCase().trim(), String(body.password || ""));
        json(res, 201, r);
        return;
      }
      if (p === "/v1/auth/login" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as { email?: string; password?: string };
        const r = db.login(String(body.email || "").toLowerCase().trim(), String(body.password || ""));
        json(res, 200, r);
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
          const r = db.changePassword(user.userId, String(body.oldPassword || ""), String(body.newPassword || ""));
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
        if (p === "/v1/admin/plan" && method === "POST") {
          // 演示/自建运维：设置自己的 plan（生产应鉴权 admin）
          const body = JSON.parse(await readBody(req)) as { plan?: string };
          const plan = String(body.plan || "free");
          if (!["free", "pro", "team"].includes(plan)) throw new ApiError("非法 plan", 400);
          db.setPlan(user.userId, plan as "free" | "pro" | "team");
          json(res, 200, { ok: true, plan });
          return;
        }

        // ---------- sync objects ----------
        if (p.startsWith("/v1/sync/") && (method === "GET" || method === "HEAD" || method === "PUT")) {
          const rel = safeRel(p.slice("/v1/sync/".length));
          const root = db.userDir(user.userId);
          const abs = path.resolve(path.join(root, rel));
          if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) {
            throw new ApiError("路径越界", 403);
          }

          if (method === "PUT") {
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
  });

  return { server, db };
}

const isMain = process.argv[1] && /server\.js$/.test(process.argv[1]);
if (isMain) {
  const { server } = createCloudServer(DATA);
  server.listen(PORT, () => {
    console.log(`SessionHarbor Cloud  http://127.0.0.1:${PORT}`);
    console.log(`数据目录: ${DATA}`);
    console.log(
      [
        "API: POST /v1/auth/register | login | change-password | logout",
        "     GET  /v1/auth/me",
        "     GET/PUT /v1/sync/**   (Bearer，按用户隔离)",
      ].join("\n"),
    );
  });
}
