# SessionHarbor Git Hooks

将本目录挂到本地 git hooks（**不会**改全局 git config，只影响本仓库）：

```powershell
# Windows (PowerShell)
Copy-Item scripts/git-hooks/pre-commit .git/hooks/pre-commit -Force
Copy-Item scripts/git-hooks/post-commit .git/hooks/post-commit -Force
```

或在仓库根执行：

```powershell
node scripts/install-git-hooks.mjs
```

## 行为

- **pre-commit（默认跳过打包）**：`SessionHarbor.exe` **不再 git add / 不再入库**。
  - 默认：只提示「便携版走 GitHub Releases」。
  - 可选本地重建（仍不入库）：`HARBOR_PACK_ON_COMMIT=1 git commit ...`
  - 若误把 exe 加入暂存区，钩子会自动移出。
- **post-commit**：提示本地便携版状态与 Release 分发方式。

## 发布便携版

仓库已配置 [`.github/workflows/release.yml`](../../.github/workflows/release.yml)：

1. **打 tag 推送**（推荐）：`git tag v0.3.0 && git push origin v0.3.0` → 自动构建并创建 Release，附带 `SessionHarbor.exe`
2. **手动触发**：GitHub → Actions → Release → Run workflow
3. **本地已打好包时**快速上传：

```powershell
gh release create v0.3.0 .\SessionHarbor.exe --title "SessionHarbor v0.3.0" --notes "便携版"
# 或已有 tag：
gh release upload v0.3.0 .\SessionHarbor.exe --clobber
```

请勿将 `SessionHarbor.exe` 提交进 git（已在 `.gitignore`）。
