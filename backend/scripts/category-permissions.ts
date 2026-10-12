import { loadBackendEnvironment } from "../src/config/environment.js";
import { readMigrationConfig } from "../src/db/migration-config.js";
import { Pool } from "pg";

loadBackendEnvironment(import.meta.url);
const pool = new Pool({ ...readMigrationConfig(process.env), max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  if ((await client.query("SELECT current_database() AS database")).rows[0].database !== "informe67") throw Error("Destino inesperado.");
  const role = (await client.query("SELECT id FROM roles WHERE name=$1", ["administrator"])).rows[0];
  if (!role) throw Error("Função administrator ausente.");
  for (const code of ["categories.delete", "categories.transfer", "categories.edit"]) {
    await client.query("INSERT INTO permissions(code) VALUES($1) ON CONFLICT DO NOTHING", [code]);
    await client.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2 ON CONFLICT DO NOTHING", [role.id, code]);
  }
  await client.query("COMMIT"); console.info("Permissões de edição, exclusão e transferência disponíveis para administrator em informe67.");
} catch { await client.query("ROLLBACK"); console.error("Permissões não instaladas."); process.exitCode = 1; }
finally { client.release(); await pool.end(); }
