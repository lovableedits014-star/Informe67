// Recover public external image references present in this specific export.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { parseExport, extractImages, downloadImage, plain } from "./temp-wordpress.js";
import { sanitizeContent } from "../src/news/validation.js";
import { uploadDirectory } from "../src/news/media.js";
import { loadBackendEnvironment } from "../src/config/environment.js";
import { readMigrationConfig } from "../src/db/migration-config.js";
import * as s from "../src/db/schema.js";

if (!process.argv.includes("--download-only") && !process.argv.includes("--apply")) throw Error("Informe --download-only ou --apply.");
const dir = resolve("backups/wordpress-migration/e40ebe81ab7cd739");
const plan = parseExport(await readFile("C:/Users/Mayer Baclan/Downloads/informe67notcias.WordPress.2026-10-12.xml", "utf8"));
const base = JSON.parse(await readFile(resolve(dir, "image-cache.json"), "utf8"));
let recovered: any = {}; try { recovered = JSON.parse(await readFile(resolve(dir, "external-image-cache.json"), "utf8")); } catch (error) { if ((error as any).code !== "ENOENT") throw error; }
const hosts = ["midiamaxproducao.s3.amazonaws.com", "agenciamsnoticias.com.br", "agenciadenoticias.ms.gov.br", "ichef.bbci.co.uk", "www.semadesc.ms.gov.br", "cdn.midiamax.com.br", "midiamax.uol.com.br", "i0.wp.com", "al.ms.gov.br", "s2-g1.glbimg.com", "uploads.metroimg.com", "i.metroimg.com", "semanaon.com.br"];
if (process.argv.includes("--download-only")) {
  const urls = Object.keys(base).filter(url => base[url].error && !recovered[url]?.localUrl);
  for (let offset = 0; offset < urls.length; offset += 3) {
    await Promise.all(urls.slice(offset, offset + 3).map(async url => {
      try {
        const alternatives = [url, url.replace(/-\d+x\d+(?=\.[^.]+$)/, "")];
        if (url.includes("midiamax.uol.com.br/")) alternatives.push(url.replace("midiamax.uol.com.br", "cdn.midiamax.com.br"), url.replace("midiamax.uol.com.br", "cdn.midiamax.com.br").replace(/-\d+x\d+(?=\.[^.]+$)/, ""));
        if (url.includes("i.metroimg.com/") && url.includes("/plain/")) alternatives.push(`https://uploads.metroimg.com/wp-content/uploads/${url.split("/plain/")[1]}`);
        let bytes: Buffer | undefined, retrievedFrom = "", lastError: unknown;
        for (const candidate of new Set(alternatives)) { try { bytes = await downloadImage(candidate, plan.site, hosts); retrievedFrom = candidate; break; } catch (error) { lastError = error; } }
        if (!bytes) throw lastError;
        const localUrl = `/media/news/${randomUUID()}.webp`; await writeFile(resolve(uploadDirectory, localUrl.split("/").at(-1)!), bytes, { flag: "wx" }); recovered[url] = { localUrl, bytes: bytes.length, retrievedFrom };
      }
      catch (error) { recovered[url] = { error: (error as Error).message }; }
    }));
    await writeFile(resolve(dir, "external-image-cache.json"), JSON.stringify(recovered, null, 2));
    if (offset % 24 === 0 || offset + 3 >= urls.length) console.info(`Referências externas verificadas: ${Math.min(offset + 3, urls.length)}/${urls.length}.`);
  }
  console.info(JSON.stringify({ recovered: Object.values(recovered).filter((r: any) => r.localUrl).length, missing: Object.values(recovered).filter((r: any) => !r.localUrl).length }));
} else {
  loadBackendEnvironment(import.meta.url); const pool = new Pool({ ...readMigrationConfig(process.env), max: 1 }), db = drizzle(pool);
  const report: any = { updated: [], errors: [], missing: Object.entries(recovered).filter(([_, entry]: any) => !entry.localUrl).map(([url, entry]: any) => ({ url, reason: entry.error })) };
  const render = (post: typeof plan.posts[number], cache: any) => {
    const extraction = extractImages(post, plan.attachments, plan.site);
    try {
      for (const img of extraction.dom.window.document.querySelectorAll("img")) {
        const source = img.getAttribute("data-migration-url") ?? "", entry = cache[source];
        if (entry?.localUrl) { img.setAttribute("src", entry.localUrl); img.setAttribute("alt", img.getAttribute("alt") || post.title); }
        else { const p = extraction.dom.window.document.createElement("p"); p.textContent = `[Imagem original indisponível: ${img.getAttribute("alt") || "imagem da matéria"}]`; img.replaceWith(p); }
      }
      return { content: sanitizeContent(extraction.dom.window.document.body.innerHTML.replace(/\[\/?(?:caption|gallery|embed|[a-z][a-z0-9]*_[a-z0-9_]+)\b[^\]]*\]/gi, "")), images: extraction.images };
    } finally { extraction.dom.window.close(); }
  };
  const merged = { ...base, ...Object.fromEntries(Object.entries(recovered).filter(([_, entry]: any) => entry.localUrl)) };
  try {
    if ((await pool.query("SELECT current_database() AS database")).rows[0].database !== "informe67") throw Error("Destino inesperado.");
    const maps = await db.select().from(s.portalSettings).where(sql`${s.portalSettings.key} LIKE ${`migration.wordpress.${plan.source}.post.%`}`);
    for (const map of maps) {
      const metadata = map.value as any;
      const additions = (metadata.missingImages ?? []).filter((image: any) => recovered[image.source]?.localUrl);
      if (!additions.length) continue;
      try {
        const post = plan.posts.find(p => p.id === metadata.wordpressId)!;
        const old = render(post, base), next = render(post, merged);
        await db.transaction(async tx => {
          const [news] = await tx.select().from(s.news).where(eq(s.news.id, metadata.newsId)).for("update");
          if (!news || news.content !== old.content) throw Error("Matéria alterada após a migração; conteúdo não sobrescrito.");
          const existing = await tx.select().from(s.newsImages).where(eq(s.newsImages.newsId, news.id));
          const used = new Set(existing.map(i => i.imageUrl)); let hasCover = existing.some(i => i.isCover);
          const mappings = [...metadata.imageMappings];
          for (const image of next.images) {
            const entry = recovered[image.url]; if (!entry?.localUrl) continue;
            mappings.push({ source: image.url, target: entry.localUrl });
            if (used.has(entry.localUrl)) continue; used.add(entry.localUrl);
            const cover = image.cover && !hasCover; if (cover) hasCover = true;
            await tx.insert(s.newsImages).values({ newsId: news.id, imageUrl: entry.localUrl, altText: plain(image.alt).slice(0, 300) || post.title, caption: plain(image.caption).slice(0, 500) || null, isCover: cover, sortOrder: used.size - 1 });
          }
          await tx.update(s.news).set({ content: next.content, updatedAt: news.updatedAt }).where(eq(s.news.id, news.id));
          await tx.update(s.portalSettings).set({ value: { ...metadata, imageMappings: mappings, missingImages: metadata.missingImages.filter((image: any) => !merged[image.source]?.localUrl) } }).where(eq(s.portalSettings.key, map.key));
          await tx.insert(s.auditLogs).values({ action: "migration.wordpress.recover-external-images", entityType: "news", entityId: news.id, metadata: { added: additions.length } });
        }); report.updated.push({ postId: post.id, images: additions.length });
      } catch (error) { report.errors.push({ postId: metadata.wordpressId, message: (error as Error).message }); }
    }
    await writeFile(resolve(dir, "external-image-repair-report.json"), JSON.stringify(report, null, 2));
    console.info(JSON.stringify({ updatedPosts: report.updated.length, errors: report.errors, missing: report.missing.length }));
  } finally { await pool.end(); }
}
