const today = document.querySelector("#today");
const year = document.querySelector("#year");
const articleDate = document.querySelector("#article-date");
const shareButton = document.querySelector("#share-button");
const shareStatus = document.querySelector("#share-status");
const now = new Date();

today.textContent = new Intl.DateTimeFormat("pt-BR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
}).format(now);
year.textContent = now.getFullYear();
articleDate.dateTime = now.toISOString().slice(0, 10);
articleDate.textContent = new Intl.DateTimeFormat("pt-BR", {
  day: "numeric",
  month: "long",
  year: "numeric",
}).format(now);

shareButton.addEventListener("click", async () => {
  const shareData = {
    title: document.title,
    text: document.querySelector(".article-deck").textContent,
    url: window.location.href,
  };

  try {
    if (navigator.share) {
      await navigator.share(shareData);
      shareStatus.textContent = "Notícia compartilhada.";
      return;
    }

    await navigator.clipboard.writeText(shareData.url);
    shareStatus.textContent = "Link da notícia copiado.";
  } catch (error) {
    if (error.name === "AbortError") return;
    shareStatus.textContent = "Não foi possível compartilhar neste navegador.";
  }
});

async function loadArticle() {
  const slug = new URLSearchParams(location.search).get("slug");
  if (!slug) {
    const status = document.createElement("p"); status.className = "empty-state";
    status.textContent = "Selecione uma notícia na página inicial para ler a matéria.";
    document.querySelector(".article").before(status);
    return;
  }
  const article = document.querySelector(".article"); article.hidden = true;
  const status = document.createElement("p"); status.className = "empty-state"; status.role = "status"; status.textContent = "Carregando matéria…"; article.before(status);
  try {
    const item = await Informe67API.get(`/api/news/${encodeURIComponent(slug)}`);
    document.title = `${item.seoTitle || item.title} — Informe67`;
    document.querySelector('meta[name="description"]').content = item.seoDescription || item.summary || "";
    if (item.seoNoIndex) { const meta = document.createElement("meta"); meta.name = "robots"; meta.content = "noindex, nofollow"; document.head.append(meta); }
    if (item.canonicalUrl) { const link = document.createElement("link"); link.rel = "canonical"; link.href = item.canonicalUrl; document.head.append(link); }
    article.querySelector("h1").textContent = item.title; article.querySelector(".article-deck").textContent = item.summary || "";
    article.querySelector(".article-category").textContent = item.categoryName || "Notícias";
    article.querySelector(".author-details span").textContent = item.authorName || "Redação Informe67";
    article.querySelector(".author-details span:last-child").textContent = "Informe67";
    articleDate.dateTime = item.publishedAt; articleDate.textContent = new Date(item.publishedAt).toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" });
    document.querySelector(".breadcrumbs a:last-of-type").textContent = item.categoryName || "Notícias";
    const cover = item.images.find(image => image.isCover), figure = article.querySelector(".article-hero"); figure.hidden = !cover;
    if (cover) { figure.querySelector("img").src = Informe67API.image(cover.imageUrl); figure.querySelector("img").alt = cover.altText; figure.querySelector("figcaption").textContent = [cover.caption, cover.credits].filter(Boolean).join(" · "); }
    const body = article.querySelector(".article-body");
    // This HTML is sanitized by the public endpoint; no arbitrary markup is accepted.
    body.innerHTML = item.content;
    for (const image of body.querySelectorAll("img")) image.src = Informe67API.image(image.getAttribute("src"));
    window.PublicBanners?.article(body);
    article.querySelector(".article-date span").textContent = `Leitura: ${Math.max(1, Math.ceil(body.textContent.split(/\s+/).length / 200))} min`;
    const aside = article.querySelector(".article-aside"); aside.querySelectorAll("a:not(.back-to-news)").forEach(link => link.remove());
    const tags = document.createElement("div"); tags.className = "article-tags";
    for (const tag of item.tags) { const span = document.createElement("span"); span.textContent = tag; tags.append(span); } body.append(tags);
    article.hidden = false; status.remove();
  } catch (error) { status.textContent = error.message || "Não foi possível carregar a matéria."; }
}
loadArticle();
if(!new URLSearchParams(location.search).get('slug'))window.PublicBanners?.article(document.querySelector('.article-body'));

async function loadCategoryMenu() {
  try {
    const data = await Informe67API.get('/api/news/browse?pageSize=1');
    if (!Array.isArray(data.categories)) return;
    const nav = document.querySelector('.category-nav .nav-inner');
    const all = document.createElement('a'); all.className = 'nav-link'; all.href = 'index.html#ultimas'; all.textContent = 'Todas';
    nav.replaceChildren(all);
    for (const category of data.categories) {
      const link = document.createElement('a'); link.className = 'nav-link'; link.href = `index.html?categoria=${encodeURIComponent(category.slug)}#ultimas`; link.textContent = category.name; nav.append(link);
    }
  } catch { /* Reading a story remains available if the category menu cannot load. */ }
}
loadCategoryMenu();
