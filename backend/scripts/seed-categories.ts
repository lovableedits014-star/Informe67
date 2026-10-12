import { loadBackendEnvironment } from "../src/config/environment.js";
import { readMigrationConfig } from "../src/db/migration-config.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { categories, auditLogs } from "../src/db/schema.js";

loadBackendEnvironment(import.meta.url);
const pool = new Pool({ ...readMigrationConfig(process.env), max: 1 });
const existingPortalCategories = [
  ["Campo Grande", "campo-grande"], ["Mato Grosso do Sul", "mato-grosso-do-sul"],
  ["Brasil", "brasil"], ["Mundo", "mundo"], ["Esporte", "esporte"], ["Cultura", "cultura"],
];
try {
  await drizzle(pool).transaction(async tx => {
    const identity = await tx.execute(sql`SELECT current_database() AS database`);
    if (identity.rows[0]?.database !== "informe67") throw new Error("Destino inesperado.");
    const inserted = await tx.insert(categories).values(existingPortalCategories.map(([name, slug], sortOrder) => ({ name, slug, sortOrder }))).onConflictDoNothing().returning({ id: categories.id });
    if (inserted.length) await tx.insert(auditLogs).values({ action: "categories.install.portal", entityType: "categories", metadata: { count: inserted.length } });
    console.info(`${inserted.length} categorias do portal cadastradas em informe67.`);
  });
} catch { console.error("Categorias não cadastradas. Verifique banco e conexão."); process.exitCode = 1; }
finally { await pool.end(); }
