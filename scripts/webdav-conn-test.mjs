/**
 * 测试 core WebDAV store ↔ mini-webdav
 */
import { pathToFileURL } from "node:url";

const { createStore } = await import(
  pathToFileURL("D:/SessionHarbor/packages/core/dist/sync.js").href
);

const store = createStore({
  kind: "webdav",
  baseUrl: "http://127.0.0.1:8080",
  username: "harbor",
  password: "harbor123",
  remotePath: "/sessionharbor",
});

console.log("backend", store.describe());

const manifest = await store.listManifest();
console.log("listManifest entries", manifest.entries.length);

await store.putFile("sessions/alink/g/test.harbor.enc.json", JSON.stringify({ hello: "webdav", n: 1 }));
console.log("PUT ok");

const got = await store.getFile("sessions/alink/g/test.harbor.enc.json");
console.log("GET", got);

manifest.entries.push({
  sessionId: "test",
  sourceClient: "alink",
  group: "g",
  title: "webdav联调",
  fingerprint: "abc",
  syncedAt: new Date().toISOString(),
  path: "sessions/alink/g/test.harbor.enc.json",
});
await store.saveManifest(manifest);
const m2 = await store.listManifest();
console.log("manifest saved entries", m2.entries.length, m2.entries[0]?.title);
console.log("✅ WebDAV 客户端联通");
