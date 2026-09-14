/**
 * SessionHarbor 托管云服务端（M3 最小可用）
 * - 注册/登录：邮箱+密码 → Bearer token
 * - 数据隔离：所有 /v1/sync/* 按 token 解析 userId，路径不信任客户端
 * - 额度：Free/Pro/Team 按套餐限制会话数与体积
 *
 * 启动:
 *   node packages/cloud-server/dist/server.js
 *   环境: HARBOR_CLOUD_PORT=8787 HARBOR_CLOUD_DATA=./data
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PLANS, type PlanId } from "@sessionharbor/core";

const PORT = Number(process.env.HARBOR_CLOUD_PORT || 8787);
const DATA = path.resolve(process.env.HARBOR_CLOUD_DATA || path.join(process.cwd(), "cloud-data"));

function hashPassword(password: string, salt: Buffer): string {
  return scryptSync(password, salt, 32).toString("base64");
}

function verifyPassword(password: string, salt: Buffer, hash: string): boolean {
  const a = Buffer.from(hashPassword(password, salt), "base64");
  const b = Buffer.from(hash, "base64");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

class CloudStore {
  private db: DatabaseSync;
  readonly dataRoot: string;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
    fs.mkdirSync(dataRoot, { recursive: true });
    this.db = new DatabaseSync(path.join(dataRoot, "cloud.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
    `);
  }

  register(email: string, password: string): { userId: string; token: string; plan: PlanId } {
    const existing = this.db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
    if (existing) throw Object.assign(new Error("邮箱已注册"), { status: 409 });
    const userId = randomBytes(16).toString("hex");
    const salt = randomBytes(16);
    const hash = hashPassword(password, salt);
    this.db
      .prepare(
        `INSERT INTO users (id, email, password_hash, password_salt, plan, created_at)
         VALUES (?, ?, ?, ?, 'free', ?)`,
      )
      .run(userId, email, hash, salt.toString("base64"), Date.now());
    const token = this.issueToken(userId);
    return { userId, token, plan: "free" };
  }

  login(email: string, password: string): { userId: string; token: string; plan: PlanId } {
    const row = this.db
      .prepare(`SELECT id, password_hash, password_salt, plan FROM users WHERE email = ?`)
      .get(email) as
      | { id: string; password_hash: string; password_salt: string; plan: string }
      | undefined;
    if (!row) throw Object.assign(new Error("邮箱或密码错误"), { status: 401 });
    const salt = Buffer.from(row.password_salt, "base64");
    if (!verifyPassword(password, salt, row.password_hash)) {
      throw Object.assign(new Error("邮箱或密码错误"), { status: 401 });
    }
    const token = this.issueToken(row.id);
    return { userId: row.id, token, plan: (row.plan as PlanId) || "free" };
  }

  private issueToken(userId: string): string {
    const token = randomBytes(32).toString("base64url");
    const th = createHash("sha256").update(token).digest("hex");
    this.db
      .prepare(`INSERT INTO tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)`)
      .run(th, userId, Date.now());
    return token;
  }

  auth(token: string): { userId: string; email: string; plan: PlanId } {
    const th = createHash("sha256").update(token).digest("hex");
    const row = this.db
      .prepare(
        `SELECT t.user_id, u.email, u.plan FROM tokens t
         JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
      )
      .get(th) as { user_id: string; email: string; plan: string } | undefined;
    if (!row) throw Object.assign(new Error("无效 token，请重新登录"), { status: 401 });
    this.db.prepare(`UPDATE tokens SET last_used_at = ? WHERE token_hash = ?`).run(Date.now(), th);
    return { userId: row.user_id, email: row.email, plan: (row.plan as PlanId) || "free" };
  }

  userDir(userId: string): string {
    // 路径隔离：仅允许 hex userId
    if (!/^[0-9a-f]{16,64}$/i.test(userId)) throw new Error("bad user id");
    const d = path.join(this.dataRoot, "users", userId);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  usage(userId: string): { sessions: number; storageMb: number } {
    const dir = this.userDir(userId);
    let sessions = 0;
    let bytes = 0;
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".harbor.enc.json")) {
          sessions++;
          bytes += fs.statSync(p).size;
        }
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return { sessions, storageMb: Math.round((bytes / (1024 * 1024)) * 10) / 10 };
  }

  setPlan(userId: string, plan: PlanId) {
    this.db.prepare(`UPDATE users SET plan = ? WHERE id = ?`).run(plan, userId);
  }
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,PUT,POST,HEAD,OPTIONS",
  });
  res.end(s);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeRel(rel: string): string {
  const norm = path.posix.normalize(rel).replace(/^\/+/, "");
  if (norm.includes("..")) throw new Error("illegal path");
  return norm;
}

export function createCloudServer(dataRoot: string) {
  const store = new CloudStore(dataRoot);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const p = url.pathname;
    try {
      if (req.method === "OPTIONS") {
        json(res, 204, {});
        return;
      }

      // health
      if (p === "/healthz") {
        json(res, 200, { ok: true, service: "sessionharbor-cloud" });
        return;
      }

      // register
      if (p === "/v1/auth/register" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as { email?: string; password?: string };
        if (!body.email || !body.password || body.password.length < 6) {
          json(res, 400, { error: "需要 email 与至少 6 位 password" });
          return;
        }
        const r = store.register(body.email.toLowerCase().trim(), body.password);
        json(res, 201, r);
        return;
      }

      // login
      if (p === "/v1/auth/login" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as { email?: string; password?: string };
        if (!body.email || !body.password) {
          json(res, 400, { error: "需要 email/password" });
          return;
        }
        const r = store.login(body.email.toLowerCase().trim(), body.password);
        json(res, 200, r);
        return;
      }

      // auth prefix
      if (p.startsWith("/v1/")) {
        const auth = req.headers.authorization || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token) {
          json(res, 401, { error: "缺少 Authorization: Bearer <token>" });
          return;
        }
        const user = store.auth(token);
        const root = store.userDir(user.userId);

        if (p === "/v1/auth/me" && req.method === "GET") {
          const usage = store.usage(user.userId);
          const quota = PLANS[user.plan] || PLANS.free;
          json(res, 200, {
            userId: user.userId,
            email: user.email,
            plan: user.plan,
            usage,
            quota,
          });
          return;
        }

        // 同步对象：强制落在当前用户目录下
        if (p.startsWith("/v1/sync/") && (req.method === "GET" || req.method === "HEAD" || req.method === "PUT")) {
          const rel = safeRel(p.slice("/v1/sync/".length));
          const abs = path.join(root, rel);
          if (!abs.startsWith(root)) {
            json(res, 403, { error: "路径越界" });
            return;
          }
          if (req.method === "PUT") {
            const usage = store.usage(user.userId);
            const quota = PLANS[user.plan] || PLANS.free;
            if (rel.endsWith(".harbor.enc.json") && usage.sessions >= quota.maxSessions) {
              const exists = fs.existsSync(abs);
              if (!exists) {
                json(res, 402, {
                  error: `会话数已达套餐上限（${user.plan}: ${quota.maxSessions}）`,
                  upgrade: true,
                });
                return;
              }
            }
            const body = await readBody(req);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, body, "utf8");
            json(res, 200, { ok: true, path: rel, bytes: body.length });
            return;
          }
          if (!fs.existsSync(abs)) {
            json(res, 404, { error: "not found" });
            return;
          }
          if (req.method === "HEAD") {
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
      const err = e as Error & { status?: number };
      json(res, err.status || 500, { error: err.message || "server error" });
    }
  });

  return { server, store };
}

// CLI 入口
const isMain = process.argv[1] && process.argv[1].endsWith("server.js");
if (isMain) {
  const { server } = createCloudServer(DATA);
  server.listen(PORT, () => {
    console.log(`SessionHarbor Cloud listening on http://127.0.0.1:${PORT}`);
    console.log(`数据目录: ${DATA}`);
    console.log("接口: POST /v1/auth/register | POST /v1/auth/login | /v1/sync/*（Bearer）");
  });
}
