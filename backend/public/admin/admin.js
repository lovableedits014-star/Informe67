"use strict";
const $ = id => document.getElementById(id);
const modules = [
  { key: "dashboard", label: "Visão geral", icon: "◫", description: "Acompanhe o conteúdo e a organização do portal." },
  { key: "news", label: "Notícias", icon: "▤", description: "Conteúdo editorial e seus estados de publicação." },
  { key: "categories", label: "Categorias", icon: "▦", description: "Organização das editorias do portal." },
  { key: "images", label: "Imagens", icon: "▧", description: "Referências de imagens associadas às notícias." },
  { key: "banners", label: "Banners", icon: "▱", description: "Publicidade e posições de exibição." },
  { key: "users", label: "Usuários", icon: "♙", description: "Contas da equipe editorial." },
  { key: "settings", label: "Configurações", icon: "⚙", description: "Configurações cadastradas para o portal." },
];
const columns = {
  news: { title: "Título", slug: "Slug", status: "Estado", updatedAt: "Atualização" },
  categories: { name: "Nome", slug: "Slug", isActive: "Ativa" },
  images: { altText: "Descrição", credits: "Créditos", isCover: "Capa" },
  banners: { name: "Nome", position: "Posição", status: "Estado" },
  users: { displayName: "Nome", email: "E-mail", isActive: "Ativo" },
  settings: { key: "Chave", description: "Descrição", updatedAt: "Atualização" },
};
const statuses = { draft: "Rascunho", scheduled: "Agendada", published: "Publicada", archived: "Arquivada", active: "Ativo", paused: "Pausado", header: "Topo", sidebar: "Lateral", in_article: "Na notícia", footer: "Rodapé" };
let user, csrfToken, current = "dashboard", loadSequence = 0, newsModule;
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const allowed = module => module.key === "dashboard" || user.permissions.includes(`${module.key}.read`);
async function api(path, options = {}) {
  const response = await fetch(`/api/admin/${path}`, { credentials: "same-origin", ...options, headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}), ...options.headers } });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "login") showLogin("Sua sessão terminou. Entre novamente.");
    throw new Error(data?.message || "Não foi possível concluir. Tente novamente.");
  }
  return data;
}
function showLogin(message = "") {
  newsModule?.dispose(); newsModule = undefined;
  loadSequence++;
  user = null; csrfToken = null;
  $("panel").hidden = true; $("login").hidden = false; $("boot").hidden = true;
  $("view").replaceChildren(); $("navigation").replaceChildren(); $("user-name").textContent = "";
  $("login-error").textContent = message; $("password").value = "";
}
function showPanel(data) {
  user = data.user; csrfToken = data.csrfToken;
  $("login").hidden = true; $("panel").hidden = false; $("boot").hidden = true;
  $("password").value = "";
  $("user-name").textContent = user.displayName;
  $("avatar").textContent = user.displayName.split(/\s+/).slice(0, 2).map(n => n[0]).join("").toUpperCase();
  $("navigation").replaceChildren();
  for (const module of modules) {
    const button = element("button", "nav-button"); button.type = "button"; button.dataset.module = module.key;
    button.append(element("span", "nav-icon", module.icon), element("span", "", module.label));
    button.disabled = !allowed(module);
    if (button.disabled) button.title = "Acesso não autorizado para sua conta";
    button.addEventListener("click", () => navigate(module.key));
    $("navigation").append(button);
  }
  navigate("dashboard");
}
function emptyState(title, description) {
  const empty = element("div", "empty");
  empty.append(element("span", "empty-symbol", "▤"), element("h3", "", title), element("p", "", description));
  return empty;
}
function card(title, subtitle) {
  const card = element("section", "card"); const header = element("div", "card-header");
  header.append(element("h2", "", title)); if (subtitle) header.append(element("small", "", subtitle));
  card.append(header); return card;
}
function table(items, fields) {
  const wrap = element("div", "table-wrap"), table = element("table"), head = element("thead"), row = element("tr"), body = element("tbody");
  for (const label of Object.values(fields)) { const th = element("th", "", label); th.scope = "col"; row.append(th); }
  head.append(row);
  for (const item of items) {
    const row = element("tr");
    for (const key of Object.keys(fields)) {
      const value = item[key]; const cell = element("td");
      const text = key.endsWith("At") && value ? new Date(value).toLocaleString("pt-BR") : typeof value === "boolean" ? (value ? "Sim" : "Não") : value == null ? "—" : statuses[value] ?? String(value);
      if (key === "status") cell.append(element("span", `badge ${value === "draft" ? "draft" : ""}`, text)); else cell.textContent = text;
      row.append(cell);
    }
    body.append(row);
  }
  table.append(head, body); wrap.append(table); return wrap;
}
function renderDashboard(data) {
  const stats = element("div", "stats");
  for (const module of modules.slice(1).filter(allowed)) {
    const stat = element("div", "stat"); stat.append(element("span", "stat-label", module.label), element("strong", "", String(data.counts[module.key] ?? 0)), element("span", "stat-icon", module.icon)); stats.append(stat);
  }
  const grid = element("div", "dashboard-grid");
  if (user.permissions.includes("news.read")) {
    const recent = card("Últimas notícias", "Atualizações recentes");
    recent.append(data.recentNews.length ? table(data.recentNews, { title: "Título", status: "Estado", updatedAt: "Atualização" }) : emptyState("Seu próximo capítulo começa aqui", "As notícias cadastradas aparecerão aqui. O portal ainda não tem conteúdo editorial."));
    grid.append(recent);
  }
  const quick = card("Seu espaço editorial"), body = element("div", "card-body"), links = element("div", "quick-links");
  for (const module of modules.slice(1).filter(allowed)) {
    const button = element("button", "quick-link"); button.type = "button"; button.append(element("span", "", module.label), element("span", "", "→")); button.addEventListener("click", () => navigate(module.key)); links.append(button);
  }
  const note = element("div", "stage-note"); note.append(element("strong", "", "Sua rotina editorial"), document.createTextNode("Crie matérias, salve rascunhos e organize publicações no módulo Notícias."));
  body.append(links, note); quick.append(body); grid.append(quick);
  $("view").replaceChildren(stats, grid);
}
async function navigate(key) {
  const module = modules.find(m => m.key === key);
  if (!user || !module || !allowed(module)) return;
  if (newsModule && !newsModule.canLeave()) return;
  newsModule?.dispose(); newsModule = undefined;
  current = key; const sequence = ++loadSequence;
  $("panel").classList.remove("menu-open"); $("menu-toggle").setAttribute("aria-expanded", "false");
  $("page-title").textContent = module.label; $("breadcrumb").textContent = module.label; $("page-description").textContent = module.description;
  for (const button of $("navigation").children) { const selected = button.dataset.module === key; button.classList.toggle("active", selected); if (selected) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); }
  $("panel-error").textContent = ""; $("view").replaceChildren(element("p", "muted", "Carregando…"));
  try {
    if (key === "news") { newsModule = window.NewsModule.mount({ root: $("view"), user, api }); return; }
    if(key==='settings'){await window.AISettings.render({root:$("view"),user,api});return;}
    const data = await api(key);
    if (sequence !== loadSequence || !user) return;
    if (key === "dashboard") renderDashboard(data);
    else if (key === "categories") window.CategoryModule.render({root:$("view"),items:data.items,user,api,reload:()=>navigate('categories')});
    else if(key==='banners')window.BannerModule.render({root:$("view"),items:data.items,user,api,reload:()=>navigate('banners')});
    else if(key==='users')window.UserModule.render({root:$("view"),items:data.items,user,api,reload:()=>navigate('users')});
    else { const list = card(module.label, "Consulta · até 50 registros"); list.append(data.items.length ? table(data.items, columns[key]) : emptyState("Nenhum registro por enquanto", "Os dados cadastrados no portal aparecerão nesta área.")); $("view").replaceChildren(list); }
  } catch (error) { if (sequence === loadSequence && user) { $("panel-error").textContent = error.message; $("view").replaceChildren(); } }
}
$("login-form").addEventListener("submit", async event => {
  event.preventDefault(); $("login-submit").disabled = true; $("login-error").textContent = "";
  try { showPanel(await api("login", { method: "POST", body: JSON.stringify({ email: $("email").value.trim(), password: $("password").value }) })); }
  catch (error) { $("login-error").textContent = error.message; $("password").value = ""; }
  finally { $("login-submit").disabled = false; }
});
$("show-password").addEventListener("click", () => { const visible = $("password").type === "password"; $("password").type = visible ? "text" : "password"; $("show-password").textContent = visible ? "Ocultar" : "Mostrar"; $("show-password").setAttribute("aria-pressed", String(visible)); });
$("logout").addEventListener("click", async () => { if (newsModule && !newsModule.canLeave()) return; $("logout").disabled = true; try { await api("logout", { method: "POST" }); showLogin(); } catch (error) { $("panel-error").textContent = error.message; } finally { $("logout").disabled = false; } });
$("refresh").addEventListener("click", () => navigate(current));
$("menu-toggle").addEventListener("click", () => { const open = $("panel").classList.toggle("menu-open"); $("menu-toggle").setAttribute("aria-expanded", String(open)); });
document.addEventListener("keydown", event => { if (event.key === "Escape") { $("panel").classList.remove("menu-open"); $("menu-toggle").setAttribute("aria-expanded", "false"); } });
api("me").then(showPanel).catch(error => showLogin(error.message === "Entre para continuar." ? "" : error.message));
