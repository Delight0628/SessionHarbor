# ADR-001：本地索引使用 node:sqlite 而非 better-sqlite3

| 项 | 内容 |
|---|---|
| 状态 | Accepted（2026-09-14） |
| 决策者 | 高国兴 |
| 影响 | packages/core/src/{db,index-store}.ts；CLI scan/search；Electron GUI scan |

## 背景

SessionHarbor 需要 SQLite + FTS5（trigram 中文分词）做本地会话索引。原计划 better-sqlite3（成熟、性能好），但它是 **native addon**，在企业内网/无编译工具链的 Windows 机器上安装失败率高，与「零原生依赖、内网友好」目标冲突。

Node 22.5+ 内置 `node:sqlite`（`DatabaseSync`），零编译、零下载二进制。当前压测：1 万会话 bulk 索引 3.2s、搜索 <40ms，满足 M1 验收（<30s / <200ms）。

## 决策

**继续使用 `node:sqlite`，不引入 better-sqlite3。**

约束与配套措施：

1. `package.json` `engines.node: ">=22.5.0"` 已锁定；README 与入职文档注明。
2. 代码中仅使用稳定 API：`DatabaseSync` / `prepare` / `run` / `get` / `all` / `exec`，避免实验特性。
3. 若未来需要 Node 旧版本兼容或更高并发性能，再评估 better-sqlite3 作为 **可选后端**（接口已集中在 `db.ts` / `index-store.ts`，替换成本可控）。
4. 实验特性警告（`node:sqlite` ExperimentalWarning）可接受；在 CLI 入口 suppress 仅当影响体验时再做，不作为当前阻塞项。

## 后果

- ✅ 内网/离线安装零障碍，无 node-gyp / VS Build Tools 依赖
- ✅ 压测达标，FTS5 trigram 中文检索可用
- ⚠️ 依赖 Node ≥22.5（Electron 37 / 现代 Node 均满足）
- ⚠️ 若未来 API 变更需跟进（Node 官方将逐步稳定该模块）

## 备选

| 方案 | 结论 |
|---|---|
| better-sqlite3 | 性能略优，但原生编译是分发阻塞；否决 |
| sql.js（纯 JS SQLite） | FTS5 支持与性能不足；否决 |
| FTS 走 lucene/Tantivy 绑定 | 又是原生依赖；否决 |
