import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const root = "D:/SessionHarbor";
const envFile = path.join(root, ".sessionharbor/cloud.env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
process.env.HARBOR_WORKDIR = root;
process.env.PORT = process.env.PORT || process.env.HARBOR_CLOUD_PORT || "8787";
process.env.HARBOR_CLOUD_PORT = process.env.PORT;

const child = spawn(
  process.execPath,
  [path.join(root, "packages/cloud-server/dist/server.js")],
  { cwd: root, env: process.env, stdio: "inherit" }
);
child.on("exit", (code) => process.exit(code ?? 0));
