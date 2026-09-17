/**
 * 测试 Supabase 连接（Session pooler + Direct 两种 URI）
 */
import pg from "pg";

const password = process.env.SB_PASSWORD || "";
const ref = "hnrvuzgljxwixspbwgaw";
const candidates = [
  `postgresql://postgres.${ref}:${password}@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require`,
  `postgresql://postgres.${ref}:${password}@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require`,
  `postgresql://postgres:${password}@db.${ref}.supabase.co:5432/postgres?sslmode=require`,
];

for (const url of candidates) {
  const label = url.replace(/:[^:@/]+@/, ":***@");
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 15000, max: 1 });
  try {
    const r = await pool.query("select version(), current_database()");
    console.log("OK", label);
    console.log("  ", r.rows[0]);
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.log("FAIL", label);
    console.log("  ", e.message);
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
  }
}
process.exit(1);
