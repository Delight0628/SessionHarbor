# 更新日志

本项目遵循「保持变更日志」的精神；版本号语义从正式发版后采用 SemVer。当前处于快速迭代期，以里程碑与日期记录。

## [Unreleased]

### Added

- GitHub 仓库展示面：README 重写、社区文档、Issue/PR 模板、CI 工作流
- Hermes / OpenClaw / Cursor / VS Code / Trae 等适配器
- 托管云服务端（注册登录鉴权与按用户数据隔离）
- Windows 便携版打包脚本 `pnpm pack:exe`

### Changed

- `SessionHarbor.exe` 不再入库；便携版改由 GitHub Releases 分发（tag / Actions Release）
- pre-commit 默认不再打包并 `git add` exe；可选 `HARBOR_PACK_ON_COMMIT=1` 仅本地重建
- 开发权威文档统一放在 `docs/项目开发文档.md`（根目录不再单独放置）
- `pnpm-workspace.yaml` 的 `allowBuilds` 配置修正
- WorkBuddy 迁移保留工具调用/思考/产物，并改进「已存在」提示
- 领慧迁入后 `agentEngine` 强制为 claude，修复历史会话过期

### Fixed

- Electron 桌面端错误目录启动问题（提供 `scripts/start-desktop.bat`）
- 云同步指纹计算的 TypeScript 类型收窄问题

## [0.2.0] - 2026-09-14

### Added

- 多客户端聚合与 FTS5 统一搜索
- CLI：info / list / scan / search / migrate / export / backup / watch / secrets / dedup
- Electron GUI（分组侧栏、折叠 tool/thinking、云推送拉取）
- 云同步客户端闭环（BYO 目录 / WebDAV / 托管云）
- Vitest 单测与综合 E2E、索引压测脚本

### Notes

- 本地层永久免费；托管云套餐见 README
