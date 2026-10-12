import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { hashPassword } from "./password.js";
import { NewsError } from "../news/validation.js";

export const userProfiles = [
  { name: "administrator", label: "Administrador", description: "Gerencia conteúdo, categorias, banners e configurações." },
  { name: "editor", label: "Editor", description: "Cria e edita rascunhos. A publicação fica com o administrador." },
  { name: "reader", label: "Leitor", description: "Consulta notícias, categorias e imagens no painel." },
] as const;
export type NewUser = { displayName: string; email: string; password: string; role: string };
export function validateUser(value: unknown): NewUser {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NewsError(400, "Dados do usuário inválidos.");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(k => !["displayName", "email", "password", "role"].includes(k)) || ["displayName", "email", "password", "role"].some(k => typeof body[k] !== "string")) throw new NewsError(400, "Dados do usuário inválidos.");
  const displayName = (body.displayName as string).trim(), email = (body.email as string).trim().toLowerCase(), password = body.password as string, role = body.role as string;
  if (!displayName || displayName.length > 160 || /[\x00-\x1f\x7f]/.test(displayName) || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new NewsError(400, "Informe nome e e-mail válidos.");
  if (password.length < 12 || Buffer.byteLength(password) > 1024 || !password.trim()) throw new NewsError(400, "A senha deve ter pelo menos 12 caracteres e até 1024 bytes.");
  if (!userProfiles.some(p => p.name === role)) throw new NewsError(400, "Perfil inválido.");
  return { displayName, email, password, role };
}
export async function createUser(pool: Pool, input: NewUser, actorId: string) {
  input = validateUser(input);
  const passwordHash = await hashPassword(input.password);
  try {
    return await drizzle(pool).transaction(async tx => {
      const identity = await tx.execute(sql`SELECT current_database() AS database`);
      if (identity.rows[0]?.database !== "informe67") throw new Error("Destino administrativo inesperado.");
      const actor = await tx.execute(sql`SELECT u.id FROM public.users u JOIN public.user_roles ur ON ur.user_id=u.id JOIN public.roles r ON r.id=ur.role_id WHERE u.id=${actorId} AND u.is_active AND r.name='superadministrator' FOR SHARE OF u,ur,r`);
      if (!actor.rows.length) throw new NewsError(403, "Somente o superadministrador pode cadastrar usuários.");
      const [role] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.name, input.role));
      if (!role) throw new NewsError(503, "Perfil indisponível. Contate o administrador.");
      const [user] = await tx.insert(schema.users).values({ displayName: input.displayName, email: input.email, passwordHash }).returning({ id: schema.users.id, displayName: schema.users.displayName, email: schema.users.email, isActive: schema.users.isActive });
      await tx.insert(schema.userRoles).values({ userId: user.id, roleId: role.id, assignedBy: actorId });
      await tx.insert(schema.auditLogs).values({ actorId, action: "users.create", entityType: "users", entityId: user.id, metadata: { role: input.role } });
      return { ...user, roles: [input.role] };
    });
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    if ((e.cause?.code ?? e.code) === "23505") throw new NewsError(409, "Já existe um usuário com este e-mail.");
    throw error;
  }
}
