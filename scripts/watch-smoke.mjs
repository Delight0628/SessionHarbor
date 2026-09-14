import { SessionWatcher } from "../packages/core/dist/index.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-watch-"));
const file = path.join(tmp, "test-session.jsonl");
const w = new SessionWatcher({
  debounceMs: 100,
  onEvent: (e) => {
    console.log("EVENT", e.kind, path.basename(e.file));
    w.close();
    process.exit(0);
  },
});
w.watch({ id: "test", dir: tmp });
setTimeout(() => {
  fs.writeFileSync(file, "{}\n");
}, 50);
setTimeout(() => {
  console.log("TIMEOUT no event");
  w.close();
  process.exit(1);
}, 3000);
