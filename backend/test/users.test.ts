import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { config } from "dotenv";
import { buildApp } from "../src/app.js";
import { hashPassword, verifyPassword } from "../src/admin/password.js";
import { createAdminStore, type AdminStore, type AdminUser } from "../src/admin/store.js";
import { validateUser } from "../src/admin/users.js";
import { readMigrationConfig } from "../src/db/migration-config.js";

const input = { displayName: "Novo Editor", email: "editor@example.test", password: "unique-test-password-only", role: "editor" };
test("user validation rejects weak passwords, unauthorized profiles and extra permission fields", () => {
  assert.equal(validateUser({ ...input, email: " EDITOR@EXAMPLE.TEST " }).email, input.email);
  for (const value of [null, [], { ...input, password: "short" }, { ...input, password: " ".repeat(12) }, { ...input, password: "é".repeat(513) }, { ...input, role: "superadministrator" }, { ...input, permissions: ["users.create"] }, { ...input, email: "invalid" }, { ...input, displayName: " " }]) assert.throws(() => validateUser(value), { statusCode: 400 });
});

test("only a live superadministrator can create users; CSRF, origin and profile validation are enforced", async t => {
  const origin = "http://localhost:3000", passwordHash = await hashPassword(input.password);
  const user: AdminUser = { id: randomUUID(), displayName: "Admin", email: "admin@example.test", passwordHash, isActive: true, roles: ["superadministrator"], permissions: ["admin.access", "users.read", "users.create"] };
  let writes = 0;
  const store: AdminStore = { findByEmail: async () => user, findById: async () => user, dashboard: async () => ({ counts: {}, recentNews: [] }), list: async () => [], audit: async () => {}, createUser: async data => { writes++; return { id: randomUUID(), displayName: data.displayName, email: data.email, roles: [data.role], isActive: true }; } };
  const app = buildApp({ query: async () => ({ rows: [] }), end: async () => {} }, { adminStore: store, adminOrigin: origin });t.after(() => app.close());
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/users", headers: { origin }, payload: input })).statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/admin/login", headers: { origin }, payload: { email: user.email, password: input.password } });
  const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0], origin, "x-csrf-token": login.json().csrfToken };
  const post = (payload: unknown, custom = headers) => app.inject({ method: "POST", url: "/api/admin/users", headers: custom, payload });
  assert.equal((await post(input, { ...headers, "x-csrf-token": "forged" })).statusCode, 403);
  assert.equal((await post(input, { ...headers, origin: "https://attacker.test" })).statusCode, 403);
  user.roles = ["administrator"];
  assert.equal((await post(input)).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/admin/users/profiles", headers })).statusCode, 403);
  user.roles = ["superadministrator"];user.permissions = ["admin.access", "users.read"];
  assert.equal((await post(input)).statusCode, 403);
  user.permissions.push("users.create");
  assert.equal((await post({ ...input, role: "superadministrator" })).statusCode, 400);
  assert.equal((await post({ ...input, password: "short" })).statusCode, 400);
  assert.equal(writes, 0);
  assert.equal((await app.inject({ url: "/api/admin/users/profiles", headers })).json().items.length, 3);
  const created = await post(input);assert.equal(created.statusCode, 201);assert.equal(writes, 1);
  assert.equal(created.body.includes(input.password), false);assert.equal(created.body.includes("passwordHash"), false);
  user.roles = [];assert.equal((await post(input)).statusCode, 403);
});

