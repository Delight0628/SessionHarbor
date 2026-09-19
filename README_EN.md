# SessionHarbor

<p align="center">
  <img src="docs/assets/logo.svg" alt="SessionHarbor Logo" width="120" />
</p>

<h1 align="center">SessionHarbor</h1>

<p align="center">
  <b>One harbor for all your AI client sessions — search, migrate, archive.</b>
</p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="README_EN.md">English</a> ·
  <a href="docs/">Docs</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/Node-%3E%3D22.5-339933?logo=nodedotjs&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-37-47848F?logo=electron&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green" />
</p>

<p align="center">
  <img src="docs/assets/banner.svg" alt="SessionHarbor Banner" width="100%" />
</p>

---

## Why

You talk to many AI clients — Claude Code, Codex, Cursor, MiMo Desktop, WorkBuddy, and more. History is scattered, hard to search, and hard to take with you.

SessionHarbor is a **local-first** layer that discovers sessions on your machine, indexes them, lets you search everything, and migrates conversations **in native client formats** so you can keep working.

## Features

- **Multi-client aggregation** with automatic discovery
- **Full-text search** (SQLite FTS5 + trigram, Chinese-friendly); ~10k sessions indexed in ~3.2s, search < 40ms
- **Native-format migration** via a shared Intermediate Representation (IR)
- **Export** to Markdown / JSON / HTML
- **Incremental watcher** to refresh the index
- **Safe write-back**: backup, transactions, process checks, explicit `--yes`
- **Secrets scan & dedup**
- **Optional cloud sync**: BYO directory / WebDAV (free), hosted cloud with per-user isolation
- **Electron GUI** for browsing, search, and migration

## Supported clients

See the Chinese [README](./README.md#支持的客户端) for the full matrix. Highlights: Claude Code, 领慧 AI, WorkBuddy, Codex, MiMo Desktop, Cursor, VS Code/Trae, Hermes, OpenClaw, ChatGPT export, and more.

## Quick start

Requirements: **Node.js ≥ 22.5**, **pnpm**.

```bash
git clone https://github.com/Delight0628/SessionHarbor.git
cd SessionHarbor
pnpm install
pnpm build
```

Desktop app:

```bash
scripts/start-desktop.bat   # Windows
# or
pnpm desktop
```

CLI:

```bash
node packages/cli/dist/bin.js info
node packages/cli/dist/bin.js list --client claude-code
node packages/cli/dist/bin.js search "your query" --limit 10
node packages/cli/dist/bin.js migrate --from alink --to claude-code --id <sessionId> --dry-run
```

Optional hosted cloud:

```bash
scripts/start-cloud.bat
# http://127.0.0.1:8787
```

## Architecture

Local-first monorepo: `packages/core` (IR, index, migrate, sanitize) + `packages/adapters/*` + `packages/cli` + `packages/cloud-server` + `apps/desktop`.

Details: [docs/项目开发文档.md](./docs/项目开发文档.md) and [docs/](./docs/).

## License

[MIT](./LICENSE) © Delight
