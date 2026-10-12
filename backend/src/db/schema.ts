import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  boolean,
  integer,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const newsStatusEnum = pgEnum("news_status", [
  "draft",
  "scheduled",
  "published",
  "archived",
]);

export const bannerStatusEnum = pgEnum("banner_status", [
  "draft",
  "active",
  "paused",
  "archived",
]);

export const bannerPositionEnum = pgEnum("banner_position", [
  "header",
  "sidebar",
  "in_article",
  "footer",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    displayName: varchar("display_name", { length: 160 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(sql`lower(${table.email})`),
    index("users_is_active_idx").on(table.isActive),
  ],
);

export const roles = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 80 }).notNull().unique(),
  description: text("description"),
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const permissions = pgTable("permissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: varchar("code", { length: 120 }).notNull().unique(),
  description: text("description"),
});

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    assignedBy: uuid("assigned_by").references(() => users.id, {
      onDelete: "set null",
    }),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roleId] }),
    index("user_roles_role_id_idx").on(table.roleId),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    index("role_permissions_permission_id_idx").on(table.permissionId),
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 160 }).notNull(),
    description: text("description"),
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id, {
      onDelete: "set null",
    }),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("categories_slug_unique").on(table.slug),
    index("categories_parent_id_idx").on(table.parentId),
    index("categories_active_sort_idx").on(table.isActive, table.sortOrder),
    check(
      "categories_slug_format_check",
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
  ],
);

export const news = pgTable(
  "news",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: varchar("title", { length: 240 }).notNull(),
    slug: varchar("slug", { length: 260 }).notNull(),
    summary: varchar("summary", { length: 500 }),
    content: text("content").notNull(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    status: newsStatusEnum("status").notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    seoTitle: varchar("seo_title", { length: 240 }),
    seoDescription: varchar("seo_description", { length: 320 }),
    canonicalUrl: text("canonical_url"),
    seoNoIndex: boolean("seo_no_index").notNull().default(false),
    isFeatured: boolean("is_featured").notNull().default(false),
    featuredOrder: integer("featured_order"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("news_slug_unique").on(table.slug),
    index("news_status_published_at_idx").on(table.status, table.publishedAt),
    index("news_category_status_published_idx").on(
      table.categoryId,
      table.status,
      table.publishedAt,
    ),
    index("news_author_id_idx").on(table.authorId),
    check(
      "news_slug_format_check",
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      "news_scheduled_at_check",
      sql`${table.status} <> 'scheduled' OR ${table.scheduledAt} IS NOT NULL`,
    ),
    check(
      "news_published_at_check",
      sql`${table.status} <> 'published' OR ${table.publishedAt} IS NOT NULL`,
    ),
    check(
      "news_featured_order_check",
      sql`${table.featuredOrder} IS NULL OR ${table.featuredOrder} >= 0`,
    ),
  ],
);

export const newsImages = pgTable(
  "news_images",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    newsId: uuid("news_id")
      .notNull()
      .references(() => news.id, { onDelete: "restrict" }),
    imageUrl: text("image_url").notNull(),
    caption: varchar("caption", { length: 500 }),
    altText: varchar("alt_text", { length: 300 }).notNull(),
    credits: varchar("credits", { length: 300 }),
    sortOrder: integer("sort_order").notNull().default(0),
    isCover: boolean("is_cover").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("news_images_news_sort_idx").on(table.newsId, table.sortOrder),
    uniqueIndex("news_images_single_cover_unique")
      .on(table.newsId)
      .where(sql`${table.isCover}`),
    check("news_images_sort_order_check", sql`${table.sortOrder} >= 0`),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 80 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("tags_name_unique").on(sql`lower(${table.name})`),
    uniqueIndex("tags_slug_unique").on(table.slug),
    check(
      "tags_slug_format_check",
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
  ],
);

export const newsTags = pgTable(
  "news_tags",
  {
    newsId: uuid("news_id")
      .notNull()
      .references(() => news.id, { onDelete: "restrict" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.newsId, table.tagId] }),
    index("news_tags_tag_id_idx").on(table.tagId),
  ],
);

export const banners = pgTable(
  "banners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    position: bannerPositionEnum("position").notNull(),
    imageUrl: text("image_url").notNull(),
    altText: varchar("alt_text", { length: 300 }).notNull(),
    targetUrl: text("target_url").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    status: bannerStatusEnum("status").notNull().default("draft"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("banners_position_status_sort_idx").on(
      table.position,
      table.status,
      table.sortOrder,
    ),
    index("banners_schedule_idx").on(table.status, table.startsAt, table.endsAt),
    check("banners_sort_order_check", sql`${table.sortOrder} >= 0`),
    check(
      "banners_period_check",
      sql`${table.startsAt} IS NULL OR ${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`,
    ),
  ],
);

export const portalSettings = pgTable(
  "portal_settings",
  {
    key: varchar("key", { length: 120 }).primaryKey(),
    value: jsonb("value").notNull(),
    description: text("description"),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("portal_settings_updated_by_idx").on(table.updatedBy)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    action: varchar("action", { length: 120 }).notNull(),
    entityType: varchar("entity_type", { length: 120 }).notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_logs_actor_created_idx").on(table.actorId, table.createdAt),
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    index("audit_logs_created_at_idx").on(table.createdAt),
  ],
);

export const redirects = pgTable(
  "redirects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourcePath: varchar("source_path", { length: 2048 }).notNull(),
    targetPath: varchar("target_path", { length: 2048 }).notNull(),
    statusCode: smallint("status_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("redirects_source_path_unique").on(table.sourcePath),
    check(
      "redirects_source_path_safe_check",
      sql`left(${table.sourcePath}, 1) = '/' AND left(${table.sourcePath}, 2) <> '//' AND position(chr(92) in ${table.sourcePath}) = 0 AND ${table.sourcePath} !~ '[[:cntrl:][:space:]]' AND lower(${table.sourcePath}) !~ '%2f|%5c'`,
    ),
    check(
      "redirects_target_path_safe_check",
      sql`left(${table.targetPath}, 1) = '/' AND left(${table.targetPath}, 2) <> '//' AND position(chr(92) in ${table.targetPath}) = 0 AND ${table.targetPath} !~ '[[:cntrl:][:space:]]' AND lower(${table.targetPath}) !~ '%2f|%5c'`,
    ),
    check(
      "redirects_no_direct_loop_check",
      sql`${table.sourcePath} <> ${table.targetPath}`,
    ),
    check(
      "redirects_status_code_check",
      sql`${table.statusCode} IN (301, 308)`,
    ),
    index("redirects_created_at_idx").on(table.createdAt),
  ],
);
