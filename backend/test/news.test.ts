import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/admin/password.js";
import type { AdminStore, AdminUser } from "../src/admin/store.js";
import type { NewsStore, NewsRecord } from "../src/news/store.js";
import { validateNews, assertNewsPermission, sanitizeContent, newsPermissions, NewsError } from "../src/news/validation.js";
import { processImage, uploadDirectory, assertImagesExist } from "../src/news/media.js";

const id = "11111111-1111-4111-8111-111111111111";
const imageUrl = `/media/news/${id}.webp`;
const body = { title: "Uma matéria", slug: "uma-materia", content: "<p>Conteúdo da matéria</p>", status: "draft", tags: ["Campo Grande"], images: [] };

test("HTML sanitization removes scripts, event handlers, dangerous links and external images", () => {
  const safe = sanitizeContent(`<h2>Título</h2><p onclick="bad()"><strong>Olá</strong><script>bad()</script><a href="javascript:bad()">link</a><a href="https://example.test">seguro</a><img src="https://attacker.test/a.jpg"><img src="${imageUrl}" onerror="bad()" alt="Foto"></p>`);
  assert.match(safe, /<strong>Olá<\/strong>/);
  assert.match(safe, /noopener noreferrer/);
  assert.match(safe, /alt="Foto"/);
  for (const forbidden of ["script", "onclick", "onerror", "javascript:", "attacker.test"]) assert.equal(safe.includes(forbidden), false, forbidden);
});
test("draft validation accepts incomplete content and normalizes tags and SEO", () => {
  const draft = validateNews({ ...body, content: "", summary: " Resumo ", tags: ["MS", "MS"], canonicalUrl: "https://example.test/noticia", isFeatured: true, featuredOrder: 2 });
  assert.equal(draft.summary, "Resumo"); assert.deepEqual(draft.tags, ["MS"]); assert.equal(draft.featuredOrder, 2);
});
test("validation rejects malformed slugs, empty publications, unsafe images and invalid references", () => {
  for (const invalid of [
    { slug: "Slug Errado" }, { title: " " }, { title: "a".repeat(241) }, { content: "x".repeat(200001) },
    { status: "published", content: "<script>hello</script>" }, { status: "unknown" }, { categoryId: "invalid" },
    { canonicalUrl: "javascript:alert(1)" }, { canonicalUrl: "https://user:secret@example.test" }, { authorId: id },
    { tags: [""] }, { tags: Array(21).fill("tag") }, { featuredOrder: -1 }, { isFeatured: "true" },
    { images: [{ imageUrl: "https://attacker.test/a.png", altText: "Image", isCover: true }] },
    { content: `<p>Texto<img src="${imageUrl}"></p>` },
    { images: [{ imageUrl, altText: "", isCover: true }] },
  ]) assert.throws(() => validateNews({ ...body, ...invalid }), NewsError);
});
test("scheduling requires a future instant with a timezone", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  for (const scheduledAt of [null, "invalid", "2026-10-12T10:00:00", "2026-10-12T11:00:00Z"]) assert.throws(() => validateNews({ ...body, status: "scheduled", scheduledAt }, now));
  assert.equal(validateNews({ ...body, status: "scheduled", scheduledAt: "2026-10-12T10:00:00-03:00" }, now).scheduledAt?.toISOString(), "2026-10-12T13:00:00.000Z");
});
test("publication, archiving and homepage changes require explicit permissions", () => {
  const draft = validateNews(body), published = validateNews({ ...body, status: "published" });
  assert.doesNotThrow(() => assertNewsPermission(draft, undefined, ["news.create"]));
  assert.throws(() => assertNewsPermission(published, undefined, ["news.create"]));
  assert.throws(() => assertNewsPermission(draft, { status: "published", isFeatured: false, featuredOrder: null }, ["news.edit"]));
  assert.throws(() => assertNewsPermission(validateNews({ ...body, status: "archived" }), { status: "draft", isFeatured: false, featuredOrder: null }, ["news.edit"]));
  assert.throws(() => assertNewsPermission(validateNews({ ...body, isFeatured: true }), undefined, ["news.create"]));
  assert.doesNotThrow(() => assertNewsPermission(published, undefined, newsPermissions));
});
test("image processing decodes genuine raster data, removes metadata and rejects executable formats", async () => {
  const jpeg = await sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } }).jpeg().toBuffer();
  const webp = await processImage(jpeg), metadata = await sharp(webp).metadata();
  assert.equal(metadata.format, "webp"); assert.equal(metadata.exif, undefined);
  await assert.rejects(processImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')));
  await assert.rejects(processImage(Buffer.from("not an image")));
  await assert.rejects(processImage(Buffer.alloc(5 * 1024 * 1024 + 1)), { statusCode: 413 });
  await assert.rejects(assertImagesExist([`/media/news/00000000-0000-0000-0000-000000000000.webp`]), { statusCode: 400 });
});

