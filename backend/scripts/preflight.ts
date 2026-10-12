import { loadBackendEnvironment } from "../src/config/environment.js";
import { databaseDiagnostic } from "../src/db/diagnostics.js";
import { readMigrationConfig } from "../src/db/migration-config.js";
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

loadBackendEnvironment(import.meta.url);
const target = readMigrationConfig(process.env);

if (target.database !== "informe67" || target.user !== "informe67_user") {
  throw new Error(
    "Pré-verificação cancelada: configure PGDATABASE=informe67 e PGUSER=informe67_user.",
  );
}
if (!target.password) {
  throw new Error("PGPASSWORD é obrigatório para a pré-verificação.");
}

type PreflightResult = {
  database: string;
  user: string;
  schema: string | null;
  serverVersion: string;
  hasGenRandomUuid: boolean;
  canConnectDatabase: boolean;
  canUsePublicSchema: boolean;
  canCreateInPublicSchema: boolean;
  applicationTables: Array<{ schema_name: string; table_name: string }>;
};

async function inspectTarget(): Promise<PreflightResult> {
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

      const identity = await client.query<{
        database: string;
        user: string;
        schema: string | null;
        server_version: string;
        has_gen_random_uuid: boolean;
        can_connect_database: boolean;
        can_use_public_schema: boolean;
        can_create_in_public_schema: boolean;
      }>(`
        SELECT
          current_database() AS database,
          current_user AS user,
          current_schema() AS schema,
          current_setting('server_version') AS server_version,
          to_regprocedure('gen_random_uuid()') IS NOT NULL AS has_gen_random_uuid,
          has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect_database,
          has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_public_schema,
          has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public_schema
      `);
      const row = identity.rows[0];
      if (
        row?.database !== "informe67" ||
        row.user !== "informe67_user" ||
        row.schema !== "public"
      ) {
        throw new Error(
          "Destino inesperado; esperado banco informe67, usuário informe67_user e schema public.",
        );
      }

      const tables = await client.query<{
        schema_name: string;
        table_name: string;
      }>(`
        SELECT schemaname AS schema_name, tablename AS table_name
        FROM pg_catalog.pg_tables
        WHERE schemaname <> 'information_schema'
          AND schemaname NOT LIKE 'pg\\_%' ESCAPE '\\'
        ORDER BY schemaname, tablename
      `);

      await client.query("ROLLBACK");
      transactionStarted = false;

      return {
        database: row.database,
        user: row.user,
        schema: row.schema,
        serverVersion: row.server_version,
        hasGenRandomUuid: row.has_gen_random_uuid,
        canConnectDatabase: row.can_connect_database,
        canUsePublicSchema: row.can_use_public_schema,
        canCreateInPublicSchema: row.can_create_in_public_schema,
        applicationTables: tables.rows,
      };
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

function runPostgresTool(
  executable: string,
  args: string[],
): Promise<{ exitCode: number | null; missing: boolean }> {
  return new Promise((resolveResult, reject) => {
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
    delete childEnvironment.PGHOSTADDR;
    delete childEnvironment.PGSERVICE;
    delete childEnvironment.PGSERVICEFILE;
    delete childEnvironment.PGPASSFILE;
    childEnvironment.PGHOST = target.host;
    childEnvironment.PGPORT = String(target.port);
    childEnvironment.PGUSER = target.user;
    childEnvironment.PGDATABASE = "informe67";
    childEnvironment.PGPASSWORD = target.password;
    childEnvironment.PGCONNECT_TIMEOUT = String(
      Math.ceil(target.connectionTimeoutMillis / 1000),
    );

    const toolProcess = spawn(executable, args, {
      env: childEnvironment,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    toolProcess.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        resolveResult({ exitCode: null, missing: true });
        return;
      }
      reject(new Error("Falha ao iniciar ferramenta de backup."));
    });
    toolProcess.once("close", (exitCode) => {
      resolveResult({ exitCode, missing: false });
    });
  });
}

