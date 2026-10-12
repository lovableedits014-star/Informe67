// One-time terminal migration. This script deliberately has no bulk-import mode.
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { JSDOM } from "jsdom";
import sharp from "sharp";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { loadBackendEnvironment } from "../src/config/environment.js";
import { readMigrationConfig } from "../src/db/migration-config.js";
import { sanitizeContent, slugify } from "../src/news/validation.js";
import { processImage, uploadDirectory } from "../src/news/media.js";
import { hashPassword } from "../src/admin/password.js";
import * as s from "../src/db/schema.js";

const text = (e: Element, name: string) => e.getElementsByTagName(name)[0]?.textContent ?? "";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Term = { name: string; slug: string };
type Author = { login: string; email: string; name: string; id: string };
type Post = { id: string; title: string; slug: string; oldSlug: string; url: string; guid: string; content: string; summary: string; status: string; author: string; createdAt: Date | null; updatedAt: Date | null; localCreatedAt: string; localUpdatedAt: string; categories: Term[]; tags: Term[]; meta: Record<string, string>; coverId: string };
type Attachment = { id: string; url: string; alt: string; caption: string; title: string };
const seoKeys = /^(?:_aioseo_(?:title|description|keywords|canonical_url|robots_noindex|og_title|og_description|og_article_section|og_article_tags|twitter_title|twitter_description)|_yoast_wpseo_(?:title|metadesc|canonical|meta-robots-noindex|focuskw)|rank_math_(?:title|description|canonical_url|robots|focus_keyword)|_seopress_(?:titles_title|titles_desc|titles_noindex|titles_canonical|analysis_target_kw))$/;
function wpDate(gmt: string, fallback: string): Date | null {
  const value = gmt && !gmt.startsWith("0000-") ? `${gmt.replace(" ", "T")}Z` : fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
export function parseExport(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Declarações externas não são aceitas no XML.");
  const dom = new JSDOM(xml, { contentType: "text/xml" });
  try {
    const d = dom.window.document, channel = d.getElementsByTagName("channel")[0];
    if (!channel || text(channel, "wp:wxr_version") !== "1.2") throw new Error("Exportação WordPress 1.2 inválida.");
    const site = new URL(text(channel, "wp:base_blog_url"));
    if (!["http:", "https:"].includes(site.protocol) || site.username || site.password || isIP(site.hostname)) throw new Error("Origem WordPress inválida.");
    const source = digest(site.hostname).slice(0, 16);
    const authors = [...channel.getElementsByTagName("wp:author")].map(e => ({ id: text(e, "wp:author_id"), login: text(e, "wp:author_login"), email: text(e, "wp:author_email"), name: text(e, "wp:author_display_name") }));
    const attachments = new Map<string, Attachment>(), posts: Post[] = [], ignoredTypes: Record<string, number> = {};
    for (const e of channel.getElementsByTagName("item")) {
      const type = text(e, "wp:post_type"), id = text(e, "wp:post_id");
      if (!/^\d+$/.test(id)) throw new Error("ID WordPress inválido.");
      const meta: Record<string, string> = {};
      for (const m of e.getElementsByTagName("wp:postmeta")) meta[text(m, "wp:meta_key")] = text(m, "wp:meta_value");
      if (type === "attachment") { attachments.set(id, { id, url: text(e, "wp:attachment_url"), alt: meta._wp_attachment_image_alt ?? "", caption: text(e, "excerpt:encoded"), title: text(e, "title") }); continue; }
      if (type !== "post") { ignoredTypes[type] = (ignoredTypes[type] ?? 0) + 1; continue; }
      const taxonomy = (domain: string) => [...e.getElementsByTagName("category")].filter(c => c.getAttribute("domain") === domain).map(c => ({ name: c.textContent ?? "", slug: c.getAttribute("nicename") || slugify(c.textContent ?? "") }));
      const original = text(e, "wp:post_name"); let decoded = original;
      try { decoded = decodeURIComponent(original); } catch {}
      const title = text(e, "title");
      posts.push({ id, title, slug: slugify(decoded || title), oldSlug: original, url: text(e, "link"), guid: text(e, "guid"), content: text(e, "content:encoded"), summary: text(e, "excerpt:encoded"), status: text(e, "wp:status"), author: text(e, "dc:creator"), createdAt: wpDate(text(e, "wp:post_date_gmt"), text(e, "pubDate")), updatedAt: wpDate(text(e, "wp:post_modified_gmt"), text(e, "pubDate")), localCreatedAt: text(e, "wp:post_date"), localUpdatedAt: text(e, "wp:post_modified"), categories: taxonomy("category"), tags: taxonomy("post_tag"), meta: Object.fromEntries(Object.entries(meta).filter(([key]) => seoKeys.test(key))), coverId: meta._thumbnail_id ?? "" });
    }
    return { site, source, authors, attachments, posts, ignoredTypes };
  } finally { dom.window.close(); }
}

export function extractImages(post: Post, attachments: Map<string, Attachment>, site: URL) {
  // Parse inertly: scripts never execute and remote resources are not loaded.
  const dom = new JSDOM(`<body>${post.content}</body>`), images = new Map<string, { url: string; alt: string; caption: string; cover: boolean }>();
  const absolute = (value: string) => { try { return new URL(value, site).href; } catch { return value; } };
  const cover = attachments.get(post.coverId);
  if (cover) images.set(absolute(cover.url), { url: absolute(cover.url), alt: cover.alt || post.title, caption: cover.caption, cover: true });
  else if (post.coverId) images.set(`missing-attachment:${post.coverId}`, { url: `missing-attachment:${post.coverId}`, alt: post.title, caption: "", cover: true });
  for (const img of dom.window.document.querySelectorAll("img")) {
    const id = /wp-image-(\d+)/.exec(img.className)?.[1], attachment = id ? attachments.get(id) : undefined;
    const original = attachment?.url || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "";
    const url = absolute(original); img.setAttribute("data-migration-url", url);
    const existing = images.get(url);
    if (!existing) images.set(url, { url, alt: img.getAttribute("alt") || attachment?.alt || post.title, caption: attachment?.caption || "", cover: false });
  }
  // WordPress gallery IDs refer to exported attachments, not plugin code.
  for (const gallery of post.content.matchAll(/\[gallery\b[^\]]*ids=["']([\d, ]+)["'][^\]]*\]/g)) {
    for (const id of gallery[1].split(",").map(v => v.trim())) {
      const a = attachments.get(id); if (!a) continue;
      const url = absolute(a.url); if (!images.has(url)) images.set(url, { url, alt: a.alt || post.title, caption: a.caption, cover: false });
      const img = dom.window.document.createElement("img"); img.setAttribute("data-migration-url", url); dom.window.document.body.append(img);
    }
  }
  return { dom, images: [...images.values()] };
}
function publicAddress(address: string) {
  if (isIP(address) === 4) { const [a, b] = address.split(".").map(Number); return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)); }
  return isIP(address) === 6 && !/^(?:::|fc|fd|fe[89ab]|::ffff:)/i.test(address);
}
export async function downloadImage(value: string, site: URL, allowedImageHosts: string[] = []) {
  let url = new URL(value);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  try {
    for (let redirect = 0; redirect < 4; redirect++) {
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port)) || ![site.hostname, `www.${site.hostname.replace(/^www\./, "")}`, ...allowedImageHosts].includes(url.hostname)) throw new Error("Origem de imagem não permitida.");
      const addresses = await lookup(url.hostname, { all: true });
      if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error("Destino de imagem não público.");
      const response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "User-Agent": "Informe67-Migration/1.0" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); url = new URL(response.headers.get("location") ?? "", url); continue; }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const chunks: Uint8Array[] = []; let length = 0;
      if (!response.body) throw new Error("Imagem sem conteúdo.");
      for await (const chunk of response.body) { length += chunk.length; if (length > 5 * 1024 * 1024) throw new Error("Imagem maior que 5 MB."); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks);
      const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
      if (metadata.format === "heif" && metadata.compression === "av1" && (metadata.pages ?? 1) === 1) {
        return await processImage(await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer());
      }
      return await processImage(bytes);
    }
    throw new Error("Excesso de redirecionamentos na imagem.");
  } finally { clearTimeout(timer); }
}
export function plain(html: string) { const dom = new JSDOM(`<body>${html}</body>`); try { return dom.window.document.body.textContent?.trim() ?? ""; } finally { dom.window.close(); } }
export function seo(post: Post) {
  const m = post.meta;
  return { seoTitle: m._yoast_wpseo_title || m.rank_math_title || m._seopress_titles_title || m._aioseo_title || null, seoDescription: m._yoast_wpseo_metadesc || m.rank_math_description || m._seopress_titles_desc || m._aioseo_description || null, canonicalUrl: m._yoast_wpseo_canonical || m.rank_math_canonical_url || m._seopress_titles_canonical || m._aioseo_canonical_url || null, seoNoIndex: m._yoast_wpseo_meta_robots_noindex === "1" || m["_yoast_wpseo_meta-robots-noindex"] === "1" || m._seopress_titles_noindex === "yes" || m._aioseo_robots_noindex === "1" || (m.rank_math_robots ?? "").includes("noindex") };
}

