import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertMigrationPassword,
  migrationConfirmation,
  readMigrationConfig,
} from "./migration-config.js";

async function confirmMigration(target: ReturnType<typeof readMigrationConfig>) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      "Aplicação cancelada: execute db:migrate em um terminal interativo.",
    );
  }

  const confirmation = migrationConfirmation(target);
  console.info(
    `Destino da migração: banco=${target.database}, host=${target.host}, porta=${target.port}, usuário=${target.user}.`,
  );

  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await terminal.question(
      `Para confirmar, digite exatamente "${confirmation}": `,
    );
    return answer === confirmation;
  } finally {
    terminal.close();
  }
}

async function applyMigrations() {
  const target = readMigrationConfig(process.env);
  assertMigrationPassword(target);
  if (!(await confirmMigration(target))) {
    console.info("Aplicação cancelada; nenhuma conexão foi aberta.");
    return;
  }

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
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    console.info(`Migrações aplicadas em ${target.database}.`);
  } finally {
    await pool.end();
  }
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(resolve(scriptPath)).href) {
  await applyMigrations();
}
