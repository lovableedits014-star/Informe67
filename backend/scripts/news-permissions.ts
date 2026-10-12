import { loadBackendEnvironment } from "../src/config/environment.js";
import { readMigrationConfig } from "../src/db/migration-config.js";
import { newsPermissions } from "../src/news/validation.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import * as s from "../src/db/schema.js";

loadBackendEnvironment(import.meta.url);
const target = readMigrationConfig(process.env);
const pool = new Pool({ ...target, max: 1 });
try {
  await drizzle(pool).transaction(async tx => {
    const identity = await tx.execute(sql`SELECT current_database() AS database`);
    if (identity.rows[0]?.database !== "informe67") throw new Error("Destino inesperado.");
    const [role] = await tx.select().from(s.roles).where(eq(s.roles.name, "administrator"));
    if (!role) throw new Error("Função administrator não encontrada.");
    for (const code of newsPermissions) {
      await tx.insert(s.permissions).values({ code }).onConflictDoNothing();
      const [permission] = await tx.select().from(s.permissions).where(eq(s.permissions.code, code));
      await tx.insert(s.rolePermissions).values({ roleId: role.id, permissionId: permission.id }).onConflictDoNothing();
    }
    await tx.insert(s.auditLogs).values({ action: "news.permissions.install", entityType: "roles", entityId: role.id });
  });
  console.info("Permissões de Notícias disponíveis para administrator em informe67.");
} catch { console.error("Permissões não instaladas. Verifique banco e função administrator."); process.exitCode = 1; }
finally { await pool.end(); }
