"use strict";
window.NewsModule = {
  mount({ root, user, api }) {
    let disposed = false, dirty = false, saving = false, uploading = false, sequence = 0, timer, article, editor, rewrite, images = [], page = 1, search = "", filter = "";
    const can = permission => user.permissions.includes(`news.${permission}`);
    const labels = { draft: "Rascunho", published: "Publicada", scheduled: "Agendada", archived: "Arquivada" };
    const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const slugify = text => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const button = (text, handler, cls = "secondary") => { const b = node("button", cls, text); b.type = "button"; b.addEventListener("click", handler); return b; };
    const message = (text, error = false) => { root.querySelector(".news-notice")?.remove(); for (const id of ["news-message", "news-action-message"]) { const target = root.querySelector(`#${id}`); if (target) { target.textContent = text; target.className = error ? "error" : "save-status"; } } };
    const canLeave = () => !saving && !uploading && (!rewrite || rewrite.canLeave()) && (!dirty || window.confirm("Há alterações não salvas. Sair sem salvar?"));
    const beforeUnload = event => { if (dirty || saving || uploading || rewrite?.hasChanges()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    function clearEditor() { clearInterval(timer); rewrite?.dispose(); rewrite=undefined; editor = undefined; article = undefined; images = []; dirty = false; }

    async function list() {
      if (disposed) return;
      clearEditor(); const requestSequence = ++sequence;
      root.replaceChildren(node("p", "muted", "Carregando notícias…"));
      try {
        const data = await api(`news?page=${page}&search=${encodeURIComponent(search)}${filter ? `&status=${filter}` : ""}`);
        if (disposed || sequence !== requestSequence) return;
        const controls = node("form", "news-controls");
        const input = node("input"); input.type = "search"; input.placeholder = "Buscar pelo título"; input.setAttribute("aria-label", "Buscar notícias"); input.value = search;
        const select = node("select"); select.setAttribute("aria-label", "Estado editorial");
        for (const [value, label] of [["", "Todos os estados"], ...Object.entries(labels)]) { const opt = node("option", "", label); opt.value = value; select.append(opt); } select.value = filter;
        const submit = node("button", "secondary", "Buscar"); submit.type = "submit";
        controls.append(input, select, submit);
        controls.addEventListener("submit", event => { event.preventDefault(); search = input.value; filter = select.value; page = 1; list(); });
        if (can("create")) controls.append(button("+ Nova matéria", () => open(), "primary compact"));
        const tabs=node('nav','news-controls');tabs.setAttribute('aria-label','Seções de Notícias');const articlesTab=button('Matérias',list,'secondary');articlesTab.setAttribute('aria-current','page');tabs.append(articlesTab);
        if(can('rewrite'))tabs.append(button('Reescrita com IA',()=>{if(!canLeave())return;clearEditor();sequence++;rewrite=window.RewriteModule.mount({root,user,api,openNews:open,back:list});},'secondary'));
        const card = node("section", "card");
        const header = node("div", "card-header"); header.append(node("h2", "", "Matérias"), node("small", "", `${data.total} registro(s)`)); card.append(header);
        if (!data.items.length) { const empty = node("div", "empty"); empty.append(node("h3", "", "Nenhuma matéria encontrada"), node("p", "", "Crie uma matéria ou ajuste os filtros.")); card.append(empty); }
        else {
          const wrap = node("div", "table-wrap"), table = node("table"), head = node("thead"), row = node("tr"), body = node("tbody");
          for (const label of ["Matéria", "Estado", "Destaque", "Atualização", "Ações"]) { const th = node("th", "", label); th.scope = "col"; row.append(th); } head.append(row);
          for (const item of data.items) {
            const row = node("tr"), title = node("td"); title.append(node("strong", "", item.title), node("small", "news-slug", item.slug));
            const status = node("td"); status.append(node("span", `badge ${item.status === "draft" ? "draft" : ""}`, labels[item.status]));
            const actions = node("td"); actions.append(button(can("edit") ? "Editar" : "Consultar", () => open(item.id)));
            row.append(title, status, node("td", "", item.isFeatured ? `Sim · ${item.featuredOrder ?? 0}` : "—"), node("td", "", new Date(item.updatedAt).toLocaleString("pt-BR")), actions); body.append(row);
          }
          table.append(head, body); wrap.append(table); card.append(wrap);
        }
        const pagination = node("div", "pagination"); const previous = button("← Anterior", () => { page--; list(); }), next = button("Próxima →", () => { page++; list(); }); previous.disabled = page <= 1; next.disabled = page * data.pageSize >= data.total;
        pagination.append(previous, node("span", "muted", `Página ${page} de ${Math.max(1, Math.ceil(data.total / data.pageSize))}`), next);
        root.replaceChildren(tabs, controls, card, pagination);
      } catch (error) { if (!disposed && requestSequence === sequence) root.replaceChildren(node("p", "error", error.message)); }
    }

    async function open(id) {
      if (!canLeave()) return;
      clearEditor(); const requestSequence = ++sequence;
      root.replaceChildren(node("p", "muted", "Preparando editor…"));
      try {
        const [options, saved] = await Promise.all([api("news/options"), id ? api(`news/${id}`) : Promise.resolve(null)]);
        if (disposed || requestSequence !== sequence) return;
        article = saved; images = saved ? saved.images.map(i => ({ imageUrl: i.imageUrl, altText: i.altText, credits: i.credits, caption: i.caption, isCover: i.isCover })) : [];
        renderEditor(options);
      } catch (error) { if (!disposed && requestSequence === sequence) root.replaceChildren(node("p", "error", error.message), button("Voltar", list)); }
    }
    function renderEditor(options) {
      const writable = (article ? can("edit") : can("create")) && (!article || !["published", "scheduled"].includes(article.status) || can("publish")) && (article?.status !== "archived" || can("archive"));
      const form = node("form", "news-editor-form");
      // Static trusted markup; all database values below are assigned through DOM properties.
      form.innerHTML = `<div class="editor-heading"><button type="button" id="news-back" class="secondary">← Matérias</button><span id="news-state" class="badge"></span><span id="news-message" role="status"></span></div>
        <div class="editor-grid"><section class="card editor-main"><div class="card-body">
          <label for="news-title">Título <span>*</span></label><input id="news-title" maxlength="240" required placeholder="O que você quer contar?">
          <label for="news-slug">Slug <span>*</span></label><input id="news-slug" maxlength="260" required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="endereco-da-materia">
          <label for="news-summary">Resumo</label><textarea id="news-summary" maxlength="500" rows="3" placeholder="Uma apresentação breve da matéria"></textarea>
          <label id="news-content-label">Conteúdo</label><div id="news-text-editor"></div>
          <div class="editor-images"><h3>Imagens da matéria</h3><p class="muted">Edite descrições, legendas e créditos. Use o botão de imagem do editor para inserir no texto.</p><div id="news-images"></div></div>
        </div></section><aside class="editor-aside">
          <section class="card"><div class="card-header"><h2>Organização</h2></div><div class="card-body">
            <label for="news-category">Categoria</label><select id="news-category"><option value="">Sem categoria</option></select>
            <label for="news-tags">Tags</label><input id="news-tags" list="news-tags-suggestions" placeholder="Separe por vírgulas"><datalist id="news-tags-suggestions"></datalist>
            <label class="check-label"><input id="news-featured" type="checkbox"> Destaque na página inicial</label>
            <label for="news-featured-order">Ordem do destaque</label><input id="news-featured-order" type="number" min="0" max="10000" value="0">
          </div></section>
          <section class="card"><div class="card-header"><h2>Imagem de capa</h2></div><div class="card-body"><div id="news-cover-preview"></div><label for="news-cover-file">Enviar capa · até 5 MB</label><input id="news-cover-file" type="file" accept="image/jpeg,image/png,image/webp"><p class="muted">JPEG, PNG ou WebP. Os créditos ficam junto às imagens abaixo do editor.</p></div></section>
          <section class="card"><div class="card-header"><h2>Publicação</h2></div><div class="card-body">
            <label for="news-schedule">Data e hora do agendamento</label><input id="news-schedule" type="datetime-local"><p class="muted">Horário local deste computador.</p>
            <label class="check-label"><input id="news-autosave" type="checkbox" checked> Salvar rascunho automaticamente</label>
            <div id="news-actions" class="news-actions"></div><p id="news-action-message" role="status" aria-live="polite"></p>
          </div></section>
          <section class="card"><div class="card-header"><h2>SEO</h2></div><div class="card-body">
            <label for="news-seo-title">Título SEO</label><input id="news-seo-title" maxlength="240">
            <label for="news-seo-description">Descrição SEO</label><textarea id="news-seo-description" rows="3" maxlength="320"></textarea>
            <label for="news-canonical">URL canônica</label><input id="news-canonical" type="url" maxlength="2048" placeholder="https://…">
            <label class="check-label"><input id="news-noindex" type="checkbox"> Não indexar nos buscadores</label>
          </div></section>
        </aside></div>`;
      root.replaceChildren(form);
      const get = id => form.querySelector(`#${id}`);
      get("news-back").addEventListener("click", () => { if (canLeave()) list(); });
      get("news-state").textContent = labels[article?.status ?? "draft"];
      for (const [id, key] of [["news-title", "title"], ["news-slug", "slug"], ["news-summary", "summary"], ["news-seo-title", "seoTitle"], ["news-seo-description", "seoDescription"], ["news-canonical", "canonicalUrl"], ["news-featured-order", "featuredOrder"]]) get(id).value = article?.[key] ?? (key === "featuredOrder" ? 0 : "");
      get("news-featured").checked = !!article?.isFeatured; get("news-noindex").checked = !!article?.seoNoIndex;
      get("news-tags").value = article?.tags.join(", ") ?? "";
      for (const category of options.categories) { const opt = node("option", "", category.name); opt.value = category.id; get("news-category").append(opt); } get("news-category").value = article?.categoryId ?? "";
      for (const tag of options.tags) { const opt = node("option"); opt.value = tag.name; get("news-tags-suggestions").append(opt); }
      if (article?.scheduledAt) { const date = new Date(article.scheduledAt); get("news-schedule").value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
      editor = new Quill(get("news-text-editor"), { theme: "snow", placeholder: "Escreva sua matéria…", formats: ["header", "bold", "italic", "underline", "strike", "blockquote", "list", "align", "link", "image"], modules: { toolbar: [[{ header: [2, 3, false] }], ["bold", "italic", "underline", "strike"], ["blockquote", { list: "ordered" }, { list: "bullet" }], [{ align: [] }], ["link", "image"], ["clean"]] } });
      editor.root.setAttribute("aria-labelledby", "news-content-label"); editor.root.setAttribute("role", "textbox"); editor.root.setAttribute("aria-multiline", "true");
      if (article) editor.clipboard.dangerouslyPasteHTML(article.content, "silent");
      editor.enable(writable);
      editor.on("text-change", (_delta, _old, source) => { if (source === "user") { dirty = true; message("Alterações não salvas"); } });
      form.addEventListener("input", event => { if (event.target.id !== "news-autosave" && writable) { dirty = true; message("Alterações não salvas"); } });
      let slugEdited = !!article;
      get("news-slug").addEventListener("input", () => { slugEdited = true; });
      get("news-title").addEventListener("input", () => { if (!slugEdited) get("news-slug").value = slugify(get("news-title").value).slice(0, 260).replace(/-$/, ""); });
      const fileInput = node("input"); fileInput.type = "file"; fileInput.accept = "image/jpeg,image/png,image/webp"; fileInput.hidden = true; form.append(fileInput);
      let imageRange;
      editor.getModule("toolbar").addHandler("image", () => { if (!writable || !can("upload")) return message("Você não tem permissão para enviar imagens.", true); imageRange = editor.getSelection(true); fileInput.click(); });
      fileInput.addEventListener("change", async () => { const file = fileInput.files[0]; if (file) await upload(file, false, imageRange); fileInput.value = ""; });
      get("news-cover-file").addEventListener("change", async event => { const file = event.target.files[0]; if (file) await upload(file, true); event.target.value = ""; });
      function renderImages() {
        const container = get("news-images"); container.replaceChildren(); get("news-cover-preview").replaceChildren();
        for (const image of images) {
          const item = node("div", "image-metadata"), img = node("img"); img.src = image.imageUrl; img.alt = image.altText; item.append(img);
          const fields = node("div");
          for (const [key, label, max] of [["altText", "Descrição acessível", 300], ["caption", "Legenda", 500], ["credits", "Créditos", 300]]) {
            const wrapper = node("label", "", label), input = node("input"); input.value = image[key] ?? ""; input.maxLength = max; input.required = key === "altText"; input.disabled = !writable;
            input.addEventListener("input", () => { image[key] = input.value; if (key === "altText") for (const embedded of editor.root.querySelectorAll("img")) if (embedded.getAttribute("src") === image.imageUrl) embedded.alt = input.value; dirty = true; }); wrapper.append(input); fields.append(wrapper);
          }
          fields.append(node("small", "muted", image.isCover ? "Imagem de capa" : "Imagem do conteúdo")); item.append(fields); container.append(item);
          if (image.isCover) { const preview = node("img", "cover-preview"); preview.src = image.imageUrl; preview.alt = image.altText; get("news-cover-preview").append(preview); if (writable) get("news-cover-preview").append(button("Remover capa", () => { image.isCover = false; dirty = true; renderImages(); })); }
          if (writable) fields.append(button("Remover imagem", () => {
            for (const embedded of [...editor.root.querySelectorAll("img")]) if (embedded.getAttribute("src") === image.imageUrl) { const blot = Quill.find(embedded); if (blot) editor.deleteText(editor.getIndex(blot), 1, "user"); }
            images = images.filter(i => i !== image); dirty = true; renderImages();
          }));
        }
      }
      async function upload(file, cover, range) {
        if (uploading || saving) return;
        if (file.size > 5 * 1024 * 1024) return message("A imagem deve ter até 5 MB.", true);
        if (images.length >= 30) return message("Use até 30 imagens por matéria.", true);
        uploading = true; message("Enviando imagem…");
        try {
          const body = new FormData(); body.append("image", file);
          const result = await api("news/upload", { method: "POST", body });
          if (disposed) return;
          const image = { ...result, altText: "Imagem da matéria", caption: null, credits: null, isCover: cover };
          if (cover) images.forEach(i => { i.isCover = false; });
          images.push(image);
          if (!cover) { const position = Math.min(range?.index ?? editor.getLength() - 1, editor.getLength() - 1); editor.insertEmbed(position, "image", image.imageUrl, "user"); editor.insertText(position + 1, "\n", "user"); }
          dirty = true; renderImages(); message("Imagem enviada. Informe descrição e créditos e salve a matéria.");
        } catch (error) { message(error.message, true); } finally { uploading = false; }
      }
      async function save(status, automatic = false) {
        if (saving || uploading || !writable || disposed) return;
        if (!form.reportValidity()) return message("Confira os campos obrigatórios antes de salvar.", true);
        if (status === "scheduled" && !get("news-schedule").value) return message("Informe data e hora para agendar.", true);
        const schedule = get("news-schedule").value ? new Date(get("news-schedule").value).toISOString() : null;
        const content = editor.getSemanticHTML();
        const document = { title: get("news-title").value, slug: get("news-slug").value, summary: get("news-summary").value, content, categoryId: get("news-category").value || null, tags: get("news-tags").value.split(",").map(t => t.trim()).filter(Boolean), images, status, scheduledAt: schedule, seoTitle: get("news-seo-title").value, seoDescription: get("news-seo-description").value, canonicalUrl: get("news-canonical").value, seoNoIndex: get("news-noindex").checked, isFeatured: get("news-featured").checked, featuredOrder: Number(get("news-featured-order").value), version: article?.updatedAt ?? null };
        saving = true; message(automatic ? "Salvando rascunho automaticamente…" : "Salvando…");
        // Disable editing during the request to keep the saved version and UI aligned.
        editor.enable(false); for (const input of form.querySelectorAll("input, textarea, select, button")) input.disabled = true;
        try {
          article = await api(article ? `news/${article.id}` : "news", { method: article ? "PUT" : "POST", body: JSON.stringify(document) });
          if (disposed) return;
          images = article.images.map(i => ({ imageUrl: i.imageUrl, altText: i.altText, caption: i.caption, credits: i.credits, isCover: i.isCover }));
          editor.clipboard.dangerouslyPasteHTML(article.content, "silent");
          dirty = false; slugEdited = true; get("news-state").textContent = labels[article.status]; renderImages();
          const confirmation = { published: "Matéria publicada com sucesso!", scheduled: "Publicação agendada com sucesso!", archived: "Matéria arquivada.", draft: "Rascunho salvo." };
          message(`${confirmation[article.status]} · ${new Date().toLocaleTimeString("pt-BR")}`);
          const notice = node("div", "news-notice", confirmation[article.status]); notice.setAttribute("role", "status");
          root.querySelector(".news-notice")?.remove(); form.append(notice);
          if (article.status !== "draft") get("news-autosave").checked = false;
        } catch (error) { message(error.message, true); }
        finally { saving = false; editor?.enable(writable); for (const input of form.querySelectorAll("input, textarea, select, button")) input.disabled = false; lockPermissions(); }
      }
      function lockPermissions() { get("news-featured").disabled = !writable || !can("feature"); get("news-featured-order").disabled = !writable || !can("feature"); get("news-cover-file").disabled = !writable || !can("upload"); const publish = get("news-publish"); if (publish) { publish.disabled = article?.status === "published"; publish.textContent = article?.status === "published" ? "✓ Publicada" : "Publicar agora"; } }
      if (writable) {
        const actions = get("news-actions");
        actions.append(button("Salvar alterações", () => save(article?.status ?? "draft"), "secondary"));
        actions.append(button("Salvar como rascunho", () => { if (article?.status !== "published" || window.confirm("Voltar esta matéria para rascunho? Ela deixará de aparecer na API pública.")) save("draft"); }, "secondary"));
        if (can("publish")) { const publish = button("Publicar agora", () => save("published"), "primary"); publish.id = "news-publish"; actions.append(publish); actions.append(button("Agendar publicação", () => save("scheduled"), "secondary")); }
        if (can("archive") && article) actions.append(button("Arquivar matéria", () => { if (window.confirm("Arquivar esta matéria? Ela deixará de aparecer na API pública.")) save("archived"); }, "secondary danger"));
        form.addEventListener("submit", event => { event.preventDefault(); save(article?.status ?? "draft"); });
        timer = setInterval(() => { if (!disposed && dirty && !saving && !uploading && (!article || article.status === "draft") && get("news-autosave").checked && get("news-title").value.trim() && get("news-slug").value) save("draft", true); }, 45000);
      } else { for (const input of form.querySelectorAll("input, textarea, select")) input.disabled = true; message("Consulta: sua conta não pode alterar esta matéria."); }
      renderImages(); lockPermissions(); dirty = false;
    }
    list();
    return { canLeave, dispose() { disposed = true; clearInterval(timer); rewrite?.dispose(); window.removeEventListener("beforeunload", beforeUnload); } };
  },
};
