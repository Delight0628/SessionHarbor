/**
 * 统一云后端：有 DATABASE_URL 走 Postgres（Supabase/Neon），否则 SQLite 本地盘
 */

import { CloudDatabase, type PlanId } from "./db.js";
import { PostgresCloudDatabase } from "./db-pg.js";

export type BackendKind = "sqlite" | "postgres";

export interface CloudBackend {
  kind: BackendKind;
  register(email: string, password: string): Promise<{
    userId: string;
    token: string;
    plan: PlanId;
    emailVerified: boolean;
    verifyCode?: string;
  }>;
  login(email: string, password: string): Promise<{
    userId: string;
    token: string;
    plan: PlanId;
    emailVerified: boolean;
  }>;
  changePassword(userId: string, old: string, neo: string): Promise<{ token: string }>;
  logout(token: string): Promise<void>;
  auth(token: string): Promise<{ userId: string; email: string; plan: PlanId }>;
  verifyEmail(email: string, code: string): Promise<{ userId: string; token: string }>;
  resendVerifyCode(email: string): Promise<{ code: string }>;
  isEmailVerified(userId: string): Promise<boolean>;
  adminMarkVerified(userId: string): Promise<void>;
  setPlan(userId: string, plan: PlanId): Promise<void>;
  setDisabled(userId: string, disabled: boolean): Promise<void>;
  listUsers(): Promise<
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
  >;
  usage(userId: string): Promise<{ sessions: number; storageMb: number }>;
  listUserObjects(userId: string): Promise<Array<{ path: string; bytes: number; mtime: number }>>;
  getObject(userId: string, rel: string): Promise<string | null>;
  putObject(userId: string, rel: string, body: string): Promise<void>;
  stats(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function createBackend(dataRoot: string): Promise<CloudBackend> {
  const url = process.env.DATABASE_URL || process.env.PG_URL || "";
  if (url) {
    const pg = new PostgresCloudDatabase(url);
    await pg.init();
    return {
      kind: "postgres",
      register: (e, p) => pg.register(e, p),
      login: (e, p) => pg.login(e, p),
      changePassword: (u, o, n) => pg.changePassword(u, o, n),
      logout: (t) => pg.logout(t),
      auth: (t) => pg.auth(t),
      verifyEmail: (e, c) => pg.verifyEmail(e, c),
      resendVerifyCode: (e) => pg.resendVerifyCode(e),
      isEmailVerified: (u) => pg.isEmailVerified(u),
      adminMarkVerified: (u) => pg.adminMarkVerified(u),
      setPlan: (u, p) => pg.setPlan(u, p),
      setDisabled: (u, d) => pg.setDisabled(u, d),
      listUsers: () => pg.listUsers(),
      usage: (u) => pg.usage(u),
      listUserObjects: (u) => pg.listUserObjects(u),
      getObject: (u, r) => pg.getObject(u, r),
      putObject: (u, r, b) => pg.putObject(u, r, b),
      stats: () => pg.stats(),
      close: () => pg.close(),
    };
  }

  const db = new CloudDatabase(dataRoot);
  return {
    kind: "sqlite",
    register: async (e, p) => db.register(e, p),
    login: async (e, p) => db.login(e, p),
    changePassword: async (u, o, n) => db.changePassword(u, o, n),
    logout: async (t) => {
      db.logout(t);
    },
    auth: async (t) => db.auth(t),
    verifyEmail: async (e, c) => db.verifyEmail(e, c),
    resendVerifyCode: async (e) => db.resendVerifyCode(e),
    isEmailVerified: async (u) => db.isEmailVerified(u),
    adminMarkVerified: async (u) => {
      db.adminMarkVerified(u);
    },
    setPlan: async (u, p) => {
      db.setPlan(u, p);
    },
    setDisabled: async (u, d) => {
      db.setDisabled(u, d);
    },
    listUsers: async () => db.listUsers(),
    usage: async (u) => db.usage(u),
    listUserObjects: async (u) => db.listUserObjects(u),
    getObject: async (u, rel) => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { safeRel } = await import("./db.js");
      const abs = path.join(db.userDir(u), safeRel(rel));
      if (!fs.existsSync(abs)) return null;
      return fs.readFileSync(abs, "utf8");
    },
    putObject: async (u, rel, body) => {
      const path = await import("node:path");
      const { safeRel, atomicWrite } = await import("./db.js");
      const abs = path.join(db.userDir(u), safeRel(rel));
      atomicWrite(abs, body);
    },
    stats: async () => db.stats(),
    close: async () => {
      db.close();
    },
  };
}
