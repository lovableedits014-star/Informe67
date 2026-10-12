// Terminal-only bulk migration. Run only with explicit authorization to publish originals.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { parseExport, extractImages, downloadImage, plain, seo } from "./temp-wordpress.js";
import { loadBackendEnvironment } from "../src/config/environment.js";
import { readMigrationConfig } from "../src/db/migration-config.js";
import { sanitizeContent, slugify } from "../src/news/validation.js";
import { uploadDirectory } from "../src/news/media.js";
import { hashPassword } from "../src/admin/password.js";
import * as s from "../src/db/schema.js";

const args = process.argv.slice(2);
if (!args.includes("--publish-originals") || !args.includes("--xml")) throw Error("Exige --xml CAMINHO e --publish-originals após autorização explícita.");
loadBackendEnvironment(import.meta.url);
const raw = await readFile(resolve(args[args.indexOf("--xml") + 1]), "utf8"), plan = parseExport(raw);
const pool = new Pool({ ...readMigrationConfig(process.env), max: 1 }), db = drizzle(pool);
const dir = resolve("backups/wordpress-migration", plan.source); await mkdir(dir, { recursive: true }); await mkdir(uploadDirectory, { recursive: true });
const cachePath = resolve(dir, "image-cache.json"), reportPath = resolve(dir, "bulk-report.json");
type Cached = { localUrl?: string; hash?: string; bytes?: number; error?: string };
let cache: Record<string, Cached> = {};
try { cache = JSON.parse(await readFile(cachePath, "utf8")); } catch (error) { if ((error as any).code !== "ENOENT") throw error; }
const report: any = { timestamp: new Date().toISOString(), source: plan.site.href, xmlSha256: createHash("sha256").update(raw).digest("hex"), total: plan.posts.length, imported: [], publishedSample: [], skipped: [], errors: [], warnings: [], categories: [], images: {} };
const checkpoint = async () => { await writeFile(cachePath, JSON.stringify(cache, null, 2)); await writeFile(reportPath, JSON.stringify(report, null, 2)); };
const key = (id: string) => `migration.wordpress.${plan.source}.post.${id}`;
try {
  if ((await pool.query("SELECT current_database() AS database")).rows[0].database !== "informe67") throw Error("Destino inesperado.");
  // Reuse the validated sample's images, and any previously completed media downloads.
  const markers = await db.select().from(s.portalSettings).where(sql`${s.portalSettings.key} LIKE ${`migration.wordpress.${plan.source}.post.%`}`);
  for (const m of markers) for (const image of (m.value as any).imageMappings ?? []) {
    try { await access(resolve(uploadDirectory, image.target.split("/").at(-1))); cache[image.source] = { localUrl: image.target }; } catch {}
  }
  for (const [url, entry] of Object.entries(cache)) if (entry.localUrl) {
    try { await access(resolve(uploadDirectory, entry.localUrl.split("/").at(-1)!)); } catch { delete cache[url]; }
  }
  const terms = new Map(plan.posts.flatMap(p => p.categories.map(t => [slugify(t.slug || t.name), t] as const)));
  const categoryIds = new Map<string, string>();
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(670012)`);
    for (const [slug, term] of terms) {
      if (!slug || slug.length > 160 || !term.name || term.name.length > 120) throw Error(`Categoria inválida: ${slug}`);
      let [row] = await tx.select().from(s.categories).where(eq(s.categories.slug, slug));
      let created = false;
      if (!row) { [row] = await tx.insert(s.categories).values({ slug, name: term.name.charAt(0).toUpperCase() + term.name.slice(1) }).returning(); created = true; }
      categoryIds.set(slug, row.id); report.categories.push({ originalName: term.name, slug, id: row.id, created });
    }
    await tx.insert(s.auditLogs).values({ action: "migration.wordpress.categories", entityType: "categories", metadata: { source: plan.site.href, count: terms.size } });
  });
  const urls = new Set<string>();
  for (const p of plan.posts) { const extraction = extractImages(p, plan.attachments, plan.site); extraction.images.forEach(i => urls.add(i.url)); extraction.dom.window.close(); }
  const hashes = new Map(Object.values(cache).filter(v => v.hash && v.localUrl).map(v => [v.hash!, v.localUrl!]));
  const pending = [...urls].filter(url => !cache[url]?.localUrl);
  console.info(`Categorias conferidas: ${terms.size}. Imagens a recuperar: ${pending.length}.`);
  for (let offset = 0; offset < pending.length; offset += 3) {
    await Promise.all(pending.slice(offset, offset + 3).map(async url => {
      try {
        const bytes = await downloadImage(url, plan.site), hash = createHash("sha256").update(bytes).digest("hex");
        let localUrl = hashes.get(hash);
        if (!localUrl) { localUrl = `/media/news/${randomUUID()}.webp`; hashes.set(hash, localUrl); await writeFile(resolve(uploadDirectory, localUrl.split("/").at(-1)!), bytes, { flag: "wx" }); }
        cache[url] = { localUrl, hash, bytes: bytes.length };
      } catch (error) { cache[url] = { error: (error as Error).message }; }
    }));
    if (offset % 24 === 0 || offset + 3 >= pending.length) { console.info(`Imagens verificadas: ${Math.min(offset + 3, pending.length)}/${pending.length}.`); await checkpoint(); }
  }
  report.images = { referenced: urls.size, recovered: [...urls].filter(u => cache[u]?.localUrl).length, missing: [...urls].filter(u => !cache[u]?.localUrl).map(url => ({ url, reason: cache[url]?.error ?? "Ausente" })), files: new Set(Object.values(cache).map(c => c.localUrl).filter(Boolean)).size };
  // The export's 618 published posts have identical local/GMT timestamps (UTC).
  // Drafts with zero GMT fields retain their available WordPress local timestamps.
  const fallbackDate = (value: string) => { const date = new Date(value.replace(" ", "T") + "Z"); return Number.isFinite(date.getTime()) ? date : null; };
  for (const post of plan.posts) {
    try {
      const result = await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(670012)`);
        const [marker] = await tx.select().from(s.portalSettings).where(eq(s.portalSettings.key, key(post.id)));
        if (marker) {
          const metadata = marker.value as any;
          const [news] = await tx.select().from(s.news).where(eq(s.news.id, metadata.newsId));
          if (!news) throw Error("Mapa de migração aponta para uma matéria ausente.");
          if (metadata.validationSample && post.status === "publish" && news.status === "draft") {
            await tx.update(s.news).set({ status: "published", publishedAt: post.createdAt ?? news.publishedAt, updatedAt: news.updatedAt }).where(eq(s.news.id, news.id));
            await tx.update(s.portalSettings).set({ value: { ...metadata, validationSample: false } }).where(eq(s.portalSettings.key, marker.key));
            await tx.insert(s.auditLogs).values({ action: "migration.wordpress.publish-sample", entityType: "news", entityId: news.id });
            return { kind: "publishedSample", postId: post.id, id: news.id };
          }
          return { kind: "skipped", postId: post.id, id: news.id };
        }
        const createdAt = post.createdAt ?? fallbackDate(post.localCreatedAt), updatedAt = post.updatedAt ?? fallbackDate(post.localUpdatedAt) ?? createdAt;
        if (!createdAt || !updatedAt || !post.title || post.title.length > 240 || !post.slug || post.slug.length > 260) throw Error("Data, título ou slug exige revisão.");
        const [collision] = await tx.select().from(s.news).where(eq(s.news.slug, post.slug));
        if (collision) throw Error("Slug existente sem mapa de origem; não sobrescrito.");
        const originalAuthor = plan.authors.find(a => a.login === post.author); if (!originalAuthor) throw Error("Autor ausente.");
        let [author] = await tx.select().from(s.users).where(sql`lower(${s.users.email}) = ${originalAuthor.email.toLowerCase()}`);
        if (!author) [author] = await tx.insert(s.users).values({ email: originalAuthor.email || `wordpress-${originalAuthor.id}-${plan.source}@migration.invalid`, displayName: originalAuthor.name || originalAuthor.login, isActive: false, passwordHash: await hashPassword(randomBytes(48).toString("hex")) }).returning();
        const extraction = extractImages(post, plan.attachments, plan.site);
        let content: string;
        try {
          for (const img of extraction.dom.window.document.querySelectorAll("img")) {
            const source = img.getAttribute("data-migration-url") ?? "", entry = cache[source];
            if (entry?.localUrl) { img.setAttribute("src", entry.localUrl); img.setAttribute("alt", img.getAttribute("alt") || post.title); }
            else { const placeholder = extraction.dom.window.document.createElement("p"); placeholder.textContent = `[Imagem original indisponível: ${img.getAttribute("alt") || "imagem da matéria"}]`; img.replaceWith(placeholder); }
          }
          content = sanitizeContent(extraction.dom.window.document.body.innerHTML.replace(/\[\/?(?:caption|gallery|embed|[a-z][a-z0-9]*_[a-z0-9_]+)\b[^\]]*\]/gi, ""));
        } finally { extraction.dom.window.close(); }
        if (!plain(content)) throw Error("Conteúdo editorial vazio.");
        const rawSeo = seo(post), fields = { ...rawSeo, seoTitle: rawSeo.seoTitle?.slice(0, 240) || null, seoDescription: rawSeo.seoDescription?.slice(0, 320) || null };
        if (fields.canonicalUrl) { try { const u = new URL(fields.canonicalUrl); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw Error(); } catch { fields.canonicalUrl = null; report.warnings.push({ postId: post.id, message: "Canônica inválida preservada apenas no mapa." }); } }
        const status = post.status === "publish" ? "published" : "draft";
        const categoryId = categoryIds.get(slugify(post.categories[0]?.slug || post.categories[0]?.name || "")) ?? null;
        if (!categoryId && post.categories.length) throw Error("Categoria não mapeada.");
        const [news] = await tx.insert(s.news).values({ title: post.title, slug: post.slug, summary: plain(post.summary).slice(0, 500) || null, content, status, authorId: author.id, categoryId, createdAt, updatedAt, publishedAt: status === "published" ? createdAt : null, ...fields }).returning();
        const imageMappings: any[] = [], used = new Set<string>(); let coverSet = false;
        for (const image of extraction.images) {
          const entry = cache[image.url]; if (!entry?.localUrl) continue;
          imageMappings.push({ source: image.url, target: entry.localUrl });
          if (used.has(entry.localUrl)) continue; used.add(entry.localUrl);
          const isCover = image.cover && !coverSet; if (isCover) coverSet = true;
          await tx.insert(s.newsImages).values({ newsId: news.id, imageUrl: entry.localUrl, altText: plain(image.alt).slice(0, 300) || post.title, caption: plain(image.caption).slice(0, 500) || null, isCover, sortOrder: used.size - 1 });
        }
        for (const term of post.tags) {
          await tx.insert(s.tags).values({ name: term.name, slug: slugify(term.slug || term.name) }).onConflictDoNothing();
          const [tag] = await tx.select().from(s.tags).where(sql`lower(${s.tags.name}) = ${term.name.toLowerCase()}`); if (!tag) throw Error("Tag não mapeada.");
          await tx.insert(s.newsTags).values({ newsId: news.id, tagId: tag.id }).onConflictDoNothing();
        }
        const missingImages = extraction.images.filter(i => !cache[i.url]?.localUrl).map(i => ({ source: i.url, reason: cache[i.url]?.error }));
        const metadata = { source: plan.site.href, wordpressId: post.id, newsId: news.id, oldUrl: post.url, oldGuid: post.guid, oldSlug: post.oldSlug, targetPath: `/noticia.html?slug=${news.slug}`, originalStatus: post.status, originalSummary: post.summary, originalDates: { createdAt: post.createdAt, updatedAt: post.updatedAt, localCreatedAt: post.localCreatedAt, localUpdatedAt: post.localUpdatedAt }, originalAuthor, mappedAuthorId: author.id, categories: post.categories, primaryCategoryId: categoryId, tags: post.tags, seoMetadata: post.meta, imageMappings, missingImages, validationSample: false };
        await tx.insert(s.portalSettings).values({ key: key(post.id), value: metadata, description: "Migração WordPress: vínculos e URLs originais para redirecionamentos futuros" });
        await tx.insert(s.auditLogs).values({ action: `migration.wordpress.import.${status}`, entityType: "news", entityId: news.id, metadata: { wordpressId: post.id, missingImages: missingImages.length } });
        return { kind: "imported", postId: post.id, id: news.id, status, categoryId, images: used.size, missingImages: missingImages.length };
      });
      report[result.kind].push(result);
    } catch (error) { report.errors.push({ postId: post.id, message: (error as Error).message }); }
    const done = report.imported.length + report.publishedSample.length + report.skipped.length + report.errors.length;
    if (done % 25 === 0 || done === plan.posts.length) { console.info(`Matérias processadas: ${done}/${plan.posts.length}; erros: ${report.errors.length}.`); await checkpoint(); }
  }
  report.finishedAt = new Date().toISOString(); await checkpoint();
  console.info(JSON.stringify({ imported: report.imported.length, samplePublished: report.publishedSample.length, skipped: report.skipped.length, errors: report.errors, images: { recovered: report.images.recovered, missing: report.images.missing.length }, categoriesCreated: report.categories.filter((c: any) => c.created).length, reportPath }, null, 2));
  if (report.errors.length) process.exitCode = 1;
} finally { await pool.end(); }
