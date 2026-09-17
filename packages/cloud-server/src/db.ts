/**
 * SessionHarbor 自建云存储 — 数据层
 * SQLite WAL + users/tokens；文件存储 users/<userId>/** 原子写
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PLANS, type PlanId } from "@sessionharbor/core";

export type { PlanId };

export interface UserRow {
  id: string;
  email: string;
  plan: PlanId;
  created_at: number;
  updated_at: number;
  disabled: number;
}

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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class CloudDatabase {
  private db: DatabaseSync;

  constructor(readonly dataRoot: string) {
    fs.mkdirSync(dataRoot, { recursive: true });
    this.db = new DatabaseSync(path.join(dataRoot, "cloud.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        email_verified INTEGER NOT NULL DEFAULT 0,
        verify_code TEXT,
        verify_expires INTEGER
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);
    `);
    // 旧库升级
    for (const col of [
      "email_verified INTEGER NOT NULL DEFAULT 0",
      "verify_code TEXT",
      "verify_expires INTEGER",
    ]) {
      try {
        this.db.exec(`ALTER TABLE users ADD COLUMN ${col}`);
      } catch {
        /* exists */
      }
    }
  }

  close(): void {
    this.db.close();
  }

  register(email: string, password: string): {
    userId: string;
    token: string;
    plan: PlanId;
    emailVerified: boolean;
    verifyCode?: string;
  } {
    if (!email.includes("@")) throw new ApiError("邮箱格式不正确", 400);
    if (password.length < 6) throw new ApiError("密码至少 6 位", 400);
    const exists = this.db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
    if (exists) throw new ApiError("邮箱已注册", 409);
    const userId = randomBytes(16).toString("hex");
    const salt = randomBytes(16);
    const now = Date.now();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.db
      .prepare(
        `INSERT INTO users
         (id, email, password_hash, password_salt, plan, created_at, updated_at, disabled,
          email_verified, verify_code, verify_expires)
         VALUES (?, ?, ?, ?, 'free', ?, ?, 0, 0, ?, ?)`,
      )
      .run(
        userId,
        email,
        hashPassword(password, salt),
        salt.toString("base64"),
        now,
        now,
        code,
        now + 24 * 3600 * 1000,
      );
    return {
      userId,
      token: this.issueToken(userId),
      plan: "free",
      emailVerified: false,
      verifyCode: code,
    };
  }

  login(email: string, password: string): {
    userId: string;
    token: string;
    plan: PlanId;
    emailVerified: boolean;
  } {
    const row = this.db
      .prepare(
        `SELECT id, password_hash, password_salt, plan, disabled, email_verified FROM users WHERE email = ?`,
      )
      .get(email) as
      | {
          id: string;
          password_hash: string;
          password_salt: string;
          plan: string;
          disabled: number;
          email_verified: number;
        }
      | undefined;
    if (!row) throw new ApiError("邮箱或密码错误", 401);
    if (row.disabled) throw new ApiError("账号已禁用", 403);
    const salt = Buffer.from(row.password_salt, "base64");
    if (!verifyPassword(password, salt, row.password_hash)) {
      throw new ApiError("邮箱或密码错误", 401);
    }
    return {
      userId: row.id,
      token: this.issueToken(row.id),
      plan: (row.plan as PlanId) || "free",
      emailVerified: Boolean(row.email_verified),
    };
  }

  verifyEmail(email: string, code: string): { userId: string; token: string } {
    const row = this.db
      .prepare(
        `SELECT id, verify_code, verify_expires, email_verified FROM users WHERE email = ?`,
      )
      .get(email) as
      | { id: string; verify_code: string | null; verify_expires: number | null; email_verified: number }
      | undefined;
    if (!row) throw new ApiError("用户不存在", 404);
    if (row.email_verified) {
      return { userId: row.id, token: this.issueToken(row.id) };
    }
    if (!row.verify_code || row.verify_code !== code) throw new ApiError("验证码不正确", 400);
    if (row.verify_expires && Date.now() > row.verify_expires) {
      throw new ApiError("验证码已过期，请重新获取", 400);
    }
    this.db
      .prepare(
        `UPDATE users SET email_verified = 1, verify_code = NULL, verify_expires = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), row.id);
    return { userId: row.id, token: this.issueToken(row.id) };
  }

  resendVerifyCode(email: string): { code: string } {
    const row = this.db
      .prepare(`SELECT id, email_verified FROM users WHERE email = ?`)
      .get(email) as { id: string; email_verified: number } | undefined;
    if (!row) throw new ApiError("用户不存在", 404);
    if (row.email_verified) throw new ApiError("邮箱已验证", 400);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.db
      .prepare(`UPDATE users SET verify_code = ?, verify_expires = ?, updated_at = ? WHERE id = ?`)
      .run(code, Date.now() + 24 * 3600 * 1000, Date.now(), row.id);
    return { code };
  }

  isEmailVerified(userId: string): boolean {
    const row = this.db
      .prepare(`SELECT email_verified FROM users WHERE id = ?`)
      .get(userId) as { email_verified: number } | undefined;
    return Boolean(row?.email_verified);
  }

  adminMarkVerified(userId: string): void {
    this.db
      .prepare(
        `UPDATE users SET email_verified = 1, verify_code = NULL, verify_expires = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), userId);
  }

  changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): { token: string } {
    if (newPassword.length < 6) throw new ApiError("新密码至少 6 位", 400);
    const row = this.db
      .prepare(`SELECT password_hash, password_salt FROM users WHERE id = ?`)
      .get(userId) as { password_hash: string; password_salt: string } | undefined;
    if (!row) throw new ApiError("用户不存在", 404);
    const salt = Buffer.from(row.password_salt, "base64");
    if (!verifyPassword(oldPassword, salt, row.password_hash)) {
      throw new ApiError("旧密码不正确", 401);
    }
    const newSalt = randomBytes(16);
    this.db
      .prepare(
        `UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?`,
      )
      .run(hashPassword(newPassword, newSalt), newSalt.toString("base64"), Date.now(), userId);
    // 吊销全部旧 token
    this.db
      .prepare(`UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
      .run(Date.now(), userId);
    return { token: this.issueToken(userId) };
  }

  logout(token: string): void {
    const th = sha256(token);
    this.db
      .prepare(`UPDATE tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
      .run(Date.now(), th);
  }

  private issueToken(userId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare(`INSERT INTO tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)`)
      .run(sha256(token), userId, Date.now());
    return token;
  }

  auth(token: string): { userId: string; email: string; plan: PlanId } {
    const th = sha256(token);
    const row = this.db
      .prepare(
        `SELECT t.user_id, u.email, u.plan, u.disabled
         FROM tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
      )
      .get(th) as
      | { user_id: string; email: string; plan: string; disabled: number }
      | undefined;
    if (!row) throw new ApiError("无效 token，请重新登录", 401);
    if (row.disabled) throw new ApiError("账号已禁用", 403);
    this.db.prepare(`UPDATE tokens SET last_used_at = ? WHERE token_hash = ?`).run(Date.now(), th);
    return { userId: row.user_id, email: row.email, plan: (row.plan as PlanId) || "free" };
  }

  /** 仅允许 hex userId 目录，防路径穿越 */
  userDir(userId: string): string {
    if (!/^[0-9a-f]{16,64}$/i.test(userId)) throw new ApiError("非法用户标识", 400);
    const d = path.join(this.dataRoot, "users", userId);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  usage(userId: string): { sessions: number; storageMb: number } {
    const dir = this.userDir(userId);
    let sessions = 0;
    let bytes = 0;
    const walk = (d: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".harbor.enc.json")) {
          sessions++;
          bytes += fs.statSync(p).size;
        }
      }
    };
    walk(dir);
    return { sessions, storageMb: Math.round((bytes / 1048576) * 10) / 10 };
  }

  setPlan(userId: string, plan: PlanId): void {
    this.db.prepare(`UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`).run(plan, Date.now(), userId);
  }

  setDisabled(userId: string, disabled: boolean): void {
    this.db
      .prepare(`UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?`)
      .run(disabled ? 1 : 0, Date.now(), userId);
    if (disabled) {
      this.db
        .prepare(`UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
        .run(Date.now(), userId);
    }
  }

  listUsers(): Array<{
    id: string;
    email: string;
    plan: string;
    disabled: number;
    created_at: number;
    email_verified: number;
    sessions: number;
    storageMb: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, email, plan, disabled, created_at, email_verified FROM users ORDER BY created_at DESC`,
      )
      .all() as Array<{
      id: string;
      email: string;
      plan: string;
      disabled: number;
      created_at: number;
      email_verified: number;
    }>;
    return rows.map((r) => {
      const u = this.usage(r.id);
      return { ...r, sessions: u.sessions, storageMb: u.storageMb };
    });
  }

  /** 列出用户密文对象相对路径 */
  listUserObjects(userId: string): Array<{ path: string; bytes: number; mtime: number }> {
    const root = this.userDir(userId);
    const out: Array<{ path: string; bytes: number; mtime: number }> = [];
    const walk = (d: string, prefix: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(d, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(abs, rel);
        else {
          const st = fs.statSync(abs);
          out.push({ path: rel, bytes: st.size, mtime: Math.round(st.mtimeMs) });
        }
      }
    };
    walk(root, "");
    return out;
  }

  stats() {
    const users = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }
    ).n;
    const activeTokens = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL`)
        .get() as { n: number }
    ).n;
    const disabled = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE disabled = 1`).get() as { n: number }
    ).n;
    return { users, disabled, activeTokens, dataRoot: this.dataRoot };
  }
}

/** 相对路径安全：禁止 .. 与绝对路径 */
export function safeRel(rel: string): string {
  const norm = path.posix.normalize(String(rel || "")).replace(/^\/+/, "");
  if (!norm || norm.includes("..") || path.isAbsolute(norm) || norm.includes("\\")) {
    throw new ApiError("非法路径", 400);
  }
  return norm;
}

/** 原子写：tmp + rename，避免并发读到半截文件 */
export function atomicWrite(abs: string, body: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, abs);
}

export function quotaOf(plan: PlanId) {
  return PLANS[plan] || PLANS.free;
}