async function main() {
  const args = process.argv.slice(2), arg = (name: string) => args[args.indexOf(name) + 1];
  if (!args.includes("--xml")) throw new Error("Informe --xml CAMINHO e --mode dry-run ou import-one.");
  const mode = args.includes("--mode") ? arg("--mode") : "dry-run";
  if (!["dry-run", "import-one"].includes(mode)) throw new Error("Migração completa bloqueada: somente dry-run e import-one são permitidos.");
  loadBackendEnvironment(import.meta.url);
  const raw = await readFile(resolve(arg("--xml")), "utf8"), plan = parseExport(raw);
  const reportDir = resolve("backups/wordpress-migration", plan.source); await mkdir(reportDir, { recursive: true });
  const report: any = { mode, sourceSite: plan.site.href, xmlSha256: digest(raw), timestamp: new Date().toISOString(), counts: {}, preflight: {}, candidate: null, duplicates: [], warnings: [], recoveredImages: [], missingImages: [], pendingImages: [], errors: [] };
  const pool = new Pool({ ...readMigrationConfig(process.env), max: 1 }); const db = drizzle(pool);
  const states: Record<string, number> = {}; const categories = new Map<string, string>(), tags = new Map<string, string>();
  const allImages = new Set<string>();
  for (const post of plan.posts) {
    states[post.status] = (states[post.status] ?? 0) + 1; post.categories.forEach(t => categories.set(t.slug, t.name)); post.tags.forEach(t => tags.set(t.slug, t.name));
    const extraction = extractImages(post, plan.attachments, plan.site); extraction.images.forEach(i => allImages.add(i.url)); extraction.dom.window.close();
    if (!post.createdAt || !post.updatedAt || !post.title || post.title.length > 240 || !post.slug || post.slug.length > 260) report.warnings.push({ postId: post.id, issue: "Data, título ou slug exige revisão antes da importação." });
    if (post.categories.length > 1) report.warnings.push({ postId: post.id, issue: "Schema admite uma categoria principal; todas as categorias originais serão preservadas no mapa de migração." });
    if (post.oldSlug !== post.slug) report.warnings.push({ postId: post.id, issue: "Slug normalizado; URL e slug originais preservados no mapa." });
  }
  const attachmentImages = [...plan.attachments.values()].filter(a => /\.(?:jpe?g|png|webp|gif|avif)(?:\?|$)/i.test(a.url)).length;
  report.counts = { posts: plan.posts.length, statuses: states, drafts: states.draft ?? 0, categories: categories.size, tags: tags.size, images: attachmentImages, nonImageAttachments: plan.attachments.size - attachmentImages, attachments: plan.attachments.size, referencedImageUrls: allImages.size, authors: plan.authors.length, ignoredTypes: plan.ignoredTypes };
  report.seoMetadataFields = [...new Set(plan.posts.flatMap(p => Object.keys(p.meta)))];
  const repeatedSlugs = new Set<string>();
  for (const p of plan.posts) { if (repeatedSlugs.has(p.slug)) report.warnings.push({ postId: p.id, issue: "Slug duplicado dentro do XML; exige revisão." }); repeatedSlugs.add(p.slug); }
  const key = (id: string) => `migration.wordpress.${plan.source}.post.${id}`;
  try {
    const client = await pool.connect(); let existingNews: any[], existingMaps: any[];
    try {
      await client.query("BEGIN READ ONLY");
      if ((await client.query("SELECT current_database() AS database")).rows[0].database !== "informe67") throw new Error("Destino inesperado.");
      existingNews = (await client.query("SELECT id,slug FROM news")).rows;
      existingMaps = (await client.query("SELECT key,value FROM portal_settings WHERE key LIKE $1", [`migration.wordpress.${plan.source}.post.%`])).rows;
      report.preflight.existingNews = existingNews.length;
      report.preflight.database = "informe67"; report.preflight.tables = (await client.query("SELECT count(*)::int AS total FROM pg_tables WHERE schemaname='public'")).rows[0].total;
      await client.query("ROLLBACK");
    } finally { client.release(); }
    const api = await fetch("http://127.0.0.1:3000/api/health/db", { signal: AbortSignal.timeout(5000) });
    if (!api.ok || (await api.json() as any).database !== "available") throw new Error("Backend/PostgreSQL indisponível.");
    report.preflight.newsModule = "API e PostgreSQL disponíveis";
    await mkdir(uploadDirectory, { recursive: true });
    const probePath = resolve(uploadDirectory, `.migration-probe-${randomUUID()}`);
    try { await writeFile(probePath, "probe", { flag: "wx" }); if ((await readFile(probePath, "utf8")) !== "probe") throw new Error("Falha no armazenamento."); } finally { await unlink(probePath); }
    report.preflight.storage = "escrita/leitura/remoção confirmadas";
    const slugs = new Set(existingNews!.map(n => n.slug)), mapped = new Set(existingMaps!.map(m => m.key));
    for (const p of plan.posts) if (slugs.has(p.slug) || mapped.has(key(p.id))) report.duplicates.push({ postId: p.id, slug: p.slug, mapped: mapped.has(key(p.id)) });
    const candidate = args.includes("--post-id") ? plan.posts.find(p => p.id === arg("--post-id")) : [...plan.posts].filter(p => p.status === "publish" && plan.attachments.has(p.coverId) && !slugs.has(p.slug) && !mapped.has(key(p.id))).sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
    if (!candidate) throw new Error("Matéria de teste não encontrada.");
    report.candidate = { wordpressId: candidate.id, title: candidate.title, originalUrl: candidate.url, originalStatus: candidate.status, testStatus: "draft", createdAt: candidate.createdAt, updatedAt: candidate.updatedAt, slug: candidate.slug, categories: candidate.categories, authorLogin: candidate.author, seo: seo(candidate) };
    if (slugs.has(candidate.slug) || mapped.has(key(candidate.id))) { report.result = "skipped-existing"; return; }
    if (!candidate.createdAt || !candidate.updatedAt || candidate.title.length > 240 || candidate.slug.length > 260) throw new Error("Matéria de teste exige revisão de título, datas ou slug.");
    const extraction = extractImages(candidate, plan.attachments, plan.site), recovered = new Map<string, { bytes: Buffer; localUrl: string; alt: string; caption: string; cover: boolean }>();
    try {
      for (const image of extraction.images) {
        try {
          const bytes = await downloadImage(image.url, plan.site), localUrl = `/media/news/${randomUUID()}.webp`;
          recovered.set(image.url, { bytes, localUrl, alt: image.alt, caption: image.caption, cover: image.cover });
          report.recoveredImages.push({ source: image.url, localUrl: mode === "import-one" ? localUrl : null, bytes: bytes.length, cover: image.cover, stored: false });
        } catch (error) { report.missingImages.push({ source: image.url, postId: candidate.id, reason: (error as Error).message }); }
      }
      if (![...recovered.values()].some(i => i.cover)) throw new Error("Capa não recuperada; importação da amostra cancelada.");
      if (report.missingImages.length) throw new Error("Há imagens ausentes na amostra; importação cancelada para revisão.");
      for (const img of extraction.dom.window.document.querySelectorAll("img")) {
        const image = recovered.get(img.getAttribute("data-migration-url") ?? "");
        if (image) { img.setAttribute("src", image.localUrl); img.setAttribute("alt", image.alt); }
        else img.remove();
      }
      const html = extraction.dom.window.document.body.innerHTML.replace(/\[\/?(?:caption|gallery|embed|[a-z][a-z0-9]*_[a-z0-9_]+)\b[^\]]*\]/gi, "");
      const content = sanitizeContent(html);
      if (!plain(content)) throw new Error("Conteúdo editorial vazio após higienização.");
      report.candidate.sanitizedContentLength = content.length; report.candidate.originalContentLength = candidate.content.length;
      report.pendingImages = [...allImages].filter(url => !recovered.has(url));
      if (mode === "dry-run") { report.result = "simulation-complete-no-database-writes"; return; }
      // Exactly one post; a transaction keeps relationships and the deduplication marker atomic.
      const imported = await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(670012)`);
        const [marker] = await tx.select().from(s.portalSettings).where(eq(s.portalSettings.key, key(candidate.id)));
        const [collision] = await tx.select().from(s.news).where(eq(s.news.slug, candidate.slug));
        if (marker || collision) throw new Error("Matéria já existe; nenhuma duplicação permitida.");
        const originalAuthor = plan.authors.find(a => a.login === candidate.author);
        if (!originalAuthor) throw new Error("Autor original não encontrado no XML.");
        let [author] = await tx.select().from(s.users).where(sql`lower(${s.users.email}) = ${originalAuthor.email.toLowerCase()}`);
        if (!author) [author] = await tx.insert(s.users).values({ email: originalAuthor.email || `wordpress-${originalAuthor.id}-${plan.source}@migration.invalid`, displayName: originalAuthor.name || originalAuthor.login, isActive: false, passwordHash: await hashPassword(randomBytes(48).toString("hex")) }).returning();
        const getCategory = async (term: Term) => {
          const slug = slugify(term.slug || term.name); if (!slug || term.name.length > 120 || slug.length > 160) throw new Error("Categoria original exige revisão.");
          let [row] = await tx.select().from(s.categories).where(eq(s.categories.slug, slug));
          if (!row) [row] = await tx.insert(s.categories).values({ name: term.name, slug }).returning(); return row.id;
        };
        const categoryIds: string[] = []; for (const term of candidate.categories) categoryIds.push(await getCategory(term));
        const fields = seo(candidate);
        if ((fields.seoTitle?.length ?? 0) > 240 || (fields.seoDescription?.length ?? 0) > 320) throw new Error("SEO excede o limite do schema; revisão necessária sem truncar silenciosamente.");
        if (fields.canonicalUrl && !/^https?:\/\//i.test(fields.canonicalUrl)) throw new Error("URL canônica inválida.");
        if (plain(candidate.summary).length > 500) report.warnings.push({ postId: candidate.id, issue: "Resumo reduzido a 500 caracteres; resumo integral preservado no mapa de migração." });
        const [news] = await tx.insert(s.news).values({ title: candidate.title, slug: candidate.slug, summary: plain(candidate.summary).slice(0, 500) || null, content, status: "draft", authorId: author.id, categoryId: categoryIds[0] ?? null, createdAt: candidate.createdAt!, updatedAt: candidate.updatedAt!, publishedAt: candidate.status === "publish" ? candidate.createdAt : null, ...fields }).returning();
        for (const term of candidate.tags) {
          const slug = slugify(term.slug || term.name); if (!slug || term.name.length > 80 || slug.length > 100) throw new Error("Tag exige revisão.");
          let [tag] = await tx.select().from(s.tags).where(sql`lower(${s.tags.name}) = ${term.name.toLowerCase()}`);
          if (!tag) { await tx.insert(s.tags).values({ name: term.name, slug }).onConflictDoNothing(); [tag] = await tx.select().from(s.tags).where(sql`lower(${s.tags.name}) = ${term.name.toLowerCase()}`); }
          if (!tag) throw new Error("Colisão de slug de tag; revisão necessária.");
          await tx.insert(s.newsTags).values({ newsId: news.id, tagId: tag.id }).onConflictDoNothing();
        }
        let sortOrder = 0;
        for (const image of recovered.values()) {
          const path = resolve(uploadDirectory, image.localUrl.split("/").at(-1)!);
          await writeFile(path, image.bytes, { flag: "wx" });
          // Track only files written by this run for cleanup if the transaction fails.
          createdFiles.push(path);
          await tx.insert(s.newsImages).values({ newsId: news.id, imageUrl: image.localUrl, altText: plain(image.alt).slice(0, 300) || news.title, caption: plain(image.caption).slice(0, 500) || null, isCover: image.cover, sortOrder: sortOrder++ });
        }
        const metadata = { source: plan.site.href, wordpressId: candidate.id, newsId: news.id, oldUrl: candidate.url, oldGuid: candidate.guid, oldSlug: candidate.oldSlug, targetPath: `/noticia.html?slug=${news.slug}`, originalStatus: candidate.status, originalSummary: candidate.summary, originalDates: { createdAt: candidate.createdAt, updatedAt: candidate.updatedAt }, originalAuthor, mappedAuthorId: author.id, categories: candidate.categories, tags: candidate.tags, seoMetadata: candidate.meta, imageMappings: [...recovered].map(([url, image]) => ({ source: url, target: image.localUrl })), validationSample: true };
        await tx.insert(s.portalSettings).values({ key: key(candidate.id), value: metadata, description: "Migração WordPress: vínculos e URLs originais para redirecionamentos futuros" });
        await tx.insert(s.auditLogs).values({ action: "migration.wordpress.import-one", entityType: "news", entityId: news.id, metadata: { wordpressId: candidate.id, source: plan.site.href, sample: true } });
        return { id: news.id, slug: news.slug, status: news.status };
      });
      committed = true; report.result = "one-post-imported-as-draft"; report.imported = imported;
      report.recoveredImages.forEach((image: any) => { image.stored = true; });
    } finally { extraction.dom.window.close(); }
  } catch (error) { report.errors.push({ message: (error as Error).message }); process.exitCode = 1; }
  finally {
    await pool.end();
    if (!committed) for (const path of createdFiles) await unlink(path);
    const path = resolve(reportDir, `${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await writeFile(path, JSON.stringify(report, null, 2), { flag: "wx" });
    console.info(JSON.stringify({ mode, counts: report.counts, result: report.result, candidate: report.candidate?.wordpressId, recoveredImages: report.recoveredImages.length, missingImages: report.missingImages.length, errors: report.errors, reportPath: path }, null, 2));
  }
}
let committed = false; const createdFiles: string[] = [];
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
