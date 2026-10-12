import sanitizeHtml from "sanitize-html";

export class NewsError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export const newsPermissions = ["news.create", "news.edit", "news.publish", "news.archive", "news.feature", "news.upload"];
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const mediaUrl = /^\/media\/news\/[0-9a-f-]{36}\.webp$/;
export type ImageInput = { imageUrl: string; altText: string; caption: string | null; credits: string | null; isCover: boolean };
export type NewsInput = {
  title: string; slug: string; summary: string | null; content: string; categoryId: string | null;
  tags: string[]; images: ImageInput[]; status: "draft" | "scheduled" | "published" | "archived";
  scheduledAt: Date | null; seoTitle: string | null; seoDescription: string | null;
  canonicalUrl: string | null; seoNoIndex: boolean; isFeatured: boolean; featuredOrder: number | null;
  version: string | null;
};
export const slugify = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export function sanitizeContent(html: string) {
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "s", "h2", "h3", "blockquote", "ol", "ul", "li", "a", "img"],
    allowedAttributes: { a: ["href", "target", "rel"], img: ["src", "alt"], p: ["class"], li: ["class"], h2: ["class"], h3: ["class"] },
    allowedClasses: { "*": ["ql-align-center", "ql-align-right", "ql-align-justify", "ql-indent-1", "ql-indent-2", "ql-indent-3"] },
    allowedSchemes: ["http", "https", "mailto"], allowProtocolRelative: false,
    transformTags: { a: (_tag, attrs) => ({ tagName: "a", attribs: { href: attrs.href ?? "", target: "_blank", rel: "noopener noreferrer" } }) },
    exclusiveFilter: frame => frame.tag === "img" && !mediaUrl.test(frame.attribs.src ?? ""),
  });
}
function text(value: unknown, name: string, max: number, required = false): string | null {
  if (value == null || value === "") { if (required) throw new NewsError(400, `${name} é obrigatório.`); return null; }
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) throw new NewsError(400, `${name} inválido (máximo ${max} caracteres).`);
  return value.trim();
}
export function validateNews(value: unknown, now = new Date()): NewsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NewsError(400, "Matéria inválida.");
  const b = value as Record<string, unknown>;
  const keys = ["title", "slug", "summary", "content", "categoryId", "tags", "images", "status", "scheduledAt", "seoTitle", "seoDescription", "canonicalUrl", "seoNoIndex", "isFeatured", "featuredOrder", "version"];
  if (Object.keys(b).some(k => !keys.includes(k))) throw new NewsError(400, "Campo não permitido.");
  const title = text(b.title, "Título", 240, true)!;
  const slug = text(b.slug, "Slug", 260, true)!;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new NewsError(400, "Use letras minúsculas, números e hífens no slug.");
  if (typeof b.content !== "string" || b.content.length > 200_000) throw new NewsError(400, "Conteúdo inválido ou muito grande.");
  const content = sanitizeContent(b.content);
  if (!["draft", "scheduled", "published", "archived"].includes(String(b.status))) throw new NewsError(400, "Estado editorial inválido.");
  const status = b.status as NewsInput["status"];
  const scheduledAt = b.scheduledAt == null || b.scheduledAt === "" ? null : typeof b.scheduledAt === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(b.scheduledAt) ? new Date(b.scheduledAt) : new Date(NaN);
  if (scheduledAt && !Number.isFinite(scheduledAt.getTime())) throw new NewsError(400, "Data de agendamento inválida; informe o fuso horário.");
  if (status === "scheduled" && (!scheduledAt || scheduledAt <= now)) throw new NewsError(400, "Agende uma data futura.");
  if ((status === "published" || status === "scheduled") && !sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} }).trim()) throw new NewsError(400, "Escreva o conteúdo antes de publicar ou agendar.");
  const categoryId = text(b.categoryId, "Categoria", 36);
  if (categoryId && !uuid.test(categoryId)) throw new NewsError(400, "Categoria inválida.");
  if (b.tags !== undefined && (!Array.isArray(b.tags) || b.tags.length > 20)) throw new NewsError(400, "Use até 20 tags.");
  const tags = ((b.tags ?? []) as unknown[]).map(t => text(t, "Tag", 80, true)!).filter((name, index, all) => all.findIndex(t => t.toLowerCase() === name.toLowerCase()) === index);
  if (tags.some(t => !slugify(t) || slugify(t).length > 100)) throw new NewsError(400, "Tag inválida.");
  if (b.images !== undefined && (!Array.isArray(b.images) || b.images.length > 30)) throw new NewsError(400, "Use até 30 imagens.");
  const images = ((b.images ?? []) as unknown[]).map(value => {
    if (!value || typeof value !== "object") throw new NewsError(400, "Imagem inválida.");
    const image = value as Record<string, unknown>;
    const imageUrl = text(image.imageUrl, "URL da imagem", 200, true)!;
    if (!mediaUrl.test(imageUrl) || typeof image.isCover !== "boolean") throw new NewsError(400, "Use imagens enviadas pelo painel.");
    return { imageUrl, altText: text(image.altText, "Descrição da imagem", 300, true)!, caption: text(image.caption, "Legenda", 500), credits: text(image.credits, "Créditos", 300), isCover: image.isCover };
  });
  if (images.filter(i => i.isCover).length > 1 || new Set(images.map(i => i.imageUrl)).size !== images.length) throw new NewsError(400, "Imagens duplicadas ou mais de uma capa.");
  for (const match of content.matchAll(/<img[^>]+src="([^"]+)"/g)) if (!images.some(i => i.imageUrl === match[1])) throw new NewsError(400, "Imagem do conteúdo sem referência cadastrada.");
  for (const key of ["seoNoIndex", "isFeatured"]) if (b[key] !== undefined && typeof b[key] !== "boolean") throw new NewsError(400, "Opção inválida.");
  if (b.featuredOrder != null && (!Number.isInteger(b.featuredOrder) || Number(b.featuredOrder) < 0 || Number(b.featuredOrder) > 10000)) throw new NewsError(400, "Ordem de destaque inválida.");
  const canonicalUrl = text(b.canonicalUrl, "URL canônica", 2048);
  if (canonicalUrl) { try { const u = new URL(canonicalUrl); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw Error(); } catch { throw new NewsError(400, "URL canônica inválida."); } }
  const version = text(b.version, "Versão", 40);
  if (version && !Number.isFinite(Date.parse(version))) throw new NewsError(400, "Versão inválida.");
  return { title, slug, summary: text(b.summary, "Resumo", 500), content, categoryId, tags, images, status, scheduledAt: status === "scheduled" ? scheduledAt : null, seoTitle: text(b.seoTitle, "Título SEO", 240), seoDescription: text(b.seoDescription, "Descrição SEO", 320), canonicalUrl, seoNoIndex: b.seoNoIndex === true, isFeatured: b.isFeatured === true, featuredOrder: b.isFeatured ? Number(b.featuredOrder ?? 0) : null, version };
}
export function assertNewsPermission(input: NewsInput, old: { status: string; isFeatured: boolean; featuredOrder: number | null } | undefined, permissions: string[]) {
  const require = (code: string) => { if (!permissions.includes(code)) throw new NewsError(403, "Você não tem permissão para esta operação."); };
  require(old ? "news.edit" : "news.create");
  if ([input.status, old?.status].some(s => s === "published" || s === "scheduled")) require("news.publish");
  if (input.status === "archived" || old?.status === "archived") require("news.archive");
  if (input.isFeatured !== (old?.isFeatured ?? false) || input.featuredOrder !== (old?.featuredOrder ?? null)) require("news.feature");
}
