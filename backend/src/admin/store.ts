import { eq, sql, count, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "../db/schema.js";
import { newsPermissions } from "../news/validation.js";
import { NewsError, slugify } from "../news/validation.js";
import { createUser, type NewUser } from "./users.js";

export const modules = [
  { key: "news", label: "Notícias", permission: "news.read" },
  { key: "categories", label: "Categorias", permission: "categories.read" },
  { key: "images", label: "Imagens", permission: "images.read" },
  { key: "banners", label: "Banners", permission: "banners.read" },
  { key: "users", label: "Usuários", permission: "users.read" },
  { key: "settings", label: "Configurações", permission: "settings.read" },
] as const;
export type ModuleKey = typeof modules[number]["key"];
export const adminPermissions = ["admin.access", ...modules.map(m => m.permission), ...newsPermissions, "categories.delete", "categories.transfer", "categories.edit", "banners.manage", "users.create", "news.rewrite", "settings.ai.manage"];
export type AdminUser = { id: string; email: string; displayName: string; passwordHash: string; isActive: boolean; permissions: string[]; roles?: string[] };
export type Dashboard = { counts: Record<string, number>; recentNews: Array<{ id: string; title: string; status: string; updatedAt: Date }> };
export interface AdminStore {
  findByEmail(email: string): Promise<AdminUser | undefined>;
  findById(id: string): Promise<AdminUser | undefined>;
  dashboard(permissions: string[]): Promise<Dashboard>;
  list(module: ModuleKey): Promise<Record<string, unknown>[]>;
  audit(userId: string, action: string): Promise<void>;
  createUser?(input: NewUser, actorId: string): Promise<Record<string, unknown>>;
  deleteCategory?(id: string, targetId: string | null, actorId: string, canTransfer: boolean): Promise<{ moved: number }>;
  editCategory?(id: string, name: string, actorId: string): Promise<{ id: string; name: string; slug: string }>;
}

export function createAdminStore(pool: Pool): AdminStore {
  const db = drizzle(pool);
  async function assertTarget() {
    const result = await db.execute(sql`SELECT current_database() AS database`);
    if (result.rows[0]?.database !== "informe67") throw new Error("Destino administrativo inesperado.");
  }
  async function attachPermissions(user: typeof schema.users.$inferSelect | undefined) {
    if (!user) return undefined;
    const granted = await db.selectDistinct({ code: schema.permissions.code })
      .from(schema.userRoles)
      .innerJoin(schema.rolePermissions, eq(schema.userRoles.roleId, schema.rolePermissions.roleId))
      .innerJoin(schema.permissions, eq(schema.rolePermissions.permissionId, schema.permissions.id))
      .where(eq(schema.userRoles.userId, user.id));
    const roles = await db.select({ name: schema.roles.name }).from(schema.userRoles).innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id)).where(eq(schema.userRoles.userId, user.id));
    return { ...user, permissions: granted.map(p => p.code), roles: roles.map(r => r.name) };
  }
  return {
    async findByEmail(email) {
      await assertTarget();
      const [user] = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`).limit(1);
      return attachPermissions(user);
    },
    async findById(id) {
      await assertTarget();
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
      return attachPermissions(user);
    },
    async dashboard(granted) {
      await assertTarget();
      const counts: Record<string, number> = {};
      const tables = { news: schema.news, categories: schema.categories, images: schema.newsImages, banners: schema.banners, users: schema.users, settings: schema.portalSettings };
      for (const module of modules) {
        if (granted.includes(module.permission)) {
          const [row] = await db.select({ total: count() }).from(tables[module.key]);
          counts[module.key] = row.total;
        }
      }
      const recentNews = granted.includes("news.read")
        ? await db.select({ id: schema.news.id, title: schema.news.title, status: schema.news.status, updatedAt: schema.news.updatedAt }).from(schema.news).orderBy(desc(schema.news.updatedAt)).limit(5)
        : [];
      return { counts, recentNews };
    },
    async list(module) {
      await assertTarget();
      switch (module) {
        case "news": return db.select({ title: schema.news.title, slug: schema.news.slug, status: schema.news.status, updatedAt: schema.news.updatedAt }).from(schema.news).orderBy(desc(schema.news.updatedAt), schema.news.id).limit(50);
        case "categories": return (await db.execute(sql`SELECT c.id,c.name,c.slug,c.is_active AS "isActive",(SELECT count(*)::int FROM public.news n WHERE n.category_id=c.id) AS "newsCount",(SELECT count(*)::int FROM public.categories child WHERE child.parent_id=c.id) AS "childrenCount" FROM public.categories c ORDER BY c.sort_order,c.name,c.id`)).rows;
        case "images": return db.select({ altText: schema.newsImages.altText, credits: schema.newsImages.credits, isCover: schema.newsImages.isCover }).from(schema.newsImages).orderBy(desc(schema.newsImages.createdAt), schema.newsImages.id).limit(50);
        case "banners": return db.select({ name: schema.banners.name, position: schema.banners.position, status: schema.banners.status }).from(schema.banners).orderBy(schema.banners.sortOrder, schema.banners.id).limit(50);
        case "users": return (await db.execute(sql`SELECT u.id,u.display_name AS "displayName",u.email,u.is_active AS "isActive",COALESCE((SELECT json_agg(r.name ORDER BY r.name) FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id WHERE ur.user_id=u.id),'[]'::json) AS roles FROM public.users u ORDER BY u.display_name,u.id LIMIT 50`)).rows;
        // Values may contain operational secrets; the first stage lists metadata only.
        case "settings": return db.select({ key: schema.portalSettings.key, description: schema.portalSettings.description, updatedAt: schema.portalSettings.updatedAt }).from(schema.portalSettings).orderBy(schema.portalSettings.key).limit(50);
      }
    },
    createUser: (input, actorId) => createUser(pool, input, actorId),
    async audit(userId, action) {
      await assertTarget();
      await db.insert(schema.auditLogs).values({ actorId: userId, action, entityType: "users", entityId: userId });
    },
    async editCategory(id, name, actorId) {
      await assertTarget();
      const normalized = name.trim(), slug = slugify(normalized);
      if (!normalized || normalized.length > 120 || !slug || slug.length > 160) throw new NewsError(400, "Informe um nome válido com até 120 caracteres.");
      try {
        return await db.transaction(async tx => {
          const [old] = await tx.select().from(schema.categories).where(eq(schema.categories.id, id)).for("update");
          if (!old) throw new NewsError(404, "Categoria não encontrada. Atualize a lista.");
          const [updated] = await tx.update(schema.categories).set({ name: normalized, slug }).where(eq(schema.categories.id, id)).returning({ id: schema.categories.id, name: schema.categories.name, slug: schema.categories.slug });
          await tx.insert(schema.auditLogs).values({ actorId, action: "categories.edit", entityType: "categories", entityId: id, metadata: { previousName: old.name, previousSlug: old.slug, name: normalized, slug } });
          return updated;
        });
      } catch (error) {
        const e = error as { code?: string; cause?: { code?: string } };
        if ((e.cause?.code ?? e.code) === "23505") throw new NewsError(409, "Já existe uma categoria com o slug gerado. Escolha outro nome.");
        throw error;
      }
    },
    async deleteCategory(id, targetId, actorId, canTransfer) {
      await assertTarget();
      return db.transaction(async tx => {
        // Locks prevent incoming references or concurrent removals during the transfer.
        const categories = await tx.select().from(schema.categories).orderBy(schema.categories.id).for("update");
        const source = categories.find(c => c.id === id);
        if (!source) throw new NewsError(404, "Categoria não encontrada. Atualize a lista.");
        if (targetId === id) throw new NewsError(400, "Escolha uma categoria de destino diferente.");
        const target = targetId ? categories.find(c => c.id === targetId) : undefined;
        if (targetId && (!target || !target.isActive)) throw new NewsError(400, "Categoria de destino não encontrada ou inativa.");
        if (categories.some(c => c.parentId === id)) throw new NewsError(409, "Esta categoria tem subcategorias. Reorganize ou exclua as subcategorias antes.");
        const [row] = await tx.select({ total: count() }).from(schema.news).where(eq(schema.news.categoryId, id));
        if (row.total && !target) throw new NewsError(409, `Há ${row.total} matéria(s) nesta categoria. Escolha o destino para transferi-las.`);
        if (row.total && !canTransfer) throw new NewsError(403, "Você não tem permissão para transferir matérias entre categorias.");
        const moved = row.total ? await tx.update(schema.news).set({ categoryId: target!.id, updatedAt: new Date() }).where(eq(schema.news.categoryId, id)).returning({ id: schema.news.id }) : [];
        await tx.delete(schema.categories).where(eq(schema.categories.id, id));
        await tx.insert(schema.auditLogs).values({ actorId, action: "categories.delete", entityType: "categories", entityId: id, metadata: { name: source.name, slug: source.slug, targetId: target?.id ?? null, moved: moved.length } });
        return { moved: moved.length };
      });
    },
  };
}