test("new-user form checks matching passwords, selects editor and clears secrets after creation", async () => {
  const dom = new JSDOM('<div id="view"></div>', { url: "http://localhost:3000/admin/", runScripts: "outside-only" }), w = dom.window;
  w.eval(readFileSync(new URL("../public/admin/users.js", import.meta.url), "utf8"));
  let writes = 0, saved: any, oldForm: HTMLFormElement;
  const root = w.document.querySelector("#view")!;
  const render = () => (w as any).UserModule.render({ root, items: [], user: { roles: ["superadministrator"], permissions: ["users.create"] }, reload: async () => render(), api: async (path: string, options: any) => { if (path === "users/profiles") return { items: [{ name: "editor", label: "Editor", description: "Rascunhos" }, { name: "administrator", label: "Administrador", description: "Gerencia o portal" }] };writes++;saved=JSON.parse(options.body);return {id:"new-user"}; } });
  try {
    render();[...root.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Novo usuário")!.click();await new Promise(r => setTimeout(r, 20));
    oldForm = root.querySelector("form")!;const field=(name:string)=>oldForm.elements.namedItem(name) as HTMLInputElement;
    field("displayName").value=input.displayName;field("email").value=input.email;field("password").value=input.password;field("confirmPassword").value="different-password";
    assert.equal(field("role").value,"editor");oldForm.dispatchEvent(new w.Event("submit",{cancelable:true}));assert.equal(writes,0);assert.match(root.textContent!,/não coincidem/);
    field("confirmPassword").value=input.password;oldForm.dispatchEvent(new w.Event("submit",{cancelable:true}));await new Promise(r=>setTimeout(r,20));
    assert.equal(writes,1);assert.equal(saved.role,"editor");assert.equal(field("password").value,"");assert.equal(field("confirmPassword").value,"");assert.match(root.textContent!,/Usuário cadastrado/);
    (w as any).UserModule.render({root,items:[],user:{roles:['administrator'],permissions:['users.create']},api:async()=>{},reload:()=>{}});assert.equal(root.querySelector('button'),null);
  } finally { w.close(); }
});

test("PostgreSQL user creation hashes passwords, assigns limited roles and prevents duplicate emails in a rollback", { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
  config();const pool = new Pool({ ...readMigrationConfig(process.env), max: 1 }), client = await pool.connect();
  try {
    assert.equal((await client.query("SELECT current_database() AS database")).rows[0].database,"informe67");await client.query("BEGIN");
    const actor = (await client.query("SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE r.name='superadministrator' AND u.is_active LIMIT 1")).rows[0];assert.ok(actor);
    const connection = { query: (query: any, values?: any) => { const control = (typeof query === "string" ? query : query.text).trim().toLowerCase();if(control==='begin')return client.query('SAVEPOINT user_test');if(control==='commit')return client.query('RELEASE SAVEPOINT user_test');if(control==='rollback')return client.query('ROLLBACK TO SAVEPOINT user_test');return client.query(query,values); } };
    const store=createAdminStore(connection as unknown as Pool), email=`test-${randomUUID()}@example.test`;
    const created=await store.createUser!({...input,email:email.toUpperCase()},actor.id);assert.equal(created.email,email);assert.equal('passwordHash' in created,false);
    const editor=await store.findByEmail(email);assert.ok(editor);assert.equal(await verifyPassword(input.password,editor.passwordHash),true);assert.notEqual(editor.passwordHash,input.password);assert.deepEqual(editor.roles,['editor']);assert.equal(editor.permissions.includes('news.edit'),true);for(const permission of ['news.publish','news.archive','users.create','banners.manage'])assert.equal(editor.permissions.includes(permission),false);
    await assert.rejects(store.createUser!({...input,email},actor.id),{statusCode:409});
    await assert.rejects(store.createUser!({...input,email:`other-${email}`},editor.id),{statusCode:403});
    assert.equal((await client.query("SELECT count(*)::int AS total FROM users WHERE lower(email)=$1",[email])).rows[0].total,1);
    assert.equal((await client.query("SELECT metadata FROM audit_logs WHERE entity_id=$1 AND action='users.create'",[editor.id])).rows[0].metadata.role,'editor');
    assert.equal((await store.list('users')).some(u=>'passwordHash' in u),false);
  } finally { await client.query('ROLLBACK');client.release();await pool.end(); }
});
