import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";

test("GET /api/health returns the API status", async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/health",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "informe67-api",
  });
});

test("GET /api/health/db returns the database status without connection details", async (t) => {
  const app = buildApp({
    query: async () => ({ rows: [{ "?column?": 1 }] }),
    end: async () => {},
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/health/db",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    database: "available",
  });
});

test("GET /api/health/db hides database errors", async (t) => {
  const app = buildApp({
    query: async () => {
      const error = new Error("password must not appear in the response");
      Object.assign(error, { code: "28P01" });
      throw error;
    },
    end: async () => {},
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/health/db",
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: "error",
    database: "unavailable",
  });
  assert.equal(response.body.includes("password"), false);
  assert.equal(response.body.includes("28P01"), false);
});