const password = "unit-test-long-password", hash = await hashPassword(password);
function fixture() {
  const user: AdminUser = { id, email: "test@example.test", displayName: "Test", passwordHash: hash, isActive: true, permissions: ["admin.access", "news.read", ...newsPermissions] };
  const saved = { id, updatedAt: new Date(), status: "draft" } as NewsRecord;
  const calls: string[] = [];
  const admin: AdminStore = { findById: async () => user, findByEmail: async () => user, audit: async () => {}, list: async () => [], dashboard: async () => ({ counts: {}, recentNews: [] }) };
  const news: NewsStore = {
    list: async o => { calls.push("list"); return { items: [], total: 0, page: o.page, pageSize: 20 }; },
    options: async () => ({ categories: [], tags: [] }), get: async () => saved,
    save: async (_id, input) => { calls.push("save"); return { ...saved, ...input } as unknown as NewsRecord; },
    publishDue: async () => 0, publicList: async featured => [{ title: featured ? "Featured" : "Published" }],
    publicBrowse: async o => ({items:[],total:0,page:o.page,pageSize:o.pageSize,categories:[],featured:[]}),
  };
  const origin = "http://localhost:3000";
  const app = buildApp({ query: async () => ({ rows: [] }), end: async () => {} }, { adminStore: admin, newsStore: news, adminOrigin: origin });
  async function login() {
    const result = await app.inject({ method: "POST", url: "/api/admin/login", headers: { origin }, payload: { email: user.email, password } });
    assert.equal(result.statusCode, 200);
    return { cookie: String(result.headers["set-cookie"]).split(";")[0], origin, "x-csrf-token": result.json().csrfToken };
  }
  return { app, user, calls, login };
}
test("news API enforces login, permissions, exact origin and CSRF before mutations", async t => {
  const { app, login, user, calls } = fixture(); t.after(() => app.close());
  assert.equal((await app.inject("/api/admin/news")).statusCode, 401);
  const headers = await login();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/news", headers: { cookie: headers.cookie, origin: headers.origin }, payload: body })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/news", headers: { ...headers, origin: "https://evil.test" }, payload: body })).statusCode, 403);
  user.permissions = ["admin.access", "news.read"];
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/news", headers, payload: body })).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: `/api/admin/news/${id}`, headers, payload: body })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/news/upload", headers })).statusCode, 403);
  assert.deepEqual(calls, []);
});
test("news API lists filters, creates sanitized drafts, rejects malformed IDs and exposes only public API", async t => {
  const { app, login } = fixture(); t.after(() => app.close()); const headers = await login();
  assert.equal((await app.inject({ url: "/api/admin/news?page=2&status=draft&search=test", headers })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/admin/news?page=0", headers })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/admin/news/options", headers })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/admin/news/invalid", headers })).statusCode, 400);
  const created = await app.inject({ method: "POST", url: "/api/admin/news", headers, payload: { ...body, content: "<p>Texto<script>bad()</script></p>" } });
  assert.equal(created.statusCode, 201); assert.equal(created.json().content, "<p>Texto</p>");
  assert.equal((await app.inject({ method: "PUT", url: `/api/admin/news/${id}`, headers, payload: { ...body, version: new Date().toISOString() } })).statusCode, 200);
  assert.deepEqual((await app.inject("/api/news?featured=true")).json(), { items: [{ title: "Featured" }] });
  assert.equal((await app.inject("/api/news?featured=invalid")).statusCode, 400);
  assert.equal((await app.inject('/api/news/browse?page=0')).statusCode,400);
  assert.equal((await app.inject('/api/news/browse?pageSize=100')).statusCode,400);
  assert.equal((await app.inject('/api/news/browse?category=bad%20slug')).statusCode,400);
  const browse=await app.inject('/api/news/browse?category=politica&page=2&pageSize=12'); assert.equal(browse.statusCode,200); assert.equal(browse.json().page,2); assert.equal(browse.json().pageSize,12);
  const crossOrigin = await app.inject({ url: "/api/news", headers: { origin: "http://localhost:5500" } });
  assert.equal(crossOrigin.headers["access-control-allow-origin"], "http://localhost:5500");
  assert.equal(crossOrigin.headers["access-control-allow-credentials"], undefined);
  assert.equal((await app.inject({ url: "/api/news", headers: { origin: "null" } })).headers["access-control-allow-origin"], "null");
  assert.equal((await app.inject({ url: "/api/news", headers: { origin: "https://evil.test" } })).headers["access-control-allow-origin"], undefined);
  assert.equal((await app.inject("/api/news/nonexistent")).statusCode, 404);
  assert.equal((await app.inject("/media/news/not-a-file")).statusCode, 404);
});
test("multipart upload stores a randomized WebP, serves the image and ignores the original filename", async t => {
  const { app, login } = fixture(); t.after(() => app.close());
  const headers = await login();
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
  const boundary = "news-test-boundary";
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="../../fake.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const response = await app.inject({ method: "POST", url: "/api/admin/news/upload", headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
  assert.equal(response.statusCode, 201);
  const url = response.json().imageUrl;
  assert.match(url, /^\/media\/news\/[0-9a-f-]{36}\.webp$/);
  t.after(() => unlink(resolve(uploadDirectory, url.split("/").at(-1)!)));
  const image = await app.inject(url);
  assert.equal(image.statusCode, 200); assert.equal(image.headers["content-type"], "image/webp");
  assert.equal((await sharp(image.rawPayload).metadata()).format, "webp");
});
