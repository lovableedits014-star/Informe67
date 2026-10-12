import { loadBackendEnvironment } from "../src/config/environment.js";
import { readMigrationConfig, assertMigrationPassword } from "../src/db/migration-config.js";
import { adminPermissions } from "../src/admin/store.js";
import { Pool } from "pg";

loadBackendEnvironment(import.meta.url);
const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error("Informe o e-mail da conta existente.");
const target = readMigrationConfig(process.env); assertMigrationPassword(target);
const pool = new Pool({ ...target, max: 1 }), client = await pool.connect();
try {
  await client.query("BEGIN");
  if ((await client.query("SELECT current_database() AS database")).rows[0].database !== "informe67") throw new Error("Destino inesperado.");
  await client.query("SELECT pg_advisory_xact_lock(670002)");
  const user = (await client.query("SELECT id,is_active FROM public.users WHERE lower(email)=$1 FOR UPDATE", [email])).rows[0];
  if (!user?.is_active) throw new Error("Conta existente ativa não encontrada.");
  const reader = ["admin.access", "news.read", "categories.read", "images.read"];
  const profiles = [
    { name: "superadministrator", description: "Superadministrador: acesso completo e cadastro de usuários", permissions: adminPermissions },
    { name: "administrator", description: "Administrador do portal", permissions: adminPermissions.filter(p => !["users.create","settings.ai.manage"].includes(p)) },
    { name: "editor", description: "Editor: criação e edição de rascunhos", permissions: [...reader, "news.create", "news.edit", "news.upload", "news.rewrite"] },
    { name: "reader", description: "Leitor do painel editorial", permissions: reader },
  ];
  for (const profile of profiles) {
    const role = (await client.query("INSERT INTO public.roles(name,description,is_system) VALUES($1,$2,true) ON CONFLICT(name) DO UPDATE SET description=EXCLUDED.description RETURNING id", [profile.name, profile.description])).rows[0];
    for (const code of profile.permissions) {
      const permission = (await client.query("INSERT INTO public.permissions(code) VALUES($1) ON CONFLICT(code) DO UPDATE SET code=EXCLUDED.code RETURNING id", [code])).rows[0];
      await client.query("INSERT INTO public.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [role.id, permission.id]);
    }
    if (profile.name === "superadministrator") {
      const assigned = await client.query("INSERT INTO public.user_roles(user_id,role_id,assigned_by) VALUES($1,$2,$1) ON CONFLICT DO NOTHING RETURNING user_id", [user.id, role.id]);
      if (assigned.rowCount) await client.query("INSERT INTO public.audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1::uuid,'users.grant_superadministrator','users',$1::uuid::text,$2::jsonb)", [user.id, JSON.stringify({ role: profile.name, source: "setup-superadmin" })]);
    }
  }
  await client.query("COMMIT");
  console.info("Conta existente configurada como superadministrador. Perfis de cadastro prontos. Senha preservada.");
} catch (error) {
  await client.query("ROLLBACK");
  const code = (error as { code?: string }).code;
  console.error("Configuração cancelada; nenhuma alteração parcial foi mantida.", code && /^[A-Z0-9]{5}$/.test(code) ? `Código: ${code}.` : ""); process.exitCode = 1;
} finally { client.release(); await pool.end(); }
