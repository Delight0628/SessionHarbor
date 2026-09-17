import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "apps", "desktop");
const REL = path.join(ROOT, "release", "latest-pack");
const ART = path.join(ROOT, "release", "artifacts");
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = rootPkg.version || "0.2.7";

const electronDist = fs
  .readdirSync(path.join(ROOT, "node_modules", ".pnpm"))
  .filter((n) => n.startsWith("electron@"))
  .map((n) => path.join(ROOT, "node_modules", ".pnpm", n, "node_modules", "electron", "dist"))
  .find((p) => fs.existsSync(path.join(p, "electron.exe")));
if (!electronDist) throw new Error("electron dist not found");

fs.rmSync(REL, { recursive: true, force: true });
fs.mkdirSync(REL, { recursive: true });
fs.mkdirSync(ART, { recursive: true });

const desktopPkgPath = path.join(DESKTOP, "package.json");
const orig = fs.readFileSync(desktopPkgPath, "utf8");
fs.writeFileSync(desktopPkgPath + ".keep", orig);
fs.writeFileSync(
  desktopPkgPath,
  JSON.stringify(
    {
      name: "sessionharbor-desktop",
      version,
      private: true,
      description: "SessionHarbor",
      main: "dist/main.cjs",
      author: "SessionHarbor",
      license: "MIT",
    },
    null,
    2,
  ),
);

const cfg = {
  appId: "com.sessionharbor.desktop",
  productName: "SessionHarbor",
  copyright: "Copyright (c) SessionHarbor",
  directories: { output: REL, buildResources: path.join(DESKTOP, "build") },
  files: ["dist/main.cjs", "dist/preload.cjs", "renderer/**/*", "package.json"],
  asar: true,
  electronVersion: "37.10.3",
  electronDist,
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  win: {
    target: [{ target: "portable", arch: ["x64"] }],
    artifactName: "SessionHarbor-${version}-win-x64.exe",
  },
  portable: {
    artifactName: "SessionHarbor-${version}-win-x64.exe",
  },
};
const cfgPath = path.join(DESKTOP, "electron-builder.json");
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

const eb =
  [
    path.join(ROOT, "node_modules", "electron-builder", "out", "cli", "cli.js"),
    path.join(ROOT, "node_modules", "electron-builder", "cli.js"),
  ].find((p) => fs.existsSync(p)) ||
  path.join(
    ROOT,
    "node_modules",
    ".pnpm",
    "electron-builder@26.15.3_el_710da1212b3b8a5016a87838cb1230b1",
    "node_modules",
    "electron-builder",
    "cli.js",
  );

console.log("version", version);
console.log("electronDist", electronDist);
console.log("eb", eb);

const r = spawnSync(
  process.execPath,
  [eb, "--win", "portable", "--config", cfgPath, "--publish", "never"],
  { cwd: DESKTOP, stdio: "inherit", env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" } },
);

// restore desktop package.json
if (fs.existsSync(desktopPkgPath + ".keep")) {
  fs.copyFileSync(desktopPkgPath + ".keep", desktopPkgPath);
  fs.unlinkSync(desktopPkgPath + ".keep");
}
try {
  fs.unlinkSync(cfgPath);
} catch {
  /* ignore */
}

if (r.status !== 0) {
  console.error("electron-builder failed", r.status);
  process.exit(r.status || 1);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (!/win-unpacked|unpacked/i.test(n)) walk(p, out);
    } else if (/\.exe$/i.test(n) && !/unpacked/i.test(p)) {
      out.push(p);
    }
  }
  return out;
}

const found = walk(REL);
console.log("found", found);
const preferred = found.find((p) => p.includes("win-x64")) || found[0];
if (!preferred) throw new Error("no portable exe");
console.log("preferred", preferred, fs.statSync(preferred).size);

const rootExe = path.join(ROOT, "SessionHarbor.exe");
try {
  spawnSync("taskkill", ["/IM", "SessionHarbor.exe", "/F"], { stdio: "ignore", shell: true });
} catch {
  /* ignore */
}
fs.copyFileSync(preferred, rootExe);
const dest = path.join(ART, path.basename(preferred));
fs.copyFileSync(preferred, dest);
console.log("root", rootExe, (fs.statSync(rootExe).size / 1024 / 1024).toFixed(1), "MB");
console.log("artifacts", dest);
