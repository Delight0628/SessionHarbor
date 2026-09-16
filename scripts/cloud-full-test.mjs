const base = "http://127.0.0.1:8787";

async function j(res) {
  const t = await res.text();
  try {
    return { status: res.status, body: JSON.parse(t) };
  } catch {
    return { status: res.status, body: t };
  }
}

// 1) register + login
const reg = await j(
  await fetch(`${base}/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "u1@test.local", password: "pass1234" }),
  }),
);
console.log("register", reg.status, reg.body.userId || reg.body.error);
const login = await j(
  await fetch(`${base}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "u1@test.local", password: "pass1234" }),
  }),
);
console.log("login", login.status, !!login.body.token);
const tok = login.body.token;

// 2) concurrent PUT 8 files
const puts = [];
for (let i = 0; i < 8; i++) {
  puts.push(
    fetch(`${base}/v1/sync/sessions/alink/g/s${i}.harbor.enc.json`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ i, hello: "world".repeat(20) }),
    }).then((r) => r.status),
  );
}
const putStatus = await Promise.all(puts);
console.log("concurrent PUT", putStatus.join(","));

// 3) concurrent GET
const gets = [];
for (let i = 0; i < 8; i++) {
  gets.push(
    fetch(`${base}/v1/sync/sessions/alink/g/s${i}.harbor.enc.json`, {
      headers: { Authorization: `Bearer ${tok}` },
    }).then((r) => r.status),
  );
}
console.log("concurrent GET", (await Promise.all(gets)).join(","));

// 4) second user isolation
const reg2 = await j(
  await fetch(`${base}/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "u2@test.local", password: "pass5678" }),
  }),
);
const cross = await j(
  await fetch(`${base}/v1/sync/sessions/alink/g/s0.harbor.enc.json`, {
    headers: { Authorization: `Bearer ${reg2.body.token}` },
  }),
);
console.log("u2 read u1 file", cross.status, cross.body);

// 5) change password + old token invalid
const chg = await j(
  await fetch(`${base}/v1/auth/change-password`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ oldPassword: "pass1234", newPassword: "newpass99" }),
  }),
);
console.log("change-password", chg.status, !!chg.body.token);
const oldMe = await j(
  await fetch(`${base}/v1/auth/me`, { headers: { Authorization: `Bearer ${tok}` } }),
);
console.log("old token me", oldMe.status);
const newMe = await j(
  await fetch(`${base}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${chg.body.token}` },
  }),
);
console.log("new token me", newMe.status, newMe.body.email, newMe.body.usage);

// 6) logout
await fetch(`${base}/v1/auth/logout`, {
  method: "POST",
  headers: { Authorization: `Bearer ${chg.body.token}` },
});
const after = await j(
  await fetch(`${base}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${chg.body.token}` },
  }),
);
console.log("after logout", after.status);
