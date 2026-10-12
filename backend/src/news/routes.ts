import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { AdminUser } from "../admin/store.js";
import type { NewsStore, ListOptions } from "./store.js";
import { NewsError, uuid, validateNews } from "./validation.js";
import { saveImage, uploadDirectory } from "./media.js";
import {bannerDirectory,type BannerStore} from '../admin/banners.js';

type Authorize = (request: FastifyRequest, reply: FastifyReply, permission: string, write?: boolean) => Promise<AdminUser | undefined>;
export async function newsAdminRoutes(app: FastifyInstance, store: NewsStore, authorize: Authorize) {
  const read = async (request: FastifyRequest, reply: FastifyReply) => { await authorize(request, reply, "news.read"); };
  app.get<{ Querystring: { page?: string; search?: string; status?: string } }>("/api/admin/news", { preHandler: read }, async request => {
    const { page = "1", search = "", status } = request.query;
    if (!/^\d+$/.test(page) || Number(page) < 1 || Number(page) > 100000 || typeof search !== "string" || search.length > 200 || (status && !["draft", "scheduled", "published", "archived"].includes(status))) throw new NewsError(400, "Filtro inválido.");
    return store.list({ page: Number(page), search, status: status as ListOptions["status"] });
  });
  app.get("/api/admin/news/options", { preHandler: read }, () => store.options());
  app.get<{ Params: { id: string } }>("/api/admin/news/:id", { preHandler: read }, async request => {
    if (!uuid.test(request.params.id)) throw new NewsError(400, "Identificador inválido.");
    const news = await store.get(request.params.id);
    if (!news) throw new NewsError(404, "Matéria não encontrada.");
    return news;
  });
  app.post("/api/admin/news", { bodyLimit: 512 * 1024 }, async (request, reply) => {
    const actor = await authorize(request, reply, "news.create", true); if (!actor) return;
    const input = validateNews(request.body);
    return reply.code(201).send(await store.save(undefined, input, actor.id, actor.permissions));
  });
  app.put<{ Params: { id: string } }>("/api/admin/news/:id", { bodyLimit: 512 * 1024 }, async (request, reply) => {
    const actor = await authorize(request, reply, "news.edit", true); if (!actor) return;
    if (!uuid.test(request.params.id)) throw new NewsError(400, "Identificador inválido.");
    return store.save(request.params.id, validateNews(request.body), actor.id, actor.permissions);
  });
  app.post("/api/admin/news/upload", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const actor = await authorize(request, reply, "news.upload", true); if (!actor) return;
    if (!actor.permissions.includes("news.create") && !actor.permissions.includes("news.edit")) throw new NewsError(403, "Sem permissão para editar notícias.");
    const file = await request.file();
    if (!file) throw new NewsError(400, "Selecione uma imagem.");
    const bytes = await file.toBuffer();
    return reply.code(201).send(await saveImage(bytes));
  });
}

export function publicNewsRoutes(app: FastifyInstance, store: NewsStore, banners?:BannerStore) {
  app.register(async publicApp => {
  await publicApp.register(cors, { credentials: false, methods: ["GET"], origin: (origin, done) => {
    const configured = (process.env.PUBLIC_SITE_ORIGIN ?? "").split(",").map(value => value.trim()).filter(Boolean);
    const local = process.env.NODE_ENV !== "production" && !!origin && (origin === "null" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    done(null, !origin || configured.includes(origin) || local);
  } });
  if(banners) publicApp.get('/api/banners',async(_request,reply)=>{try{return await banners.publicList();}catch{return reply.code(503).send({message:'Publicidade indisponível.'});}});
  publicApp.get<{Params:{file:string}}>('/media/banners/:file',async(request,reply)=>{if(!/^[a-f0-9-]{36}\.(gif|webp)$/.test(request.params.file))return reply.code(404).send();const path=resolve(bannerDirectory,request.params.file);try{await access(path);}catch{return reply.code(404).send();}return reply.header('X-Content-Type-Options','nosniff').header('Cache-Control','public, max-age=31536000, immutable').type(request.params.file.endsWith('.gif')?'image/gif':'image/webp').send(createReadStream(path));});
  publicApp.get<{ Querystring: { category?: string; search?: string; page?: string; pageSize?: string } }>("/api/news/browse", async (request, reply) => {
    const { category, search = "", page = "1", pageSize = "6" } = request.query;
    if (!/^\d+$/.test(page) || Number(page) < 1 || Number(page) > 100000 || !/^\d+$/.test(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 12 || typeof search !== "string" || search.length > 200 || (category !== undefined && (typeof category !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(category) || category.length > 160))) return reply.code(400).send({ message: "Filtro inválido." });
    try {
      if (!store.publicBrowse) return reply.code(503).send({ message: "Conteúdo indisponível." });
      return await store.publicBrowse({ category, search, page: Number(page), pageSize: Number(pageSize) });
    } catch { return reply.code(503).send({ message: "Conteúdo indisponível." }); }
  });
  publicApp.get<{ Params: { slug: string } }>("/api/news/:slug", async (request, reply) => {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(request.params.slug) || request.params.slug.length > 260) return reply.code(404).send({ message: "Matéria não encontrada." });
    try { const item = await store.publicBySlug?.(request.params.slug); if (!item) return reply.code(404).send({ message: "Matéria não encontrada." }); return item; }
    catch { return reply.code(503).send({ message: "Conteúdo indisponível." }); }
  });
  publicApp.get<{ Querystring: { featured?: string } }>("/api/news", async (request, reply) => {
    if (request.query.featured !== undefined && !["true", "false"].includes(request.query.featured)) return reply.code(400).send({ message: "Filtro inválido." });
    try { return { items: await store.publicList(request.query.featured === "true") }; }
    catch { return reply.code(503).send({ message: "Conteúdo indisponível." }); }
  });
  publicApp.get<{ Params: { file: string } }>("/media/news/:file", async (request, reply) => {
    if (!/^[0-9a-f-]{36}\.webp$/.test(request.params.file)) return reply.code(404).send();
    const path = resolve(uploadDirectory, request.params.file);
    try { await access(path); } catch { return reply.code(404).send(); }
    return reply.header("X-Content-Type-Options", "nosniff").header("Cache-Control", "public, max-age=31536000, immutable").type("image/webp").send(createReadStream(path));
  });
  });
}
export function startNewsScheduler(app: FastifyInstance, store: NewsStore) {
  let pending: Promise<void> | undefined;
  const run = () => {
    if (pending) return pending;
    pending = store.publishDue().then(() => {}, () => { app.log.error({ event: "news_scheduler_failed" }, "Falha na publicação agendada; nova tentativa em 30 segundos."); }).finally(() => { pending = undefined; });
    return pending;
  };
  const timer = setInterval(run, 30_000); timer.unref();
  app.addHook("onReady", async () => { await run(); });
  app.addHook("onClose", async () => { clearInterval(timer); await pending; });
}
