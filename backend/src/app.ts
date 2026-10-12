import Fastify from "fastify";
import { Pool } from "pg";
import { databaseDiagnostic } from "./db/diagnostics.js";
import { adminRoutes } from "./admin/routes.js";
import { createAdminStore, type AdminStore } from "./admin/store.js";
import { createNewsStore, type NewsStore } from "./news/store.js";
import { publicNewsRoutes, startNewsScheduler } from "./news/routes.js";
import { createBannerStore, type BannerStore } from './admin/banners.js';
import {createRewriteService,type RewriteService} from './rewrite/service.js';
import { publicSiteRoutes } from './public/site.js';

type HealthDatabase = {
  query: (text: string) => Promise<unknown>;
  end: () => Promise<void>;
};

function createDatabasePool() {
  const port = Number(process.env.PGPORT ?? 5432);
  const connectionTimeoutMillis = Number(process.env.PGCONNECT_TIMEOUT_MS ?? 5000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PGPORT deve ser um número inteiro entre 1 e 65535.");
  }

  if (!Number.isInteger(connectionTimeoutMillis) || connectionTimeoutMillis < 1) {
    throw new Error("PGCONNECT_TIMEOUT_MS deve ser um número inteiro positivo.");
  }

  return new Pool({
    host: process.env.PGHOST ?? "n8n_postgres",
    port,
    database: process.env.PGDATABASE ?? "",
    user: process.env.PGUSER ?? "",
    password: process.env.PGPASSWORD ?? "",
    connectionTimeoutMillis,
    idleTimeoutMillis: 10000,
    max: 5,
  });
}

export function buildApp(database: HealthDatabase = createDatabasePool(), options: { adminStore?: AdminStore; adminOrigin?: string; secureCookies?: boolean; sessionTtlMs?: number; newsStore?: NewsStore; newsScheduler?: boolean; bannerStore?: BannerStore; rewriteService?:RewriteService } = {}) {
  const app = Fastify({
    logger: true,
  });

  const production = process.env.NODE_ENV === "production";
  const origin = options.adminOrigin ?? process.env.ADMIN_ORIGIN ?? (production ? "" : `http://localhost:${process.env.PORT ?? 3000}`);
  if (!origin || new URL(origin).origin !== origin || (production && !origin.startsWith("https://"))) {
    throw new Error("Configure ADMIN_ORIGIN com a origem exata do painel (HTTPS em produção).");
  }
  const newsStore = options.newsStore ?? (options.adminStore ? undefined : createNewsStore(database as Pool));
  const bannerStore=options.bannerStore??(options.adminStore?undefined:createBannerStore(database as Pool));
  const rewriteService=options.rewriteService??(options.adminStore?undefined:createRewriteService(database as Pool));
  app.register(adminRoutes, {
    store: options.adminStore ?? createAdminStore(database as Pool),
    origin,
    secure: production || (options.secureCookies ?? false),
    sessionTtlMs: options.sessionTtlMs,
    newsStore,
    bannerStore,
    rewriteService,
  });
  app.register(publicSiteRoutes);
  if (newsStore) {
    publicNewsRoutes(app, newsStore, bannerStore);
    if (options.newsScheduler) startNewsScheduler(app, newsStore);
  }
  if(rewriteService&&options.newsScheduler){
    const timer=setInterval(()=>{void rewriteService.tick().catch(()=>app.log.error({event:'rewrite_worker_failed'},'Falha no processamento de reescrita'));},2000);timer.unref();
    app.addHook('onClose',async()=>clearInterval(timer));
  }

  app.addHook("onClose", async () => {
    await database.end();
  });

  app.get("/api/health", async () => ({
    status: "ok",
    service: "informe67-api",
  }));

  app.get("/api/health/db", async (_request, reply) => {
    try {
      await database.query("SELECT 1");
      return { status: "ok", database: "available" };
    } catch (error) {
      const diagnostic = databaseDiagnostic(error);
      app.log.warn(
        {
          databaseErrorCode: diagnostic.code,
          databaseErrorMessage: diagnostic.message,
        },
        "Database health check failed",
      );
      return reply.code(503).send({
        status: "error",
        database: "unavailable",
      });
    }
  });

  return app;
}
