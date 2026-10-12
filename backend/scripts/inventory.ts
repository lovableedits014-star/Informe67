import { loadBackendEnvironment } from "../src/config/environment.js";
import { databaseDiagnostic } from "../src/db/diagnostics.js";
import { readMigrationConfig } from "../src/db/migration-config.js";
import { Pool } from "pg";

loadBackendEnvironment(import.meta.url);
const target = readMigrationConfig(process.env);

async function inventoryTables() {
  const pool = new Pool({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    connectionTimeoutMillis: target.connectionTimeoutMillis,
    max: 1,
  });

  try {
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN READ ONLY");
      transactionStarted = true;

      const currentDatabase = await client.query<{ database: string }>(
        "SELECT current_database() AS database",
      );
      if (currentDatabase.rows[0]?.database !== "informe67") {
        throw new Error(
          'Conexão não está no banco informe67; inventário cancelado.',
        );
      }

      console.info("Banco confirmado: informe67. Inventário somente de leitura.");
      const result = await client.query<{
        schema_name: string;
        table_name: string;
      }>(`
        SELECT schemaname AS schema_name, tablename AS table_name
        FROM pg_catalog.pg_tables
        WHERE schemaname <> 'information_schema'
          AND schemaname NOT LIKE 'pg\\_%' ESCAPE '\\'
        ORDER BY schemaname, tablename
      `);

      if (result.rows.length === 0) {
        console.info("Nenhuma tabela encontrada em schemas não sistêmicos.");
      } else {
        console.info(`Tabelas encontradas: ${result.rows.length}`);
        console.table(result.rows);
      }

      await client.query("ROLLBACK");
      transactionStarted = false;
    } finally {
      if (transactionStarted) {
        await client.query("ROLLBACK");
      }
      client.release();
    }
  } finally {
    await pool.end();
  }
}

try {
  await inventoryTables();
} catch (error) {
  const diagnostic = databaseDiagnostic(error);
  console.error(
    `Inventário cancelado. Erro ${diagnostic.code}: ${diagnostic.message}`,
  );
  process.exitCode = 1;
}
