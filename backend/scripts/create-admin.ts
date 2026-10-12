import { loadBackendEnvironment } from "../src/config/environment.js";
import { readMigrationConfig, assertMigrationPassword } from "../src/db/migration-config.js";
import { hashPassword } from "../src/admin/password.js";
import { adminPermissions } from "../src/admin/store.js";
import * as schema from "../src/db/schema.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";

loadBackendEnvironment(import.meta.url);
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Execute admin:create em um terminal interativo.");
const target = readMigrationConfig(process.env);
assertMigrationPassword(target);

async function hiddenPassword(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const listener = (text: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === "c") { finish(); reject(new Error("Cadastro cancelado.")); }
      else if (key.name === "return" || key.name === "enter") { finish(); resolve(value); }
      else if (key.name === "backspace") value = Array.from(value).slice(0, -1).join("");
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    };
    function finish() {
      process.stdin.removeListener("keypress", listener);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    }
    process.stdin.on("keypress", listener);
  });
}

console.info(`Primeiro administrador: ${target.database}@${target.host}:${target.port}.`);
const terminal = createInterface({ input: process.stdin, output: process.stdout });
let email: string, displayName: string;
try {
  email = (await terminal.question("E-mail: ")).trim().toLowerCase();
  displayName = (await terminal.question("Nome: ")).trim();
} finally { terminal.close(); }
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320 || !displayName || displayName.length > 160) throw new Error("E-mail ou nome inválido.");
const password = await hiddenPassword("Senha (mínimo 12 caracteres; entrada oculta): ");
if (password !== await hiddenPassword("Confirme a senha: ")) throw new Error("Senhas diferentes.");
const passwordHash = await hashPassword(password);
const pool = new Pool({ ...target, max: 1 });
try {
  await drizzle(pool).transaction(async tx => {
    const identity = await tx.execute(sql`SELECT current_database() AS database`);
    if (identity.rows[0]?.database !== "informe67") throw new Error("Destino inesperado.");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(670001)`);
    const existing = await tx.select({ id: schema.users.id }).from(schema.users).limit(1);
    if (existing.length) throw new Error("Cadastro inicial cancelado: já existem usuários. Use o fluxo de administração de contas.");
    const [user] = await tx.insert(schema.users).values({ email, displayName, passwordHash }).returning({ id: schema.users.id });
    const [role] = await tx.insert(schema.roles).values({ name: "administrator", description: "Administrador do painel", isSystem: true }).onConflictDoUpdate({ target: schema.roles.name, set: { isSystem: true } }).returning({ id: schema.roles.id });
    for (const code of adminPermissions) {
      const [permission] = await tx.insert(schema.permissions).values({ code }).onConflictDoUpdate({ target: schema.permissions.code, set: { code } }).returning({ id: schema.permissions.id });
      await tx.insert(schema.rolePermissions).values({ roleId: role.id, permissionId: permission.id }).onConflictDoNothing();
    }
    await tx.insert(schema.userRoles).values({ userId: user.id, roleId: role.id });
    await tx.insert(schema.auditLogs).values({ actorId: user.id, action: "admin.bootstrap", entityType: "users", entityId: user.id });
  });
  console.info("Administrador cadastrado. Acesse /admin/ para entrar.");
} catch {
  console.error("Cadastro não realizado. Verifique conexão, destino e se já existem usuários; nenhuma alteração parcial foi mantida.");
  process.exitCode = 1;
} finally { await pool.end(); }
