import { and, eq, sql, count, desc, asc, ilike, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as s from "../db/schema.js";
import { assertNewsPermission, NewsError, slugify, sanitizeContent, type NewsInput } from "./validation.js";
import { assertImagesExist } from "./media.js";
import { withCredits, type Source } from '../rewrite/source.js';

export type NewsRecord = typeof s.news.$inferSelect & { tags: string[]; images: typeof s.newsImages.$inferSelect[] };
export type ListOptions = { page: number; search: string; status?: typeof s.news.$inferSelect.status };
export type BrowseOptions = { page: number; pageSize: number; category?: string; search: string };
export interface NewsStore {
  list(options: ListOptions): Promise<{ items: typeof s.news.$inferSelect[]; total: number; page: number; pageSize: number }>;
  get(id: string): Promise<NewsRecord | undefined>;
  options(): Promise<{ categories: Array<{ id: string; name: string }>; tags: Array<{ name: string }> }>;
  save(id: string | undefined, input: NewsInput, actorId: string, permissions: string[], origin?: {source:Source;jobId:string}): Promise<NewsRecord>;
  publishDue(): Promise<number>;
  publicList(featured: boolean): Promise<unknown[]>;
  publicBySlug?(slug: string): Promise<Record<string, unknown> | undefined>;
  publicBrowse?(options: BrowseOptions): Promise<{ items: unknown[]; total: number; page: number; pageSize: number; categories: Record<string, any>[]; featured: unknown[] }>;
}
export function createNewsStore(pool: Pool, checkImages = assertImagesExist): NewsStore {
  const db = drizzle(pool);
  async function assertTarget() { const result = await db.execute(sql`SELECT current_database() AS database`); if (result.rows[0]?.database !== "informe67") throw new Error("Destino inesperado."); }
  async function get(id: string): Promise<NewsRecord | undefined> {
    await assertTarget();
    const [news] = await db.select().from(s.news).where(eq(s.news.id, id));
    if (!news) return undefined;
    const tags = await db.select({ name: s.tags.name }).from(s.newsTags).innerJoin(s.tags, eq(s.newsTags.tagId, s.tags.id)).where(eq(s.newsTags.newsId, id));
    const images = await db.select().from(s.newsImages).where(eq(s.newsImages.newsId, id)).orderBy(s.newsImages.sortOrder);
    return { ...news, tags: tags.map(t => t.name), images };
  }
  return {
    get,
    async list(options) {
      await assertTarget();
      const where = and(options.search ? ilike(s.news.title, `%${options.search.replace(/[\\%_]/g, "\\$&")}%`) : undefined, options.status ? eq(s.news.status, options.status) : undefined);
      const [total] = await db.select({ total: count() }).from(s.news).where(where);
      const items = await db.select().from(s.news).where(where).orderBy(desc(s.news.updatedAt), s.news.id).limit(20).offset((options.page - 1) * 20);
      return { items, total: total.total, page: options.page, pageSize: 20 };
    },
    async options() {
      await assertTarget();
      return { categories: await db.select({ id: s.categories.id, name: s.categories.name }).from(s.categories).orderBy(s.categories.name), tags: await db.select({ name: s.tags.name }).from(s.tags).orderBy(s.tags.name).limit(1000) };
    },
    async save(id, input, actorId, permissions, origin) {
      await assertTarget();
      await checkImages(input.images.map(i => i.imageUrl));
      try {
        return await db.transaction(async tx => {
          const [old] = id ? await tx.select().from(s.news).where(eq(s.news.id, id)).for("update") : [];
          if (id && !old) throw new NewsError(404, "Matéria não encontrada.");
          assertNewsPermission(input, old, permissions);
          if (old && (!input.version || Date.parse(input.version) !== old.updatedAt.getTime())) throw new NewsError(409, "Outra pessoa alterou esta matéria. Reabra antes de salvar.");
          if (input.categoryId) { const [category] = await tx.select({ id: s.categories.id }).from(s.categories).where(eq(s.categories.id, input.categoryId)); if (!category) throw new NewsError(400, "Categoria não encontrada."); }
          const { tags, images, version: _version, ...fields } = input;
          const persisted = old ? (await tx.select({value:s.portalSettings.value}).from(s.portalSettings).where(eq(s.portalSettings.key,`rewrite.news.${old.id}`)))[0]?.value as {source:Source;jobId:string}|undefined : undefined;
          const provenance = persisted || origin;
          if(provenance)fields.content=sanitizeContent(withCredits(fields.content,provenance.source));
          const updatedAt = new Date(Math.max(Date.now(), (old?.updatedAt.getTime() ?? 0) + 1));
          const publishedAt = input.status === "published" ? old?.publishedAt ?? updatedAt : old?.publishedAt ?? null;
          const [saved] = old
            ? await tx.update(s.news).set({ ...fields, publishedAt, updatedAt }).where(eq(s.news.id, old.id)).returning()
            : await tx.insert(s.news).values({ ...fields, authorId: actorId, publishedAt, updatedAt }).returning();
          if(provenance&&!persisted)await tx.insert(s.portalSettings).values({key:`rewrite.news.${saved.id}`,value:provenance,description:'Origem e créditos da reescrita editorial',updatedBy:actorId});
          await tx.delete(s.newsTags).where(eq(s.newsTags.newsId, saved.id));
          for (const name of tags) {
            let [tag] = await tx.select().from(s.tags).where(sql`lower(${s.tags.name}) = ${name.toLowerCase()}`);
            if (!tag) {
              const slug = slugify(name);
              await tx.insert(s.tags).values({ name, slug }).onConflictDoNothing();
              [tag] = await tx.select().from(s.tags).where(sql`lower(${s.tags.name}) = ${name.toLowerCase()}`);
              if (!tag) throw new NewsError(409, "Já existe uma tag com o mesmo slug. Use a tag existente.");
            }
            await tx.insert(s.newsTags).values({ newsId: saved.id, tagId: tag.id }).onConflictDoNothing();
          }
          await tx.delete(s.newsImages).where(eq(s.newsImages.newsId, saved.id));
          if (images.length) await tx.insert(s.newsImages).values(images.map((image, sortOrder) => ({ ...image, newsId: saved.id, sortOrder })));
          await tx.insert(s.auditLogs).values({ actorId, action: old ? `news.save.${input.status}` : `news.create.${input.status}`, entityType: "news", entityId: saved.id, metadata: { previousStatus: old?.status ?? null, status: saved.status } });
          return { ...saved, tags, images: await tx.select().from(s.newsImages).where(eq(s.newsImages.newsId, saved.id)).orderBy(s.newsImages.sortOrder) };
        });
      } catch (error) {
        const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
        if (code === "23505") throw new NewsError(409, "Já existe uma matéria com este slug.");
        if (code === "23503") throw new NewsError(400, "Uma referência foi removida. Atualize a matéria.");
        throw error;
      }
    },
    async publishDue() {
      await assertTarget();
      return db.transaction(async tx => {
        const rows = await tx.update(s.news).set({ status: "published", publishedAt: s.news.scheduledAt, updatedAt: new Date() }).where(and(eq(s.news.status, "scheduled"), lte(s.news.scheduledAt, new Date()))).returning({ id: s.news.id });
        if (rows.length) await tx.insert(s.auditLogs).values(rows.map(row => ({ action: "news.publish.scheduled", entityType: "news", entityId: row.id })));
        return rows.length;
      });
    },
    async publicList(featured) {
      await assertTarget();
      return db.select({ id: s.news.id, title: s.news.title, slug: s.news.slug, summary: s.news.summary, publishedAt: s.news.publishedAt, categoryId: s.news.categoryId, categoryName: s.categories.name, isFeatured: s.news.isFeatured, featuredOrder: s.news.featuredOrder, coverUrl: s.newsImages.imageUrl, coverAlt: s.newsImages.altText }).from(s.news).leftJoin(s.categories, eq(s.news.categoryId, s.categories.id)).leftJoin(s.newsImages, and(eq(s.newsImages.newsId, s.news.id), eq(s.newsImages.isCover, true))).where(and(eq(s.news.status, "published"), lte(s.news.publishedAt, new Date()), featured ? eq(s.news.isFeatured, true) : undefined)).orderBy(...(featured ? [asc(s.news.featuredOrder), desc(s.news.publishedAt)] : [desc(s.news.publishedAt)])).limit(50);
    },
    async publicBySlug(slug) {
      await assertTarget();
      const [row] = await db.select({ id: s.news.id, title: s.news.title, slug: s.news.slug, summary: s.news.summary, content: s.news.content, publishedAt: s.news.publishedAt, categoryName: s.categories.name, authorName: s.users.displayName, seoTitle: s.news.seoTitle, seoDescription: s.news.seoDescription, canonicalUrl: s.news.canonicalUrl, seoNoIndex: s.news.seoNoIndex }).from(s.news).innerJoin(s.users, eq(s.news.authorId, s.users.id)).leftJoin(s.categories, eq(s.news.categoryId, s.categories.id)).where(and(eq(s.news.slug, slug), eq(s.news.status, "published"), lte(s.news.publishedAt, new Date()))).limit(1);
      if (!row) return undefined;
      const detail = await get(row.id);
      return { ...row, content: sanitizeContent(row.content), tags: detail?.tags ?? [], images: detail?.images ?? [] };
    },
    async publicBrowse(options) {
      await assertTarget();
      const where = and(eq(s.news.status, "published"), lte(s.news.publishedAt, new Date()), options.category ? eq(s.categories.slug, options.category) : undefined, options.search ? ilike(s.news.title, `%${options.search.replace(/[\\%_]/g, "\\$&")}%`) : undefined);
      const [total] = await db.select({ total: count() }).from(s.news).leftJoin(s.categories, eq(s.news.categoryId, s.categories.id)).where(where);
      const items = await db.select({ id: s.news.id, title: s.news.title, slug: s.news.slug, summary: s.news.summary, publishedAt: s.news.publishedAt, categoryName: s.categories.name, categorySlug: s.categories.slug, isFeatured: s.news.isFeatured, featuredOrder: s.news.featuredOrder, coverUrl: s.newsImages.imageUrl, coverAlt: s.newsImages.altText }).from(s.news).leftJoin(s.categories, eq(s.news.categoryId, s.categories.id)).leftJoin(s.newsImages, and(eq(s.newsImages.newsId, s.news.id), eq(s.newsImages.isCover, true))).where(where).orderBy(desc(s.news.publishedAt), s.news.id).limit(options.pageSize).offset((options.page - 1) * options.pageSize);
      const categories = await db.execute(sql`
        SELECT c.id, c.name, c.slug,
          (SELECT count(*)::int FROM public.news n WHERE n.category_id=c.id AND n.status='published' AND n.published_at<=statement_timestamp()) AS total,
          h.highlight
        FROM public.categories c
        LEFT JOIN LATERAL (
          SELECT jsonb_build_object('id',n.id,'title',n.title,'slug',n.slug,'summary',n.summary,'publishedAt',n.published_at,'categoryName',c.name,'categorySlug',c.slug,'coverUrl',i.image_url,'coverAlt',i.alt_text) AS highlight
          FROM public.news n LEFT JOIN public.news_images i ON i.news_id=n.id AND i.is_cover=true
          WHERE n.category_id=c.id AND n.status='published' AND n.published_at<=statement_timestamp()
          ORDER BY n.is_featured DESC,n.featured_order ASC NULLS LAST,n.published_at DESC,n.id LIMIT 1
        ) h ON true
        WHERE c.is_active=true ORDER BY c.sort_order,c.name,c.id
      `);
      return { items, total: total.total, page: options.page, pageSize: options.pageSize, categories: categories.rows, featured: (await this.publicList(true)).slice(0, 4) };
    },
  };
}
