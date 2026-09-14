/** 路径发现：自动定位各客户端本地数据目录 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClientPaths {
  id: string;
  dataRoot: string;
  primaryDb?: string;
  jsonlDir?: string;
  projectsRoot?: string;
  extraDbs: string[];
}

function expand(p: string): string {
  return path.resolve(p.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? `%${k}%`).replace(/^~(?=$|[\\/])/, os.homedir()));
}

function candidateHomes(): string[] {
  const homes = new Set<string>();
  for (const k of ["USERPROFILE", "HOME"]) {
    if (process.env[k]) homes.add(process.env[k]!);
  }
  homes.add(os.homedir());
  for (const k of ["APPDATA", "LOCALAPPDATA"]) {
    if (process.env[k]) {
      const p = process.env[k]!;
      homes.add(p);
      homes.add(path.dirname(p));
      homes.add(path.dirname(path.dirname(p)));
    }
  }
  return [...homes];
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function findAlinkDb(explicit?: string): string | undefined {
  if (explicit) {
    const p = expand(explicit);
    return exists(p) ? p : undefined;
  }
  const hits: string[] = [];
  const names = ["alink", "领慧AI工作台", "linghui", "LingHui"];
  for (const root of candidateHomes()) {
    for (const name of names) {
      const dir = path.join(root, name);
      if (!exists(dir) || !fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (/^messages_.*\.sqlite$/i.test(f)) hits.push(path.join(dir, f));
      }
    }
  }
  if (!hits.length) return undefined;
  hits.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return hits[0];
}

export function findClaudeProjectsRoot(explicit?: string): string | undefined {
  if (explicit) {
    const p = expand(explicit);
    return exists(p) ? p : undefined;
  }
  const homes = [os.homedir(), process.env.USERPROFILE].filter(Boolean) as string[];
  for (const h of homes) {
    const p = path.join(h, ".claude", "projects");
    if (exists(p)) return p;
  }
  return undefined;
}

export function findWorkbuddyDb(explicit?: string): string | undefined {
  if (explicit) {
    const p = expand(explicit);
    return exists(p) ? p : undefined;
  }
  const homes = [os.homedir(), process.env.USERPROFILE].filter(Boolean) as string[];
  for (const h of homes) {
    const p = path.join(h, ".workbuddy", "workbuddy.db");
    if (exists(p)) return p;
  }
  return undefined;
}

export function findMimoDb(explicit?: string): string | undefined {
  if (explicit) {
    const p = expand(explicit);
    return exists(p) ? p : undefined;
  }
  const hits: string[] = [];
  const rels = [
    path.join(".local", "share", "mimocode", "mimocode.db"),
    path.join("AppData", "Local", "mimocode", "mimocode.db"),
    path.join("AppData", "Roaming", "mimocode", "mimocode.db"),
    path.join("Application Data", "mimocode", "mimocode.db"),
  ];
  for (const root of candidateHomes()) {
    for (const rel of rels) {
      const p = path.join(root, rel);
      if (exists(p)) hits.push(p);
    }
  }
  if (!hits.length) return undefined;
  hits.sort((a, b) => {
    const la = a.includes(".local") ? 0 : 1;
    const lb = b.includes(".local") ? 0 : 1;
    if (la !== lb) return la - lb;
    return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
  });
  return hits[0];
}

export function discoverAlink(explicitDb?: string): ClientPaths {
  const db = findAlinkDb(explicitDb);
  if (!db) {
    throw new Error(
      "未找到领慧AI工作台数据库 messages_*_PROD.sqlite，可用 --alink-db 指定",
    );
  }
  const dataRoot = path.dirname(db);
  const jsonlDir = path.join(dataRoot, "user", "messages");
  const extraDbs: string[] = [];
  try {
    for (const f of fs.readdirSync(dataRoot)) {
      if (/^provider_.*\.sqlite$/i.test(f) || f === "user_PROD.sqlite") {
        extraDbs.push(path.join(dataRoot, f));
      }
    }
  } catch {
    /* ignore */
  }
  return {
    id: "alink",
    dataRoot,
    primaryDb: db,
    jsonlDir: exists(jsonlDir) ? jsonlDir : undefined,
    extraDbs,
  };
}

export function discoverClaudeCode(explicitRoot?: string): ClientPaths {
  const root = findClaudeProjectsRoot(explicitRoot);
  if (!root) {
    throw new Error(
      "未找到 Claude Code 会话目录 ~/.claude/projects，可用 --claude-projects 指定",
    );
  }
  return {
    id: "claude-code",
    dataRoot: path.dirname(root),
    projectsRoot: root,
    extraDbs: [],
  };
}

export function discoverWorkbuddy(explicitDb?: string): ClientPaths {
  const db = findWorkbuddyDb(explicitDb);
  if (!db) {
    throw new Error("未找到 workbuddy.db，可用 --wb-db 指定");
  }
  const root = path.dirname(db);
  const projects = path.join(root, "projects");
  return {
    id: "workbuddy",
    dataRoot: root,
    primaryDb: db,
    projectsRoot: exists(projects) ? projects : undefined,
    extraDbs: [],
  };
}

/** WorkBuddy cwd 编码：D:\alink -> d-alink */
export function wbCwdEncode(cwd: string): string {
  const e = cwd.replace(/:/g, "").replace(/[\\/]/g, "-");
  return e ? e[0].toLowerCase() + e.slice(1) : e;
}

/** Claude Code cwd 编码：D:\Risk-control -> D--Risk-control（非字母数字全换 -） */
export function claudeCwdEncode(cwd: string): string {
  return [...cwd].map((ch) => (/[0-9A-Za-z]/.test(ch) ? ch : "-")).join("");
}
