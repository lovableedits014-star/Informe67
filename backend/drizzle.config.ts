import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { readMigrationConfig } from "./src/db/migration-config.js";

const database = readMigrationConfig(process.env);

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.database,
  },
});
