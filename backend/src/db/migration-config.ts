export type MigrationConfig = {
  host: string;
  port: number;
  connectionTimeoutMillis: number;
  database: "informe67";
  user: string;
  password: string;
};

export function readMigrationConfig(
  env: NodeJS.ProcessEnv,
): MigrationConfig {
  const database = env.PGDATABASE;
  if (database !== "informe67") {
    throw new Error(
      'Migrações permitidas somente para PGDATABASE="informe67".',
    );
  }

  const host = env.PGHOST?.trim();
  const user = env.PGUSER?.trim();
  const password = env.PGPASSWORD ?? "";
  const port = Number(env.PGPORT ?? 5432);
  const connectionTimeoutMillis = Number(env.PGCONNECT_TIMEOUT_MS ?? 5000);

  if (!host) {
    throw new Error("PGHOST é obrigatório para operações de migração.");
  }
  if (!user) {
    throw new Error("PGUSER é obrigatório para operações de migração.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PGPORT deve ser um número inteiro entre 1 e 65535.");
  }
  if (!Number.isInteger(connectionTimeoutMillis) || connectionTimeoutMillis < 1) {
    throw new Error("PGCONNECT_TIMEOUT_MS deve ser um número inteiro positivo.");
  }

  return { host, port, connectionTimeoutMillis, database, user, password };
}

export function assertMigrationPassword(config: MigrationConfig): void {
  if (!config.password) {
    throw new Error("PGPASSWORD é obrigatório para aplicar migrações.");
  }
}

export function migrationConfirmation(config: MigrationConfig): string {
  return `APLICAR ${config.database}@${config.host}:${config.port}`;
}
