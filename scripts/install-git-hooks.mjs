/** 安装仓库本地 git hooks（复制 scripts/git-hooks/* → .git/hooks/） */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "scripts", "git-hooks");
const DST = path.join(ROOT, ".git", "hooks");

if (!fs.existsSync(DST)) {
  console.error("未找到 .git/hooks，请确认在 git 仓库内执行");
  process.exit(1);
}

for (const name of ["pre-commit", "post-commit"]) {
  const from = path.join(SRC, name);
  const to = path.join(DST, name);
  if (!fs.existsSync(from)) {
    console.error("缺少钩子源文件:", from);
    process.exit(1);
  }
  fs.copyFileSync(from, to);
  // Git for Windows 通常不依赖 +x，但保留
  try {
    fs.chmodSync(to, 0o755);
  } catch {
    /* ignore */
  }
  console.log("已安装:", to);
}
console.log("完成。之后功能/修复提交会自动重建 SessionHarbor.exe。");
