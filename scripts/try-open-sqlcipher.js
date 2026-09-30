const sqlite = require("C:/Users/tc032353/AppData/Local/Programs/Trae CN/resources/app/node_modules/@vscode/sqlite3/build/Release/vscode-sqlite3.node");

const db = new sqlite.Database(process.argv[2], sqlite.OPEN_READONLY);
db.exec("PRAGMA key = '" + process.argv[3] + "';", () => {
  db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' LIMIT 20;",
    (err) => {
      console.log("err", err);
      // use serialize + all via internal
      db.serialize(() => {
        db.exec("SELECT name FROM sqlite_master WHERE type='table';", (e2) => {
          console.log("e2", e2);
        });
      });
    },
  );
});
// fallback: use Database#configure
setTimeout(() => {
  try {
    const st = db.prepare("SELECT name FROM sqlite_master WHERE type='table'");
    console.log("prepare", st);
  } catch (e) {
    console.log("prepare err", e.message);
    // try query via all
    console.log("methods", Object.getOwnPropertyNames(Object.getPrototypeOf(db)));
  }
}, 300);
