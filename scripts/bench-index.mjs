/**
 * 1 万会话 FTS 索引压测
 * 生成合成 HarborIR → 批量 upsert → 测索引耗时与搜索延迟
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const N = Number(process.env.HARBOR_BENCH_N || 10000);
const OUT = path.join(ROOT, ".sessionharbor", "bench-index.db");

const SAMPLE_WORDS = [
  "迁移", "会话", "索引", "搜索", "Claude", "Codex", "WorkBuddy", "领慧",
  "数据库", "JSONL", "适配器", "备份", "脱敏", "Electron", "FTS5", "trigram",
  "部署", "风控", "发票", "钉钉", "PRD", "性能", "优化", "重构",
];

function makeBody(i) {
  const parts = [];
  for (let k = 0; k < 20; k++) {
    const w1 = SAMPLE_WORDS[(i + k) % SAMPLE_WORDS.length];
    const w2 = SAMPLE_WORDS[(i * 3 + k) % SAMPLE_WORDS.length];
    parts.push(`第${k}轮关于${w1}与${w2}的讨论，会话编号${i}。测试正文片段，用于中英文混合索引。`);
  }
  return parts.join("\n");
}

async function run() {
  const { SessionIndex } = await import(
    pathToFileURL(path.join(ROOT, "packages/core/dist/index.js")).href
  );
  fs.rmSync(OUT, { force: true });
  fs.rmSync(OUT + "-wal", { force: true });
  fs.rmSync(OUT + "-shm", { force: true });

  const index = new SessionIndex(OUT);
  console.log(`生成并索引 ${N} 个合成会话…`);
  const t0 = Date.now();
  index.beginBulkRebuild();
  for (let i = 0; i < N; i++) {
    const id = `ses_bench_${String(i).padStart(6, "0")}`;
    const title = `压测会话 ${i} ${SAMPLE_WORDS[i % SAMPLE_WORDS.length]}`;
    index.upsert({
      sessionId: id,
      sourceClient: i % 2 === 0 ? "alink" : "claude-code",
      title,
      cwd: `D:\\bench\\proj${i % 50}`,
      createdAtMs: Date.now() - i * 60_000,
      updatedAtMs: Date.now() - i * 30_000,
      body: makeBody(i),
    });
    if (i > 0 && i % 2000 === 0) {
      index.commit();
      index.begin();
      const el = Date.now() - t0;
      console.log(`  ${i}/${N}  ${el}ms  (${Math.round((i / el) * 1000)} sessions/s)`);
    }
  }
  index.endBulkRebuild();
  const indexMs = Date.now() - t0;
  const size = fs.statSync(OUT).size;
  console.log(`\n索引完成: ${N} 会话 / ${indexMs}ms (${Math.round((N / indexMs) * 1000)} sessions/s)`);
  console.log(`索引库大小: ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`count=${index.count()}`);

  // 搜索压测
  const queries = ["迁移", "钉钉", "性能优化", "Claude", "会话编号", "xyz不存在词"];
  console.log("\n搜索延迟:");
  for (const q of queries) {
    const t = process.hrtime.bigint();
    const hits = index.search(q, { limit: 10 });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    console.log(`  「${q}」→ ${hits.length} hits  ${ms.toFixed(2)}ms`);
  }
  index.close();
  console.log(`\n目标: 1万+ 会话索引 < 30s；搜索 < 200ms`);
  if (indexMs < 30_000) console.log("✅ 索引性能达标");
  else console.log("⚠️ 索引超 30s");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
