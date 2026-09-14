# SessionHarbor（会话港湾）

跨 AI 客户端的会话记录统一管理、检索与互迁工具。

> 愿景：让散落在各个 AI 客户端里的对话，成为可检索、可迁移、可共享的个人与团队资产。

## 当前状态（v0.2 / N1–N3 主体完成）

| 能力 | 状态 |
|---|---|
| IR v1 | ✅ |
| 适配器：领慧 / CC / WorkBuddy / Codex / **MiMo** / ChatGPT Export | ✅ 6 客户端 |
| CLI：info/list/scan/search/migrate/export/backup/watch/**secrets**/**dedup** | ✅ |
| FTS5 索引 | ✅ 1 万会话 3.2s，搜索 <40ms |
| 增量 watcher | ✅ |
| Vitest 单测（core 12 用例） | ✅ |
| 综合 E2E（M0 + codex 实写 + chatgpt 导入） | ✅ `scripts/e2e.mjs` |
| 脱敏扫描 + tool 配对统计 | ✅ 挂在 migrate 报告与 `harbor secrets` |
| 去重/分叉检测 | ✅ `harbor dedup` |
| ADR-001 node:sqlite / ADR-002 E2EE / 团队库 / 内网部署 | ✅ 设计稿 |
| Electron GUI（含折叠 tool/thinking） | ✅ |
| 打包分发 electron-builder | 未做 |

## 文档

- [项目开发文档.md](./项目开发文档.md)
- [docs/ADR-001-node-sqlite.md](./docs/ADR-001-node-sqlite.md)
- [docs/ADR-002-e2ee-sync.md](./docs/ADR-002-e2ee-sync.md)
- [docs/team-library-schema.md](./docs/team-library-schema.md)
- [docs/enterprise-deploy.md](./docs/enterprise-deploy.md)

## 目录结构

```
SessionHarbor/
├─ packages/core/           # IR、索引、迁移、脱敏、去重、watcher
├─ packages/adapters/*      # claude-code alink workbuddy codex mimo chatgpt-export
├─ packages/cli/            # harbor 命令
├─ apps/desktop/            # Electron GUI
├─ fixtures/                # 脱敏样本
├─ scripts/e2e.mjs          # 综合 E2E
├─ scripts/bench-index.mjs  # 1 万索引压测
└─ docs/                    # ADR + 设计稿
```

## 快速开始

```powershell
# 构建（Node 22+，使用内置 node:sqlite）
$node = "node"   # 或 $env:MIMO_NODE
$tsc = "node_modules/typescript/lib/tsc.js"  # pnpm 安装后
# 依次编译 core → adapters → cli

# 入口
$harbor = "packages\cli\dist\bin.js"
& $node $harbor info
& $node $harbor list --client alink
& $node $harbor list --client workbuddy --title 白板

# 统一索引与检索
& $node $harbor scan --client alink
& $node $harbor search 迁移 --limit 10

# 导出
& $node $harbor export --client alink --id 00609438 --format md --out out.md
& $node $harbor export --client alink --id 00609438 --format html --out out.html

# 迁移（写入必须 --yes；先 --dry-run）
& $node $harbor migrate --from alink --to claude-code --id <sessionId> --dry-run
& $node $harbor migrate --from alink --to claude-code --id <sessionId> --yes
& $node $harbor migrate --from workbuddy --to alink --limit 2 --dry-run
& $node $harbor migrate --from claude-code --to alink --id <uuid> --yes --overwrite

# 备份
& $node $harbor backup --client alink

# Codex
& $node $harbor list --client codex
& $node $harbor migrate --from codex --to alink --id <uuid> --dry-run

# ChatGPT 官方导出导入（只读源，可迁出到其他客户端）
& $node $harbor list --client chatgpt-export --chatgpt-export path\to\conversations.json
& $node $harbor migrate --from chatgpt-export --to alink --chatgpt-export ... --id <uuid> --yes

# 增量监听（自动刷新索引）
& $node $harbor watch --client claude-code

# MiMo Desktop（本地 mimocode.db）
& $node $harbor list --client mimo
& $node $harbor migrate --from alink --to mimo --id <uuid> --dry-run

# 1 万会话索引压测
& $node scripts\bench-index.mjs

# Electron GUI
pnpm desktop
```

## 源码调研结论（已落地）

### 1. D:\mimo（MiMo ↔ 领慧 Python 迁移器）

- 模块化 `chat_migrator`：paths / models / readers / writers / migrate / cli / gui
- 领慧信封：`{type, sessionId, timestamp, data}`，`type ∈ system|prompt|user|assistant|result|artifact_card`
- MiMo：`mimocode.db` 的 `session → message → part`
- 时间：领慧本地时间串 `YYYY-MM-DD HH:MM:SS`

### 2. D:\WorkBuddyRecommend\chat-migration-tool（WorkBuddy ↔ 领慧）

- 单文件 Python；cwd 编码规则已验证并移植：
  - WorkBuddy：`D:\alink` → `d-alink`（去冒号、分隔符换 `-`、盘符小写）
  - Claude/领慧项目目录：非字母数字全换 `-` → `D--Risk-control`
- WorkBuddy JSONL：`type=message` + `input_text`/`output_text` + ms 时间戳
- 写前备份 + 目标进程检测 + system-reminder 剥离

### 3. 真实 schema（2026-09-11 本机）

- `alink_session(id, sessionId, name, messages, userId, createdAt, updatedAt, cwd, artifacts, isFavorite, sessionType, selectedModelId, agentEngine, …)`
- WorkBuddy `sessions(id, cwd, user_id, title, custom_title, status, created_at/updated_at 毫秒, …)` + `workspaces(path, last_opened_at)`
- Claude Code 行：`{parentUuid, uuid, type, message, timestamp, cwd, gitBranch, version, …}`

## 安全规约（写回）

1. 写前自动备份目标 DB + WAL/SHM 到 `<workdir>/backups/`
2. SQLite 写操作 `BEGIN` 事务，失败 `ROLLBACK`
3. 目标会话已存在时默认跳过，需 `--overwrite`
4. 迁移默认剥离 user 消息中的 `<system-reminder>` 块
5. CLI 写入必须显式 `--yes`（或 `--dry-run`）

## M0 验收

```powershell
& $node scripts\m0-e2e.mjs
```

沙箱拷贝真实库 → 领慧→CC（parentUuid 链完整）→ CC→领慧（信封 + system/init）双向成功。

## 里程碑对照

- **M0**：领慧 ↔ Claude Code 互转 ✅ 沙箱闭环
- **M1**：四客户端聚合 + FTS + 迁移向导（CC↔领慧 双向、→Codex/WorkBuddy）— WorkBuddy 读写已具备；Codex 待做；1 万会话索引性能待压测
- **M2**：Electron GUI、watcher、脱敏扫描
- **M3**：E2EE 云同步、团队库、企业内网版

详见 [项目开发文档.md](./项目开发文档.md)。