async function createVerifiedBackup(): Promise<{
  path: string;
  verified: boolean;
} | null> {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const backendDirectory = resolve(scriptDirectory, "..");
  const backupDirectory = resolve(backendDirectory, "backups");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const plainSql = process.argv.includes("--plain");
  const backupPath = resolve(
    backupDirectory,
    `informe67-pre-migration-${timestamp}.${plainSql ? "sql" : "dump"}`,
  );
  const restoreListPath = resolve(
    backupDirectory,
    `informe67-pre-migration-${timestamp}.list`,
  );

  await mkdir(backupDirectory, { recursive: true });
  const dump = await runPostgresTool("pg_dump", [
    `--format=${plainSql ? "plain" : "custom"}`,
    "--no-owner",
    "--no-password",
    `--host=${target.host}`,
    `--port=${target.port}`,
    `--username=${target.user}`,
    "--dbname=informe67",
    `--file=${backupPath}`,
  ]);

  if (dump.missing) {
    console.error(
      "Backup não realizado: pg_dump não está instalado ou não está no PATH.",
    );
    return null;
  }
  if (dump.exitCode !== 0) {
    try {
      await unlink(backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          "pg_dump falhou e o arquivo parcial não pôde ser removido.",
        );
      }
    }
    throw new Error(
      `pg_dump falhou (código ${String(dump.exitCode)}); backup incompleto removido.`,
    );
  }

  if (plainSql) {
    const sql = await readFile(backupPath, "utf8");
    if (
      !sql.startsWith("--\n-- PostgreSQL database dump\n") ||
      !sql.includes("-- PostgreSQL database dump complete\n")
    ) {
      throw new Error("Backup SQL sem cabeçalho ou marcador de conclusão do pg_dump.");
    }
    return { path: backupPath, verified: true };
  }

  const validation = await runPostgresTool("pg_restore", [
    "--list",
    `--file=${restoreListPath}`,
    backupPath,
  ]);
  if (validation.missing) {
    console.error(
      "Dump criado, mas não validado: pg_restore não está instalado ou não está no PATH.",
    );
    return { path: backupPath, verified: false };
  }
  if (validation.exitCode !== 0) {
    throw new Error(
      `pg_restore não validou o arquivo (código ${String(validation.exitCode)}).`,
    );
  }

  await unlink(restoreListPath);
  return { path: backupPath, verified: true };
}

try {
  const result = await inspectTarget();
  console.info("Destino confirmado:");
  console.info(`  Banco: ${result.database}`);
  console.info(`  Usuário: ${result.user}`);
  console.info(`  Schema: ${result.schema}`);
  console.info(`  PostgreSQL: ${result.serverVersion}`);
  console.info(`  gen_random_uuid(): ${result.hasGenRandomUuid ? "disponível" : "indisponível"}`);
  console.info(`  CONNECT no banco: ${result.canConnectDatabase ? "sim" : "não"}`);
  console.info(`  USAGE no schema public: ${result.canUsePublicSchema ? "sim" : "não"}`);
  console.info(`  CREATE no schema public: ${result.canCreateInPublicSchema ? "sim" : "não"}`);
  if (result.applicationTables.length === 0) {
    console.info("  Tabelas de aplicação: nenhuma encontrada");
  } else {
    console.info(`  Tabelas de aplicação encontradas: ${result.applicationTables.length}`);
    console.table(result.applicationTables);
  }

  if (
    !result.canConnectDatabase ||
    !result.canUsePublicSchema ||
    !result.canCreateInPublicSchema ||
    !result.hasGenRandomUuid
  ) {
    console.error("Pré-verificação de permissões/função não passou.");
    process.exitCode = 1;
  }

  const backupPath = await createVerifiedBackup();
  if (backupPath) {
    console.info(
      `${backupPath.verified ? "Backup criado e validado" : "Dump criado, mas não validado"}: ${backupPath.path}`,
    );
    if (!backupPath.verified) {
      process.exitCode = 1;
    }
  } else {
    process.exitCode = 1;
  }
} catch (error) {
  const diagnostic = databaseDiagnostic(error);
  console.error(
    `Pré-verificação interrompida. Erro ${diagnostic.code}: ${diagnostic.message}`,
  );
  process.exitCode = 1;
}
