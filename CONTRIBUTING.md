# 贡献指南

感谢你对 SessionHarbor 的关注。欢迎提交 Issue、讨论设计、改进文档或贡献代码。

## 行为准则

参与本项目即表示你同意遵守 [行为准则](./CODE_OF_CONDUCT.md)。

## 如何贡献

### 报告问题

请使用 [Issue 模板](.github/ISSUE_TEMPLATE/)，尽量提供：

- 操作系统与 Node 版本
- 相关客户端及版本（如 Claude Code / Codex / MiMo）
- 复现步骤与期望行为
- 日志或错误堆栈（请脱敏密钥、token、绝对路径中的用户名）

### 改进文档

文档与代码同等重要。README、`docs/`、适配器说明中的错别字、过时命令、缺步骤，都可以直接 PR。

### 新增客户端适配器

这是最有价值的贡献类型之一。

1. 在 `packages/adapters/<client-id>/` 新建包，实现统一 `Adapter` 接口：
   - `discover()`：探测安装与数据目录
   - `listSessions()` / `readSession()` → Harbor IR
   - `writeSession()`：按目标私有格式落地（只读源可声明 `capabilities.write = false`）
2. 在 CLI / Desktop 的客户端注册表中接入新 id
3. 提供脱敏 `fixtures` 样本（勿提交真实密钥或个人对话）
4. 更新：
   - 根目录 `README.md` 支持矩阵
   - `docs/项目开发文档.md` 相关章节
5. 尽量补充 E2E 或脚本级验证

### 修复与功能

- 先开 Issue 说明动机（小修复可直接 PR）
- 保持 monorepo 包边界清晰：`core` 不依赖具体客户端格式
- 写回路径必须遵守安全规约：备份、事务、显式 `--yes`
- 新增能力请补测试或至少可复现的脚本验证

## 开发环境

```bash
# Node >= 22.5，pnpm
pnpm install
pnpm build
pnpm unit
pnpm e2e
```

### 本地验证桌面端

```bash
# 必须在仓库根或 apps/desktop 下启动
scripts/start-desktop.bat
# 或
pnpm desktop
```

Electron 下载失败时可设置镜像后再执行 `apps/desktop/node_modules/electron/install.js`。

### 提交信息

建议使用清晰的中文或英文祈使句，说明「为什么」而不仅是「改了什么」。例如：

```text
修复 WorkBuddy 迁移时 tool_result 配对丢失
新增 OpenClaw 只读适配器与脱敏 fixtures
```

### Pull Request

- 一个 PR 聚焦一件事
- 描述变更动机、方案与验证方式
- 若涉及迁移/写库，说明备份与回滚策略
- 保持工作区可构建、测试通过

## 安全相关

请勿在 Issue / PR / fixtures 中粘贴真实密钥。安全漏洞请按 [SECURITY.md](./SECURITY.md) 私下报告。

## 许可证

贡献代码默认以 [MIT License](./LICENSE) 授权给本项目使用。
