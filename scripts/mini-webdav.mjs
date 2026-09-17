/**
 * 迷你 WebDAV（仅 MKCOL/PUT/GET/HEAD）— 联调 SessionHarbor WebDAV 客户端
 * 启动: node scripts/mini-webdav.mjs
 * 数据: D:\SessionHarbor\webdav-data
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.env.HARBOR_WEBDAV_ROOT || "D:/SessionHarbor/webdav-data");
const PORT = Number(process.env.HARBOR_WEBDAV_PORT || 8080);
const USER = process.env.HARBOR_WEBDAV_USER || "harbor";
const PASS = process.env.HARBOR_WEBDAV_PASS || "harbor123";

fs.mkdirSync(ROOT, { recursive: true });

function auth(req) {
  const a = req.headers.authorization || "";
  if (!a.startsWith("Basic ")) return false;
  const [u, p] = Buffer.from(a.slice(6), "base64").toString("utf8").split(":");
  return u === USER && p === PASS;
}

function abs(rel) {
  const norm = path.posix.normalize(rel).replace(/^\/+/, "");
  if (norm.includes("..")) return null;
  return path.join(ROOT, norm);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const rel = decodeURIComponent(u.pathname);
  if (req.method === "OPTIONS") {
    res.writeHead(200, { Allow: "OPTIONS,GET,HEAD,PUT,MKCOL", DAV: "1" });
    res.end();
    return;
  }
  if (!auth(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="harbor-webdav"' });
    res.end("auth required");
    return;
  }
  const p = abs(rel);
  if (!p) {
    res.writeHead(400);
    res.end("bad path");
    return;
  }
  if (req.method === "MKCOL") {
    fs.mkdirSync(p, { recursive: true });
    res.writeHead(201);
    res.end();
    return;
  }
  if (req.method === "PUT") {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      fs.writeFileSync(p, Buffer.concat(chunks));
      res.writeHead(201);
      res.end();
    });
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const body = fs.readFileSync(p);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": body.length,
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
    return;
  }
  res.writeHead(405);
  res.end("method not allowed");
});

server.listen(PORT, () => {
  console.log(`Mini WebDAV http://127.0.0.1:${PORT}`);
  console.log(`root=${ROOT} user=${USER} pass=${PASS}`);
});
