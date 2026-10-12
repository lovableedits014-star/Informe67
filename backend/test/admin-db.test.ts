import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "dotenv";
import { Pool } from "pg";
import { readMigrationConfig } from "../src/db/migration-config.js";
import { createAdminStore, adminPermissions, modules } from "../src/admin/store.js";

test("admin store reads the existing informe67 schema without exposing password hashes", { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
  config();
  const target = readMigrationConfig(process.env);
  // The server enforces read-only transactions on every connection in this test.
  const pool = new Pool({ ...target, max: 1, options: "-c default_transaction_read_only=on" });
  try {
    const identity = await pool.query("SELECT current_database() AS database");
    assert.equal(identity.rows[0].database, "informe67");
    const store = createAdminStore(pool);
    const dashboard = await store.dashboard(adminPermissions);
    assert.equal(Object.keys(dashboard.counts).length, 6);
    for (const count of Object.values(dashboard.counts)) assert.ok(Number.isInteger(count) && count >= 0);
    assert.deepEqual(await store.dashboard([]), { counts: {}, recentNews: [] });
    for (const module of modules) {
      const rows = await store.list(module.key);
      assert.ok(rows.length <= 50);
      for (const row of rows) {
        assert.equal("passwordHash" in row, false);
        assert.equal("password_hash" in row, false);
        if (module.key === "settings") assert.equal("value" in row, false);
      }
    }
    // Exercises the users -> roles -> permissions join without creating accounts.
    const existing = await pool.query("SELECT id FROM public.users ORDER BY id LIMIT 1");
    if (existing.rows.length) {
      const user = await store.findById(existing.rows[0].id);
      assert.ok(user && Array.isArray(user.permissions));
    } else {
      assert.equal(await store.findById("00000000-0000-0000-0000-000000000000"), undefined);
    }
  } finally { await pool.end(); }
});
