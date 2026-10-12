import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertMigrationPassword,
  migrationConfirmation,
  readMigrationConfig,
} from "../src/db/migration-config.js";

const validEnvironment: NodeJS.ProcessEnv = {
  PGHOST: "127.0.0.1",
  PGPORT: "5433",
  PGDATABASE: "informe67",
  PGUSER: "informe67_user",
  PGPASSWORD: "local-test-password",
  PGCONNECT_TIMEOUT_MS: "5000",
};

test("migration configuration only accepts the informe67 database", () => {
  assert.throws(
    () =>
      readMigrationConfig({
        ...validEnvironment,
        PGDATABASE: "postgres",
      }),
    /somente para PGDATABASE="informe67"/,
  );
});

test("migration configuration validates the port and only requires a password to apply", () => {
  const configWithoutPassword = readMigrationConfig({
    ...validEnvironment,
    PGPASSWORD: "",
  });
  assert.throws(
    () => assertMigrationPassword(configWithoutPassword),
    /PGPASSWORD é obrigatório para aplicar migrações/,
  );
  assert.throws(
    () => readMigrationConfig({ ...validEnvironment, PGPORT: "70000" }),
    /PGPORT deve ser um número inteiro/,
  );
  assert.throws(
    () =>
      readMigrationConfig({
        ...validEnvironment,
        PGCONNECT_TIMEOUT_MS: "0",
      }),
    /PGCONNECT_TIMEOUT_MS deve ser um número inteiro positivo/,
  );
});

test("migration confirmation identifies database and destination", () => {
  const config = readMigrationConfig(validEnvironment);
  assert.equal(
    migrationConfirmation(config),
    "APLICAR informe67@127.0.0.1:5433",
  );
});
