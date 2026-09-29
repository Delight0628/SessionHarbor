/**
 * 打包 SessionHarbor 桌面端（按当前平台）
 * Windows → portable exe
 * macOS   → dmg + zip
 * Linux   → AppImage + tar.gz
 *
 * 用法: node scripts/pack-desktop.mjs
 * 环境: 仓库根已 pnpm install
 * 产物: release/artifacts/ 下的安装包
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "apps", "desktop");
const RELEASE = path.join(ROOT, "release", `pack-${Date.now()}`);
const ARTIFACTS = path.join(ROOT, "release", "artifacts");
const platform = process.platform; // win32 | darwin | linux

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const hasLocalElectron = Boolean(findElectronDist());
  const isCi = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ELECTRON_SKIP_BINARY_DOWNLOAD: hasLocalElectron
        ? process.env.ELECTRON_SKIP_BINARY_DOWNLOAD ?? "1"
        : "0",
      ...(isCi
        ? {}
        : {
            npm_config_offline: "true",
            npm_config_prefer_offline: "true",
          }),
      ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES: "true",
      // 未签名时避免 macOS/Windows 卡在证书探测
      CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? "false",
      CSC_LINK: process.env.CSC_LINK ?? "",
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
  const exeName = process.platform === "win32" ? "electron.exe" : "electron";
  const hits = fs
    .readdirSync(pnpmDir)
    .filter((n) => n.startsWith("electron@"))
    .map((n) => path.join(pnpmDir, n, "node_modules", "electron", "dist", exeName))
    .filter((p) => fs.existsSync(p));
  if (hits[0]) return hits[0];
  const alt = path.join(DESKTOP, "node_modules", "electron", "dist", exeName);
  return fs.existsSync(alt) ? alt : undefined;
}

function platformTargets() {
  if (platform === "win32") {
    return {
      ebArgs: ["--win", "portable"],
      config: {
        win: {
          target: [{ target: "portable", arch: ["x64"] }],
          artifactName: "SessionHarbor-${version}-win-x64.exe",
        },
        portable: {
          artifactName: "SessionHarbor-${version}-win-x64.exe",
        },
      },
      label: "win-x64",
    };
  }
  if (platform === "darwin") {
    return {
      ebArgs: ["--mac", "dmg", "zip"],
      config: {
        mac: {
          target: [
            { target: "dmg", arch: ["x64", "arm64"] },
            { target: "zip", arch: ["x64", "arm64"] },
          ],
          category: "public.app-category.productivity",
          artifactName: "SessionHarbor-${version}-mac-${arch}.${ext}",
          identity: null,
        },
        dmg: {
          artifactName: "SessionHarbor-${version}-mac-${arch}.${ext}",
        },
      },
      label: "mac",
    };
  }
  // linux
  return {
    ebArgs: ["--linux", "AppImage", "tar.gz"],
    config: {
      linux: {
        target: [
          { target: "AppImage", arch: ["x64"] },
          { target: "tar.gz", arch: ["x64"] },
        ],
        category: "Utility",
        artifactName: "SessionHarbor-${version}-linux-${arch}.${ext}",
      },
    },
    label: "linux-x64",
  };
}

function findArtifacts(dir, depth = 0) {
  if (depth > 4 || !fs.existsSync(dir)) return [];
  const out = [];
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) {
      if (/unpacked|__macosx|\.app/i.test(n.name)) continue;
      out.push(...findArtifacts(p, depth + 1));
    } else if (/\.(exe|dmg|zip|AppImage|tar\.gz)$/i.test(n.name)) {
      if (/blockmap|\.yml$/i.test(n.name)) continue;
      out.push(p);
    }
  }
  return out;
}

async function main() {
  console.log("== SessionHarbor pack ==");
  console.log("ROOT:", ROOT, "platform:", platform);

  const filters = [
    "@sessionharbor/core",
    "@sessionharbor/adapter-*",
    "@sessionharbor/cli",
    "@sessionharbor/cloud-server",
    "@sessionharbor/desktop",
  ];
  for (const f of filters) {
    run("pnpm", ["--filter", f, "build"]);
  }

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

  const preloadSrc = path.join(DESKTOP, "src", "preload.cjs");
  fs.copyFileSync(preloadSrc, path.join(DESKTOP, "dist", "preload.cjs"));

  const desktopPkgPath = path.join(DESKTOP, "package.json");
  const desktopPkg = JSON.parse(fs.readFileSync(desktopPkgPath, "utf-8"));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  const version = rootPkg.version || desktopPkg.version || "0.1.0";
  const packPkg = {
    name: "sessionharbor-desktop",
    version,
    private: true,
    description: "SessionHarbor — 跨 AI 客户端会话统一管理",
    main: "dist/main.cjs",
    author: "SessionHarbor",
    license: "MIT",
  };
  const backupPkg = path.join(DESKTOP, "package.json.devbackup");
  fs.copyFileSync(desktopPkgPath, backupPkg);
  fs.writeFileSync(desktopPkgPath, JSON.stringify(packPkg, null, 2));

  try {
    fs.mkdirSync(RELEASE, { recursive: true });
    fs.mkdirSync(ARTIFACTS, { recursive: true });

    const electronVer =
      desktopPkg.devDependencies?.electron?.replace(/^[\^~]/, "") || "37.10.3";
    const { ebArgs, config: platConfig } = platformTargets();

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
      electronDist: (() => {
        const exe = findElectronDist();
        return exe ? path.dirname(exe) : undefined;
      })(),
      npmRebuild: false,
      nodeGypRebuild: false,
      buildDependenciesFromSource: false,
      ...platConfig,
    };

    const cfgPath = path.join(DESKTOP, "electron-builder.json");
    fs.writeFileSync(cfgPath, JSON.stringify(ebConfig, null, 2));

    const ebCli = [
      path.join(ROOT, "node_modules", "electron-builder", "out", "cli", "cli.js"),
      path.join(ROOT, "node_modules", "electron-builder", "cli.js"),
    ].find((p) => fs.existsSync(p));
    if (!ebCli) throw new Error("未找到 electron-builder CLI，请先 pnpm install");
    console.log("electron-builder CLI:", ebCli);

    run("node", [ebCli, ...ebArgs, "--config", cfgPath, "--publish", "never"], {
      cwd: DESKTOP,
    });

    const found = findArtifacts(RELEASE);
    if (!found.length) throw new Error("未找到打包产物");
    console.log("artifacts found:");
    for (const f of found) console.log(" -", f);

    // Windows 保留根目录 SessionHarbor.exe 兼容旧路径
    if (platform === "win32") {
      const preferred =
        found.find((p) => p.endsWith(".exe") && !p.includes("unpacked")) || found[0];
      try {
        spawnSync("taskkill", ["/IM", "SessionHarbor.exe", "/F"], {
          stdio: "ignore",
          shell: true,
        });
      } catch {
        /* ignore */
      }
      const rootExe = path.join(ROOT, "SessionHarbor.exe");
      for (let i = 0; i < 6; i++) {
        try {
          fs.copyFileSync(preferred, rootExe);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      console.log("SessionHarbor.exe:", rootExe, (fs.statSync(rootExe).size / 1024 / 1024).toFixed(1), "MB");
    }

    for (const f of found) {
      const dest = path.join(ARTIFACTS, path.basename(f));
      fs.copyFileSync(f, dest);
      console.log("→", dest);
    }

    console.log(`\n== 完成 (${platform}) ==`);
    console.log("产物目录:", ARTIFACTS);
  } finally {
    if (fs.existsSync(backupPkg)) {
      fs.copyFileSync(backupPkg, desktopPkgPath);
      fs.unlinkSync(backupPkg);
    }
    try {
      fs.rmSync(RELEASE, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
