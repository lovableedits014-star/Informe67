import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from 'node:crypto';
import { buildApp } from "../src/app.js";
import { hashPassword, verifyPassword } from "../src/admin/password.js";
import { type AdminStore, type AdminUser } from "../src/admin/store.js";

const origin = "http://localhost:3000";
const password = "test-only-long-password";
const hash = await hashPassword(password);
function fixture(options: { adminOrigin?: string; secureCookies?: boolean; sessionTtlMs?: number } = {}) {
  const user: AdminUser = { id: "1", email: "editor@example.test", displayName: "Editor", passwordHash: hash, isActive: true, permissions: ["admin.access", "news.read"] };
  const audits: string[] = [], calls: string[] = [];
  const store: AdminStore = {
    findByEmail: async email => email === user.email ? user : undefined,
    findById: async id => id === user.id ? user : undefined,
    dashboard: async permissions => { calls.push("dashboard"); return { counts: permissions.includes("news.read") ? { news: 0 } : {}, recentNews: [] }; },
    list: async module => { calls.push(module); return []; },
    audit: async (_id, action) => { audits.push(action); },
  };
  const app = buildApp({ query: async () => ({ rows: [] }), end: async () => {} }, { adminStore: store, adminOrigin: origin, ...options });
  const login = () => app.inject({ method: "POST", url: "/api/admin/login", headers: { origin }, payload: { email: user.email, password } });
  return { app, user, store, audits, calls, login };
}
function cookie(response: { headers: Record<string, unknown> }) { return String(response.headers["set-cookie"]).split(";")[0]; }

test("password hashes are salted, reject wrong passwords and malformed hashes", async () => {
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
  assert.equal(await verifyPassword(password, ""), false);
  assert.notEqual(await hashPassword(password), hash);
  await assert.rejects(hashPassword("short"));
});

test("admin assets are isolated, include security headers and public health remains available", async t => {
  const { app } = fixture(); t.after(() => app.close());
  const page = await app.inject("/admin/");
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /login-form/);
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal((await app.inject("/admin/admin.js")).statusCode, 200);
  const versioned = page.body.match(/src="(\/admin\/ai-settings\.js\?v=([a-f0-9]{12}))"/);
  assert.ok(versioned, 'Settings script must have an asset version');
  const settings = await app.inject(versioned[1]);
  assert.equal(settings.statusCode, 200);assert.equal(settings.headers['cache-control'], 'no-store');
  assert.match(settings.body, /value="groq"/);
  assert.equal(createHash('sha256').update(settings.body).digest('hex').slice(0,12), versioned[2]);
  assert.equal((await app.inject("/admin/.env")).statusCode, 404);
  assert.equal((await app.inject("/api/health")).statusCode, 200);
});

test("every admin data route requires a session, forged cookies are rejected", async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  for (const route of ["me", "dashboard", "news", "categories", "images", "banners", "users", "settings"]) {
    const response = await app.inject({ url: `/api/admin/${route}`, headers: { cookie: "informe67_admin=forged" } });
    assert.equal(response.statusCode, 401, route);
  }
  assert.deepEqual(calls, []);
});

test("login requires an authorized origin and valid credentials; failures do not reveal account status", async t => {
  const { app, user, login } = fixture(); t.after(() => app.close());
  const payload = { email: user.email, password };
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/login", payload })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/login", headers: { origin: "https://attacker.test" }, payload })).statusCode, 403);
  const unknown = await app.inject({ method: "POST", url: "/api/admin/login", headers: { origin }, payload: { ...payload, email: "unknown@example.test" } });
  user.isActive = false;
  const inactive = await login();
  assert.equal(unknown.statusCode, 401); assert.equal(inactive.statusCode, 401);
  assert.equal(unknown.body, inactive.body);
  assert.equal(inactive.headers["set-cookie"], undefined);
});

test("login accepts the HTTPS origin matching the public host behind a proxy", async t => {
  const { app, user } = fixture({ adminOrigin: "https://old-deployment.example.test", secureCookies: true });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { origin: "https://informe67noticias.com.br", host: "informe67noticias.com.br" },
    payload: { email: user.email, password },
  });
  assert.equal(response.statusCode, 200);

  const attacker = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { origin: "https://attacker.test", host: "informe67noticias.com.br" },
    payload: { email: user.email, password },
  });
  assert.equal(attacker.statusCode, 403);

  const insecure = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { origin: "http://informe67noticias.com.br", host: "informe67noticias.com.br" },
    payload: { email: user.email, password },
  });
  assert.equal(insecure.statusCode, 403);
});

