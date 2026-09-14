# SessionHarbor Git Hooks

将本目录挂到本地 git hooks（**不会**改全局 git config，只影响本仓库）：

```powershell
# Windows (PowerShell)
Copy-Item scripts/git-hooks/pre-commit .git/hooks/pre-commit -Force
Copy-Item scripts/git-hooks/post-commit .git/hooks/post-commit -Force
# 若需要可执行权限（Git Bash）
# chmod +x .git/hooks/pre-commit .git/hooks/post-commit
```

或在仓库根执行：

```powershell
node scripts/install-git-hooks.mjs
```

## 行为

- **pre-commit**：当暂存区包含 `apps/desktop/**`、`packages/**`、根 `package.json`、`pnpm-lock.yaml`、`scripts/pack-desktop.mjs` 等与功能/修复相关的变更时，自动执行 `pnpm pack:exe`，把新的 `SessionHarbor.exe` 重建到仓库根目录并 `git add` 进本次提交。
- **post-commit**：打印提示，确认 exe 与提交同步。
- 调试时可 `HARBOR_SKIP_PACK=1 git commit ...` 跳过重建。
