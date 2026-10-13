import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { modules, type AdminStore, type AdminUser } from "./store.js";
import { verifyPassword } from "./password.js";
import { newsAdminRoutes } from "../news/routes.js";
import { NewsError, uuid } from "../news/validation.js";
import type { NewsStore } from "../news/store.js";
import multipart from '@fastify/multipart';
import {uploadBanner,validateBanner,type BannerStore} from './banners.js';
import { userProfiles, validateUser } from './users.js';
import {rewriteRoutes} from '../rewrite/routes.js';
import type {RewriteService} from '../rewrite/service.js';

type Session = { userId: string; passwordFingerprint: string; csrf: string; expires: number };
type AdminOptions = { store: AdminStore; origin: string; secure: boolean; sessionTtlMs?: number; newsStore?: NewsStore; bannerStore?:BannerStore;rewriteService?:RewriteService };
const fingerprint = (hash: string) => createHash("sha256").update(hash).digest("hex");
const publicUser = (user: AdminUser) => ({ id: user.id, email: user.email, displayName: user.displayName, permissions: user.permissions, roles: user.roles ?? [] });

export async function adminRoutes(app: FastifyInstance, options: AdminOptions) {
  const sessions = new Map<string, Session>();
  const ttl = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  const cookieName = options.secure ? "__Secure-informe67_admin" : "informe67_admin";
  const cookieOptions = { httpOnly: true, secure: options.secure, sameSite: "strict" as const, path: "/api/admin" };
  const cleanup = setInterval(() => {
    for (const [token, session] of sessions) if (session.expires <= Date.now()) sessions.delete(token);
  }, 60_000);
  cleanup.unref();
  app.addHook("onClose", async () => { clearInterval(cleanup); sessions.clear(); });
  await app.register(cookie);
  if(options.newsStore||options.bannerStore)await app.register(multipart,{limits:{fileSize:5*1024*1024,files:1,fields:0,parts:1}});
  await app.register(rateLimit, { global: false });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof NewsError) return reply.code(error.statusCode).send({ message: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ message: "Muitas tentativas. Aguarde alguns minutos e tente novamente." });
    if (status && status < 500) return reply.code(status).send({ message: "Requisição inválida." });
    // Never log request bodies, cookies, passwords, or database error messages.
    request.log.error({ event: "admin_request_failed" }, "Falha no painel administrativo");
    return reply.code(503).send({ message: "Serviço indisponível. Tente novamente." });
  });
  await app.register(staticFiles, { root: fileURLToPath(new URL("../../public/admin/", import.meta.url)), prefix: "/admin/", index: "index.html" });
  app.get("/admin", async (_request, reply) => reply.redirect("/admin/"));

  function sameOrigin(request: FastifyRequest, reply: FastifyReply) {
    const requestOrigin = request.headers.origin;
    let matchesPublicHost = false;
    if (requestOrigin && request.headers.host) {
      try {
        const parsedOrigin = new URL(requestOrigin);
        matchesPublicHost = parsedOrigin.host === request.headers.host
          && (options.secure ? parsedOrigin.protocol === "https:" : ["http:", "https:"].includes(parsedOrigin.protocol));
      } catch {
        matchesPublicHost = false;
      }
    }
    if ((requestOrigin !== options.origin && !matchesPublicHost) || request.headers["sec-fetch-site"] === "cross-site") {
      reply.code(403).send({ message: "Origem não autorizada." });
      return false;
    }
    return true;
  }
  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies[cookieName];
    const session = token ? sessions.get(token) : undefined;
    if (!session || session.expires <= Date.now()) {
      if (token) sessions.delete(token);
      reply.clearCookie(cookieName, cookieOptions).code(401).send({ message: "Entre para continuar." });
      return;
    }
    const user = await options.store.findById(session.userId);
    if (!user?.isActive || !user.permissions.includes("admin.access") || fingerprint(user.passwordHash) !== session.passwordFingerprint) {
      sessions.delete(token!);
      reply.clearCookie(cookieName, cookieOptions).code(401).send({ message: "Sessão encerrada. Entre novamente." });
      return;
    }
    return { user, session, token: token! };
  }
  app.post<{ Body: { email: string; password: string } }>("/api/admin/login", {
    bodyLimit: 4096,
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    schema: { body: { type: "object", required: ["email", "password"], additionalProperties: false, properties: { email: { type: "string", minLength: 3, maxLength: 320, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" }, password: { type: "string", minLength: 1, maxLength: 1024 } } } },
  }, async (request, reply) => {
    if (!sameOrigin(request, reply)) return;
    const user = await options.store.findByEmail(request.body.email.trim().toLowerCase());
    const valid = await verifyPassword(request.body.password, user?.passwordHash ?? "");
    if (!valid || !user?.isActive || !user.permissions.includes("admin.access")) {
      return reply.code(401).send({ message: "E-mail ou senha inválidos." });
    }
    await options.store.audit(user.id, "admin.login");
    const previous = request.cookies[cookieName];
    if (previous) sessions.delete(previous);
    // Bounded memory store for the initial single-instance deployment.
    if (sessions.size >= 10_000) return reply.code(503).send({ message: "Serviço indisponível. Tente novamente." });
    const token = randomBytes(32).toString("hex");
    const session = { userId: user.id, passwordFingerprint: fingerprint(user.passwordHash), csrf: randomBytes(32).toString("hex"), expires: Date.now() + ttl };
    sessions.set(token, session);
    reply.setCookie(cookieName, token, { ...cookieOptions, maxAge: Math.floor(ttl / 1000) });
    return { user: publicUser(user), csrfToken: session.csrf };
  });
  app.get("/api/admin/me", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth) return { user: publicUser(auth.user), csrfToken: auth.session.csrf };
  });
  app.post("/api/admin/logout", async (request, reply) => {
    if (!sameOrigin(request, reply)) return;
    const auth = await authenticate(request, reply);
    if (!auth) return;
    if (request.headers["x-csrf-token"] !== auth.session.csrf) return reply.code(403).send({ message: "Requisição não autorizada." });
    sessions.delete(auth.token);
    reply.clearCookie(cookieName, cookieOptions);
    await options.store.audit(auth.user.id, "admin.logout");
    return reply.code(204).send();
  });
  app.get("/api/admin/dashboard", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (auth) return options.store.dashboard(auth.user.permissions);
  });
  app.put<{ Params: { id: string }; Body: { name: string } }>("/api/admin/categories/:id", { bodyLimit: 2048 }, async (request, reply) => {
    if (!sameOrigin(request, reply)) return;
    const auth = await authenticate(request, reply); if (!auth) return;
    if (request.headers["x-csrf-token"] !== auth.session.csrf) return reply.code(403).send({ message: "Requisição não autorizada." });
    if (!auth.user.permissions.includes("categories.read") || !auth.user.permissions.includes("categories.edit")) return reply.code(403).send({ message: "Você não tem permissão para editar categorias." });
    const body = request.body;
    if (!uuid.test(request.params.id) || !body || typeof body !== "object" || Array.isArray(body) || typeof body.name !== "string" || Object.keys(body).some(k => k !== "name")) throw new NewsError(400, "Categoria ou nome inválido.");
    if (!options.store.editCategory) throw new NewsError(503, "Serviço indisponível.");
    return options.store.editCategory(request.params.id, body.name, auth.user.id);
  });
  app.delete<{ Params: { id: string }; Body: { targetId?: string | null } }>("/api/admin/categories/:id", { bodyLimit: 1024 }, async (request, reply) => {
    if (!sameOrigin(request, reply)) return;
    const auth = await authenticate(request, reply); if (!auth) return;
    if (request.headers["x-csrf-token"] !== auth.session.csrf) return reply.code(403).send({ message: "Requisição não autorizada." });
    if (!auth.user.permissions.includes("categories.read") || !auth.user.permissions.includes("categories.delete")) return reply.code(403).send({ message: "Você não tem permissão para excluir categorias." });
    const body = request.body ?? {};
    if (!uuid.test(request.params.id) || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => k !== "targetId") || (body.targetId != null && (typeof body.targetId !== "string" || !uuid.test(body.targetId)))) throw new NewsError(400, "Categoria ou destino inválido.");
    if (!options.store.deleteCategory) throw new NewsError(503, "Serviço indisponível.");
    return options.store.deleteCategory(request.params.id, body.targetId ?? null, auth.user.id, auth.user.permissions.includes("categories.transfer"));
  });
  if (options.newsStore) await newsAdminRoutes(app, options.newsStore, async (request, reply, permission, write) => {
    if (write && !sameOrigin(request, reply)) return;
    const auth = await authenticate(request, reply);
    if (!auth) return;
    if (write && request.headers["x-csrf-token"] !== auth.session.csrf) {
      reply.code(403).send({ message: "Requisição não autorizada." }); return;
    }
    if (!auth.user.permissions.includes(permission) || !auth.user.permissions.includes("news.read")) {
      reply.code(403).send({ message: "Você não tem permissão para esta operação." }); return;
    }
    return auth.user;
  });
  if(options.bannerStore){
    const authorize=async(request:FastifyRequest,reply:FastifyReply,write=false)=>{if(write&&!sameOrigin(request,reply))return;const auth=await authenticate(request,reply);if(!auth)return;if(!auth.user.permissions.includes('banners.read')||(write&&!auth.user.permissions.includes('banners.manage'))||(write&&request.headers['x-csrf-token']!==auth.session.csrf)){reply.code(403).send({message:'Sem permissão para configurar banners.'});return;}return auth.user;};
    app.get('/api/admin/banners',async(request,reply)=>{if(await authorize(request,reply))return{items:await options.bannerStore!.list()};});
    app.post('/api/admin/banners/upload',async(request,reply)=>{if(!await authorize(request,reply,true))return;const file=await request.file();if(!file)throw new NewsError(400,'Selecione uma imagem.');return reply.code(201).send(await uploadBanner(await file.toBuffer()));});
    app.post('/api/admin/banners',async(request,reply)=>{const user=await authorize(request,reply,true);if(user)return reply.code(201).send(await options.bannerStore!.save(undefined,validateBanner(request.body),user.id));});
    app.put<{Params:{id:string}}>('/api/admin/banners/:id',async(request,reply)=>{const user=await authorize(request,reply,true);if(!user)return;if(!uuid.test(request.params.id))throw new NewsError(400,'Banner inválido.');return options.bannerStore!.save(request.params.id,validateBanner(request.body),user.id);});
  }
  app.get('/api/admin/users/profiles', async (request, reply) => {
    const auth = await authenticate(request, reply); if (!auth) return;
    if (!auth.user.permissions.includes('users.read') || !auth.user.permissions.includes('users.create') || !auth.user.roles?.includes('superadministrator')) return reply.code(403).send({ message: 'Somente o superadministrador pode cadastrar usuários.' });
    return { items: userProfiles };
  });
  app.post('/api/admin/users', { bodyLimit: 4096, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!sameOrigin(request, reply)) return;
    const auth = await authenticate(request, reply); if (!auth) return;
    if (request.headers['x-csrf-token'] !== auth.session.csrf) return reply.code(403).send({ message: 'Requisição não autorizada.' });
    if (!auth.user.permissions.includes('users.read') || !auth.user.permissions.includes('users.create') || !auth.user.roles?.includes('superadministrator')) return reply.code(403).send({ message: 'Somente o superadministrador pode cadastrar usuários.' });
    if (!options.store.createUser) throw new NewsError(503, 'Serviço indisponível.');
    const user = await options.store.createUser(validateUser(request.body), auth.user.id);
    return reply.code(201).send(user);
  });
  if(options.rewriteService)await rewriteRoutes(app,options.rewriteService,async(request,reply,permission,write)=>{
    if(write&&!sameOrigin(request,reply))return;const auth=await authenticate(request,reply);if(!auth)return;
    if(write&&request.headers['x-csrf-token']!==auth.session.csrf){reply.code(403).send({message:'Requisição não autorizada.'});return;}
    const required=permission==='settings.ai.manage'?['settings.read','settings.ai.manage']:permission==='settings.read'?['settings.read']:['news.read','news.rewrite',...(write?['news.create','news.upload']:[])];
    if(!required.every(p=>auth.user.permissions.includes(p))||(permission==='settings.ai.manage'&&!auth.user.roles?.includes('superadministrator'))){reply.code(403).send({message:'Sem permissão para esta operação.'});return;}return auth.user;
  });
  for (const module of modules) {
    if(module.key==='banners'&&options.bannerStore)continue;
    if (module.key === "news" && options.newsStore) continue;
    app.get(`/api/admin/${module.key}`, async (request, reply) => {
      const auth = await authenticate(request, reply);
      if (!auth) return;
      if (!auth.user.permissions.includes(module.permission)) return reply.code(403).send({ message: "Você não tem permissão para acessar esta área." });
      return { items: await options.store.list(module.key), limit: 50 };
    });
  }
}