test("session login, RBAC, CSRF logout and logout revocation", async t => {
  const { app, audits, calls, login, user } = fixture(); t.after(() => app.close());
  const response = await login(); assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["set-cookie"]), /HttpOnly/);
  assert.match(String(response.headers["set-cookie"]), /SameSite=Strict/);
  assert.equal(response.body.includes("passwordHash"), false);
  assert.equal(response.body.includes(hash), false);
  const headers = { cookie: cookie(response) };
  const me = await app.inject({ url: "/api/admin/me", headers }); assert.equal(me.statusCode, 200);
  assert.equal((await app.inject({ url: "/api/admin/dashboard", headers })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/admin/news", headers })).statusCode, 200);
  for (const route of ["categories", "images", "banners", "users", "settings"]) assert.equal((await app.inject({ url: `/api/admin/${route}`, headers })).statusCode, 403);
  assert.deepEqual(calls, ["dashboard", "news"]);
  user.permissions = ["admin.access"];
  assert.equal((await app.inject({ url: "/api/admin/news", headers })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/logout", headers: { ...headers, origin } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/logout", headers: { ...headers, origin: "https://attacker.test", "x-csrf-token": me.json().csrfToken } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/logout", headers: { ...headers, origin, "x-csrf-token": me.json().csrfToken } })).statusCode, 204);
  assert.equal((await app.inject({ url: "/api/admin/me", headers })).statusCode, 401);
  assert.deepEqual(audits, ["admin.login", "admin.logout"]);
});

test("disabled users, removed admin access and changed passwords revoke sessions", async t => {
  for (const change of ["disabled", "permissions", "password"]) {
    const { app, login, user } = fixture(); t.after(() => app.close());
    const response = await login(); assert.equal(response.statusCode, 200);
    if (change === "disabled") user.isActive = false;
    if (change === "permissions") user.permissions = [];
    if (change === "password") user.passwordHash = "changed";
    assert.equal((await app.inject({ url: "/api/admin/me", headers: { cookie: cookie(response) } })).statusCode, 401);
  }
});

test("expired sessions cannot access the dashboard, Secure cookies are emitted", async t => {
  const { app, login } = fixture({ secureCookies: true, sessionTtlMs: 10 }); t.after(() => app.close());
  const response = await login();
  assert.match(String(response.headers["set-cookie"]), /; Secure/);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await app.inject({ url: "/api/admin/dashboard", headers: { cookie: cookie(response) } })).statusCode, 401);
});

test("rate limit blocks repeated login attempts", async t => {
  const { app, user } = fixture(); t.after(() => app.close());
  for (let i = 0; i < 5; i++) assert.equal((await app.inject({ method: "POST", url: "/api/admin/login", headers: { origin }, payload: { email: user.email, password: "incorrect" } })).statusCode, 401);
  const blocked = await app.inject({ method: "POST", url: "/api/admin/login", headers: { origin }, payload: { email: user.email, password } });
  assert.equal(blocked.statusCode, 429);
  assert.ok(blocked.headers["retry-after"]);
});

test("database failures return a generic error without credentials", async t => {
  const { app, store, login } = fixture(); t.after(() => app.close());
  store.findByEmail = async () => { throw new Error("password=must-not-leak"); };
  const response = await login();
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.includes("must-not-leak"), false);
});

test("category deletion requires session, delete permission, origin and CSRF", async t => {
  const {app,user,store,login,calls}=fixture();t.after(()=>app.close());
  const id='11111111-1111-4111-8111-111111111111';
  store.deleteCategory=async (_id,_target,_actor,transfer)=>{calls.push('delete');assert.equal(transfer,true);return{moved:3};};
  const session=await login();const headers={cookie:cookie(session),origin,'x-csrf-token':session.json().csrfToken};
  assert.equal((await app.inject({method:'DELETE',url:`/api/admin/categories/${id}`,headers,payload:{}})).statusCode,403);
  user.permissions=['admin.access','categories.read','categories.delete','categories.transfer'];
  assert.equal((await app.inject({method:'DELETE',url:`/api/admin/categories/${id}`,headers:{cookie:headers.cookie,origin},payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'DELETE',url:`/api/admin/categories/${id}`,headers:{...headers,origin:'https://evil.test'},payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'DELETE',url:'/api/admin/categories/invalid',headers,payload:{}})).statusCode,400);
  const response=await app.inject({method:'DELETE',url:`/api/admin/categories/${id}`,headers,payload:{targetId:'22222222-2222-4222-8222-222222222222'}});
  assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{moved:3});assert.deepEqual(calls,['delete']);
});

test("category editing checks permissions and rejects a client-provided slug",async t=>{
  const {app,user,store,login}=fixture();t.after(()=>app.close());const id='11111111-1111-4111-8111-111111111111';
  store.editCategory=async(id,name)=>({id,name,slug:'sao-paulo'});
  const session=await login(),headers={cookie:cookie(session),origin,'x-csrf-token':session.json().csrfToken};
  assert.equal((await app.inject({method:'PUT',url:`/api/admin/categories/${id}`,headers,payload:{name:'São Paulo'}})).statusCode,403);
  user.permissions=['admin.access','categories.read','categories.edit'];
  assert.equal((await app.inject({method:'PUT',url:`/api/admin/categories/${id}`,headers:{cookie:headers.cookie,origin},payload:{name:'São Paulo'}})).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url:`/api/admin/categories/${id}`,headers,payload:{name:'São Paulo',slug:'fake'}})).statusCode,400);
  const response=await app.inject({method:'PUT',url:`/api/admin/categories/${id}`,headers,payload:{name:'São Paulo'}});assert.equal(response.statusCode,200);assert.equal(response.json().slug,'sao-paulo');
});
