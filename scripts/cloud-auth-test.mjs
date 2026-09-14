const base = "http://127.0.0.1:8787";
async function auth(email, password) {
  let r = await fetch(`${base}/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (r.status === 409) {
    r = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  }
  const j = await r.json();
  console.log("auth", email, r.status, j.userId || j.error);
  return j;
}
const a = await auth("alice@test.local", "secret12");
const b = await auth("bob@test.local", "secret34");
const put = await fetch(`${base}/v1/sync/sessions/alink/g/x.harbor.enc.json`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ hello: "alice" }),
});
console.log("A put", put.status, await put.json());
const getA = await fetch(`${base}/v1/sync/sessions/alink/g/x.harbor.enc.json`, {
  headers: { Authorization: `Bearer ${a.token}` },
});
console.log("A get", getA.status, (await getA.text()).slice(0, 80));
const getB = await fetch(`${base}/v1/sync/sessions/alink/g/x.harbor.enc.json`, {
  headers: { Authorization: `Bearer ${b.token}` },
});
console.log("B get A file", getB.status, await getB.text());
const me = await fetch(`${base}/v1/auth/me`, { headers: { Authorization: `Bearer ${a.token}` } });
console.log("me", await me.json());
