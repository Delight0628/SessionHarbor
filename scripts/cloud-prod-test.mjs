const base = "http://127.0.0.1:8787";
const admin = process.env.HARBOR_CLOUD_ADMIN_TOKEN || "admin-dev-token-please-change";

async function j(res) {
  const t = await res.text();
  try {
    return { status: res.status, body: JSON.parse(t) };
  } catch {
    return { status: res.status, body: t };
  }
}

// register/login
const reg = await j(
  await fetch(`${base}/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `ops${Date.now()}@test.local`, password: "pass1234" }),
  }),
);
console.log("register", reg.status, !!reg.body.token);
const tok = reg.body.token;
const userId = reg.body.userId;

// put + list
await fetch(`${base}/v1/sync/sessions/alink/g/a.harbor.enc.json`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
  body: "{}",
});
const list = await j(await fetch(`${base}/v1/sync/list`, { headers: { Authorization: `Bearer ${tok}` } }));
console.log("list", list.status, list.body.count, (list.body.files || []).map((f) => f.path));

// admin list
const adminList = await j(
  await fetch(`${base}/v1/admin/users`, { headers: { Authorization: `Bearer ${admin}` } }),
);
console.log("admin users", adminList.status, adminList.body.users?.length);

// admin set plan
const setPlan = await j(
  await fetch(`${base}/v1/admin/plan`, {
    method: "POST",
    headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
    body: JSON.stringify({ userId, plan: "pro" }),
  }),
);
console.log("set plan", setPlan.status, setPlan.body);
const me = await j(await fetch(`${base}/v1/auth/me`, { headers: { Authorization: `Bearer ${tok}` } }));
console.log("me plan", me.body.plan, "quota", me.body.quota?.maxSessions);

// rate limit auth (11 login attempts)
let limited = 0;
for (let i = 0; i < 12; i++) {
  const r = await fetch(`${base}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nobody@x.local", password: "x" }),
  });
  if (r.status === 429) limited++;
}
console.log("rate limited count in 12 tries", limited);

const metrics = await j(await fetch(`${base}/metrics`));
console.log("metrics", metrics.body.requests, metrics.body.rateLimited, metrics.body.db);
