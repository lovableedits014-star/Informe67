import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRedirectDoesNotLoop,
  assertSafeRedirectPath,
} from "../src/redirects/validation.js";

test("redirect validation allows safe local paths", async () => {
  assertSafeRedirectPath("/noticias/arquivo-2024?pagina=2", "Origem");
  await assertRedirectDoesNotLoop("/antiga", "/nova", async () => null);
});

test("redirect validation rejects external, encoded-authority and direct-loop paths", async () => {
  for (const path of [
    "https://example.com",
    "//example.com",
    "/%2f%2fevil.example",
    "/%5Cevil",
    "/path with spaces",
    "/path\\to",
  ]) {
    assert.throws(() => assertSafeRedirectPath(path, "Destino"));
  }

  await assert.rejects(
    assertRedirectDoesNotLoop("/same", "/same", async () => null),
    /loop/i,
  );
});

test("redirect validation detects indirect cycles in existing redirects", async () => {
  const redirects = new Map([
    ["/old-a", "/old-b"],
    ["/old-b", "/old-c"],
    ["/old-c", "/old-a"],
  ]);

  await assert.rejects(
    assertRedirectDoesNotLoop(
      "/old-a",
      "/old-b",
      async (path) => redirects.get(path) ?? null,
    ),
    /loop/i,
  );
});
