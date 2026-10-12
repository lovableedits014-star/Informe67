import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseDiagnostic } from "../src/db/diagnostics.js";

test("database diagnostic maps common PostgreSQL and tunnel errors safely", () => {
  for (const code of [
    "ECONNREFUSED",
    "ETIMEDOUT",
    "28P01",
    "28000",
    "3D000",
  ]) {
    const diagnostic = databaseDiagnostic(
      Object.assign(new Error("private connection details"), { code }),
    );

    assert.equal(diagnostic.code, code);
    assert.ok(diagnostic.message.length > 0);
    assert.equal(diagnostic.message.includes("private"), false);
  }
});

test("unknown database errors redact connection URLs and credentials", () => {
  const diagnostic = databaseDiagnostic(
    Object.assign(
      new Error(
        'failed postgres://user:secret@host/db password="very-secret" for user "private-user"',
      ),
      { code: "XX000" },
    ),
  );

  assert.equal(diagnostic.code, "XX000");
  assert.equal(diagnostic.message.includes("postgres://"), false);
  assert.equal(diagnostic.message.includes("secret"), false);
  assert.equal(diagnostic.message.includes("private-user"), false);
});
