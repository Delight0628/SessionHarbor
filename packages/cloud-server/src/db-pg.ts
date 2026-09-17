/**
 * Postgres 后端（Supabase / Neon 免费档可用）
 * - users / tokens 表
 * - 密文对象存 harbor_objects（免挂盘，适合 serverless PG）
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import pg from "pg";
import type { Pool as PgPool } from "pg";
import { PLANS, type PlanId } from "@sessionharbor/core";
import { ApiError, quotaOf, safeRel } from "./db.js";

const { Pool } = pg;

function hashPassword(password: string, salt: Buffer): string {
  return scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString("base64");
}

function verifyPassword(password: string, salt: Buffer, expected: string): boolean {
  const a = Buffer.from(hashPassword(password, salt), "base64");
  const b = Buffer.from(expected, "base64");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS harbor_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  verify_code TEXT,
  verify_expires BIGINT
);
CREATE TABLE IF NOT EXISTS harbor_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES harbor_users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_harbor_tokens_user ON harbor_tokens(user_id);
CREATE TABLE IF NOT EXISTS harbor_objects (
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,
  body BYTEA NOT NULL,
  bytes INTEGER NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, path)
);
`;

export class PostgresCloudDatabase {
  private pool: PgPool;

  constructor(readonly databaseUrl: string) {
    // 部分企业网关会插入自签证书，导致 verify-full 失败；
    // 可用 HARBOR_CLOUD_PG_SSL_INSECURE=1 放宽（仅建议内网/自建）。
    const insecure =
      String(process.env.HARBOR_CLOUD_PG_SSL_INSECURE || "").toLowerCase() === "1" ||
      String(process.env.HARBOR_CLOUD_PG_SSL_INSECURE || "").toLowerCase() === "true";
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      ...(insecure ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const r = await this.pool.query(sql, params);
    return r.rows as T[];
  }

  async register(email: string, password: string): Promise<{
    userId: string;
    token: string;
    plan: PlanId;
    emailVerified: boolean;
    verifyCode?: string;
  }> {
    if (!email.includes("@")) throw new ApiError("邮箱格式不正确", 400);
    if (password.length < 6) throw new ApiError("密码至少 6 位", 400);
    const exists = await this.query(`SELECT id FROM harbor_users WHERE email = $1`, [email]);
    if (exists.length) throw new ApiError("邮箱已注册", 409);
    const userId = randomBytes(16).toString("hex");
    const salt = randomBytes(16);
    const now = Date.now();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.query(
      `INSERT INTO harbor_users
       (id, email, password_hash, password_salt, plan, created_at, updated_at, disabled, email_verified, verify_code, verify_expires)
       VALUES ($1,$2,$3,$4,'free',$5,$5,0,0,$6,$7)`,
      [userId, email, hashPassword(password, salt), salt.toString("base64"), now, code, now + 86400000],
    );
    return {
      userId,
      token: await this.issueToken(userId),
      plan: "free",
      emailVerified: false,
      verifyCode: code,
    };
  }

  async login(email: string, password: string): Promise<{
    userId: string;
    token: string;
    plan: PlanId;
    emailVerified: boolean;
  }> {
    const rows = await this.query<{
      id: string;
      password_hash: string;
      password_salt: string;
      plan: string;
      disabled: number;
      email_verified: number;
    }>(`SELECT id, password_hash, password_salt, plan, disabled, email_verified FROM harbor_users WHERE email = $1`, [
      email,
    ]);
    const row = rows[0];
    if (!row) throw new ApiError("邮箱或密码错误", 401);
    if (row.disabled) throw new ApiError("账号已禁用", 403);
    const salt = Buffer.from(row.password_salt, "base64");
    if (!verifyPassword(password, salt, row.password_hash)) {
      throw new ApiError("邮箱或密码错误", 401);
    }
    return {
      userId: row.id,
      token: await this.issueToken(row.id),
      plan: (row.plan as PlanId) || "free",
      emailVerified: Boolean(row.email_verified),
    };
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<{ token: string }> {
    if (newPassword.length < 6) throw new ApiError("新密码至少 6 位", 400);
    const rows = await this.query<{ password_hash: string; password_salt: string }>(
      `SELECT password_hash, password_salt FROM harbor_users WHERE id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) throw new ApiError("用户不存在", 404);
    const salt = Buffer.from(row.password_salt, "base64");
    if (!verifyPassword(oldPassword, salt, row.password_hash)) {
      throw new ApiError("旧密码不正确", 401);
    }
    const newSalt = randomBytes(16);
    await this.query(
      `UPDATE harbor_users SET password_hash=$1, password_salt=$2, updated_at=$3 WHERE id=$4`,
      [hashPassword(newPassword, newSalt), newSalt.toString("base64"), Date.now(), userId],
    );
    await this.query(
      `UPDATE harbor_tokens SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL`,
      [Date.now(), userId],
    );
    return { token: await this.issueToken(userId) };
  }

  async logout(token: string): Promise<void> {
    await this.query(
      `UPDATE harbor_tokens SET revoked_at=$1 WHERE token_hash=$2 AND revoked_at IS NULL`,
      [Date.now(), sha256(token)],
    );
  }

  private async issueToken(userId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.query(
      `INSERT INTO harbor_tokens (token_hash, user_id, created_at) VALUES ($1,$2,$3)`,
      [sha256(token), userId, Date.now()],
    );
    return token;
  }

  async auth(token: string): Promise<{ userId: string; email: string; plan: PlanId }> {
    const rows = await this.query<{
      user_id: string;
      email: string;
      plan: string;
      disabled: number;
    }>(
      `SELECT t.user_id, u.email, u.plan, u.disabled
       FROM harbor_tokens t JOIN harbor_users u ON u.id = t.user_id
       WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row) throw new ApiError("无效 token，请重新登录", 401);
    if (row.disabled) throw new ApiError("账号已禁用", 403);
    await this.query(`UPDATE harbor_tokens SET last_used_at=$1 WHERE token_hash=$2`, [
      Date.now(),
      sha256(token),
    ]);
    return { userId: row.user_id, email: row.email, plan: (row.plan as PlanId) || "free" };
  }

  async verifyEmail(email: string, code: string): Promise<{ userId: string; token: string }> {
    const rows = await this.query<{
      id: string;
      verify_code: string | null;
      verify_expires: string | null;
      email_verified: number;
    }>(
      `SELECT id, verify_code, verify_expires, email_verified FROM harbor_users WHERE email=$1`,
      [email],
    );
    const row = rows[0];
    if (!row) throw new ApiError("用户不存在", 404);
    if (row.email_verified) return { userId: row.id, token: await this.issueToken(row.id) };
    if (!row.verify_code || row.verify_code !== code) throw new ApiError("验证码不正确", 400);
    if (row.verify_expires && Date.now() > Number(row.verify_expires)) {
      throw new ApiError("验证码已过期，请重新获取", 400);
    }
    await this.query(
      `UPDATE harbor_users SET email_verified=1, verify_code=NULL, verify_expires=NULL, updated_at=$1 WHERE id=$2`,
      [Date.now(), row.id],
    );
    return { userId: row.id, token: await this.issueToken(row.id) };
  }

  async resendVerifyCode(email: string): Promise<{ code: string }> {
    const rows = await this.query<{ id: string; email_verified: number }>(
      `SELECT id, email_verified FROM harbor_users WHERE email=$1`,
      [email],
    );
    const row = rows[0];
    if (!row) throw new ApiError("用户不存在", 404);
    if (row.email_verified) throw new ApiError("邮箱已验证", 400);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.query(
      `UPDATE harbor_users SET verify_code=$1, verify_expires=$2, updated_at=$3 WHERE id=$4`,
      [code, Date.now() + 86400000, Date.now(), row.id],
    );
    return { code };
  }

  async isEmailVerified(userId: string): Promise<boolean> {
    const rows = await this.query<{ email_verified: number }>(
      `SELECT email_verified FROM harbor_users WHERE id=$1`,
      [userId],
    );
    return Boolean(rows[0]?.email_verified);
  }

  async adminMarkVerified(userId: string): Promise<void> {
    await this.query(
      `UPDATE harbor_users SET email_verified=1, verify_code=NULL, verify_expires=NULL, updated_at=$1 WHERE id=$2`,
      [Date.now(), userId],
    );
  }

  async setPlan(userId: string, plan: PlanId): Promise<void> {
    await this.query(`UPDATE harbor_users SET plan=$1, updated_at=$2 WHERE id=$3`, [
      plan,
      Date.now(),
      userId,
    ]);
  }

  async setDisabled(userId: string, disabled: boolean): Promise<void> {
    await this.query(`UPDATE harbor_users SET disabled=$1, updated_at=$2 WHERE id=$3`, [
      disabled ? 1 : 0,
      Date.now(),
      userId,
    ]);
    if (disabled) {
      await this.query(
        `UPDATE harbor_tokens SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL`,
        [Date.now(), userId],
      );
    }
  }

  async listUsers(): Promise<
    Array<{
      id: string;
      email: string;
      plan: string;
      disabled: number;
      created_at: number;
      email_verified: number;
      sessions: number;
      storageMb: number;
    }>
  > {
    const rows = await this.query<{
      id: string;
      email: string;
      plan: string;
      disabled: number;
      created_at: string;
      email_verified: number;
    }>(
      `SELECT id, email, plan, disabled, created_at, email_verified FROM harbor_users ORDER BY created_at DESC`,
    );
    const out = [];
    for (const r of rows) {
      const u = await this.usage(r.id);
      out.push({
        id: r.id,
        email: r.email,
        plan: r.plan,
        disabled: Number(r.disabled),
        created_at: Number(r.created_at),
        email_verified: Number(r.email_verified),
        sessions: u.sessions,
        storageMb: u.storageMb,
      });
    }
    return out;
  }

  async usage(userId: string): Promise<{ sessions: number; storageMb: number }> {
    const rows = await this.query<{ n: string; bytes: string }>(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(bytes),0)::text AS bytes
       FROM harbor_objects WHERE user_id=$1 AND path LIKE '%.harbor.enc.json'`,
      [userId],
    );
    const n = Number(rows[0]?.n || 0);
    const bytes = Number(rows[0]?.bytes || 0);
    return { sessions: n, storageMb: Math.round((bytes / 1048576) * 10) / 10 };
  }

  async listUserObjects(userId: string): Promise<Array<{ path: string; bytes: number; mtime: number }>> {
    const rows = await this.query<{ path: string; bytes: string; updated_at: string }>(
      `SELECT path, bytes, updated_at FROM harbor_objects WHERE user_id=$1 ORDER BY path`,
      [userId],
    );
    return rows.map((r) => ({
      path: r.path,
      bytes: Number(r.bytes),
      mtime: Number(r.updated_at),
    }));
  }

  async getObject(userId: string, rel: string): Promise<string | null> {
    const path = safeRel(rel);
    const rows = await this.query<{ body: Buffer }>(
      `SELECT body FROM harbor_objects WHERE user_id=$1 AND path=$2`,
      [userId, path],
    );
    if (!rows[0]) return null;
    return rows[0].body.toString("utf8");
  }

  async putObject(userId: string, rel: string, body: string): Promise<void> {
    const path = safeRel(rel);
    if (path.endsWith(".harbor.enc.json")) {
      const usage = await this.usage(userId);
      const rows = await this.query<{ plan: string }>(
        `SELECT plan FROM harbor_users WHERE id=$1`,
        [userId],
      );
      const plan = (rows[0]?.plan as PlanId) || "free";
      const quota = quotaOf(plan);
      const exists = await this.query(
        `SELECT 1 FROM harbor_objects WHERE user_id=$1 AND path=$2`,
        [userId, path],
      );
      if (!exists.length && usage.sessions >= quota.maxSessions) {
        throw new ApiError(
          `会话数已达套餐上限（${plan}: ${quota.maxSessions}）`,
          402,
        );
      }
    }
    const buf = Buffer.from(body, "utf8");
    await this.query(
      `INSERT INTO harbor_objects (user_id, path, body, bytes, updated_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, path) DO UPDATE SET body=EXCLUDED.body, bytes=EXCLUDED.bytes, updated_at=EXCLUDED.updated_at`,
      [userId, path, buf, buf.length, Date.now()],
    );
  }

  async stats() {
    const u = await this.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM harbor_users`);
    const t = await this.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM harbor_tokens WHERE revoked_at IS NULL`,
    );
    const d = await this.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM harbor_users WHERE disabled=1`,
    );
    return {
      users: Number(u[0]?.n || 0),
      disabled: Number(d[0]?.n || 0),
      activeTokens: Number(t[0]?.n || 0),
      dataRoot: "postgres",
    };
  }
}

export { PLANS };
