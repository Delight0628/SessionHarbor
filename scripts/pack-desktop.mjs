/**
 * 一键打包 SessionHarbor 桌面端为 Windows 可执行文件
 * 产物: <repo>/SessionHarbor.exe（便携版单文件）
 *
 * 用法: node scripts/pack-desktop.mjs
 * 环境: 已 pnpm install；会先 tsc 构建各包，再 esbuild 打包主进程，再 electron-builder
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "apps", "desktop");
// 每次使用独立输出目录，避免 Windows 上 asar/资源被占用导致 EBUSY
const RELEASE = path.join(ROOT, "release", `pack-${Date.now()}`);
const EXE_OUT = path.join(ROOT, "SessionHarbor.exe");

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
    ...process.env,
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    npm_config_offline: "true",
    npm_config_prefer_offline: "true",
    ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES: "true",
    ...opts.env,
  },
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} failed with code ${r.status}`);
  }
}

function findElectronDist() {
  const pnpmDir = path.join(ROOT, "node_modules", ".pnpm");
  if (!fs.existsSync(pnpmDir)) return undefined;
  const hits = fs
    .readdirSync(pnpmDir)
    .filter((n) => n.startsWith("electron@"))
    .map((n) => path.join(pnpmDir, n, "node_modules", "electron", "dist", "electron.exe"))
    .filter((p) => fs.existsSync(p));
  return hits[0];
}

async function main() {
  console.log("== SessionHarbor pack ==");
  console.log("ROOT:", ROOT);

  // 1) 构建全部 workspace 包
  run("pnpm", ["-r", "build"]);

  // 2) esbuild 打包主进程（内联全部 @sessionharbor/*，排除 electron）
  const mainBundle = path.join(DESKTOP, "dist", "main.cjs");
  run("pnpm", [
    "exec",
    "esbuild",
    path.join(DESKTOP, "src", "main.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node22",
    "--external:electron",
    "--outfile=" + mainBundle,
  ]);

  // preload + renderer 已在源目录
  const preloadSrc = path.join(DESKTOP, "src", "preload.cjs");
  const preloadDst = path.join(DESKTOP, "dist", "preload.cjs");
  fs.copyFileSync(preloadSrc, preloadDst);

  // 3) 写临时 package.json（main 指向 cjs bundle）
  const desktopPkgPath = path.join(DESKTOP, "package.json");
  const desktopPkg = JSON.parse(fs.readFileSync(desktopPkgPath, "utf-8"));
  const packPkg = {
    name: "sessionharbor-desktop",
    version: desktopPkg.version || "0.1.0",
    private: true,
    description: "SessionHarbor — 跨 AI 客户端会话统一管理",
    main: "dist/main.cjs",
    author: "SessionHarbor",
    license: "MIT",
  };
  const packPkgPath = path.join(DESKTOP, "package.pack.json");
  // electron-builder 读目录下 package.json；临时覆盖
  const backupPkg = path.join(DESKTOP, "package.json.devbackup");
  fs.copyFileSync(desktopPkgPath, backupPkg);
  fs.writeFileSync(desktopPkgPath, JSON.stringify(packPkg, null, 2));

  try {
    // 4) electron-builder 便携版
    fs.mkdirSync(RELEASE, { recursive: true });
    const electronVer =
      JSON.parse(
        fs.readFileSync(
          path.join(ROOT, "apps", "desktop", "package.json.devbackup"),
          "utf-8",
        ),
      ).devDependencies?.electron?.replace(/^[\^~]/, "") || "37.10.3";

    const ebConfig = {
      appId: "com.sessionharbor.desktop",
      productName: "SessionHarbor",
      copyright: "Copyright © SessionHarbor",
      directories: {
        output: RELEASE,
        buildResources: path.join(DESKTOP, "build"),
      },
      files: ["dist/main.cjs", "dist/preload.cjs", "renderer/**/*", "package.json"],
      asar: true,
      electronVersion: electronVer,
      // 使用本地已下载的 electron dist，避免重复下载
      electronDist: (() => {
        const exe = findElectronDist();
        return exe ? path.dirname(exe) : undefined;
      })(),
      win: {
        target: [
          {
            target: "portable",
            arch: ["x64"],
          },
        ],
        artifactName: "SessionHarbor-${version}.exe",
      },
      portable: {
        artifactName: "SessionHarbor-${version}.exe",
      },
      npmRebuild: false,
      nodeGypRebuild: false,
      buildDependenciesFromSource: false,
    };
    const cfgPath = path.join(DESKTOP, "electron-builder.json");
    fs.writeFileSync(cfgPath, JSON.stringify(ebConfig, null, 2));

    run("pnpm", [
      "exec",
      "electron-builder",
      "--win",
      "portable",
      "--config",
      "electron-builder.json",
      "--publish",
      "never",
    ], { cwd: DESKTOP });

    // 5) 拷贝到仓库根目录
    const candidates = [];
    const walk = (dir, depth = 0) => {
      if (depth > 3 || !fs.existsSync(dir)) return;
      for (const n of fs.readdirSync(dir)) {
        const p = path.join(dir, n);
        if (n.toLowerCase().endsWith(".exe") && fs.statSync(p).isFile()) {
          candidates.push(p);
        } else if (fs.statSync(p).isDirectory() && !n.startsWith("win-unpacked")) {
          // portable 输出可能在 release 根
        }
      }
    };
    walk(RELEASE);
    // 也扫 release 根下直接的 exe
    for (const n of fs.readdirSync(RELEASE)) {
      if (n.toLowerCase().endsWith(".exe")) {
        candidates.push(path.join(RELEASE, n));
      }
    }
    // win-unpacked 里的主程序也可作为回退
    const unpacked = path.join(RELEASE, "win-unpacked", "SessionHarbor.exe");
    if (fs.existsSync(unpacked)) candidates.push(unpacked);

    const unique = [...new Set(candidates)];
    // 优先 portable 单文件（体积更大但可双击）
    const portable =
      unique.find((p) => /portable|SessionHarbor-0\./i.test(path.basename(p))) ||
      unique.find((p) => !p.includes("win-unpacked")) ||
      unique[0];
    if (!portable) throw new Error("未找到打包产物 .exe");

    // 结束正在运行的 SessionHarbor，避免根目录 exe 被占用
    try {
      spawnSync("taskkill", ["/IM", "SessionHarbor.exe", "/F"], {
        stdio: "ignore",
        shell: true,
      });
    } catch {
      /* ignore */
    }

    const tmpOut = EXE_OUT + ".new";
    let copied = false;
    for (let i = 0; i < 8 && !copied; i++) {
      try {
        fs.copyFileSync(portable, tmpOut);
        fs.renameSync(tmpOut, EXE_OUT);
        copied = true;
      } catch (e) {
        if (i === 7) throw e;
        console.log(`copy SessionHarbor.exe 失败，重试 ${i + 1}/7…`);
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    const sizeMb = (fs.statSync(EXE_OUT).size / 1024 / 1024).toFixed(1);
    console.log(`\n== 完成 ==`);
    console.log(`产物: ${EXE_OUT} (${sizeMb} MB)`);
    console.log(`来源: ${portable}`);
    // 尽力清理本次输出目录（失败则留给下次/手动清理）
    try {
      fs.rmSync(RELEASE, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  } finally {
    // 恢复 workspace package.json
    if (fs.existsSync(backupPkg)) {
      fs.copyFileSync(backupPkg, desktopPkgPath);
      fs.unlinkSync(backupPkg);
    }
    try {
      fs.unlinkSync(packPkgPath);
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
