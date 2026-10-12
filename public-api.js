"use strict";
// The deployed portal uses its own origin. Only standalone local previews use port 3000.
const configuredApi = document.querySelector('meta[name="informe67-api"]')?.content.trim();
const localSite = ["localhost", "127.0.0.1"].includes(location.hostname) || location.protocol === "file:";
let apiBase = localSite ? configuredApi || (location.protocol === 'file:' || location.port === '5500' ? "http://127.0.0.1:3000" : location.origin) : location.origin;
window.Informe67API = {
  get base() { return apiBase; },
  async get(path) {
    // AbortController also works in preview browsers without AbortSignal.timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(new URL(path, apiBase), { credentials: "omit", signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "Matéria não encontrada ou não publicada." : "Não foi possível carregar as notícias. Tente novamente.");
      return await response.json();
    } finally { clearTimeout(timer); }
  },
  image(path) { return path ? new URL(path, apiBase).href : "assets/news-placeholder.svg"; },
  article(slug) { return `noticia.html?slug=${encodeURIComponent(slug)}`; },
};

window.PublicBanners={
  pending:null,
  get(){return this.pending??=(Informe67API.get('/api/banners').catch(()=>({header:null,inArticle:null})));},
  create(banner){const aside=document.createElement('aside');aside.className='ad-slot article-banner';aside.setAttribute('aria-label','Publicidade');const label=document.createElement('p');label.className='ad-label';label.textContent='Publicidade';const link=document.createElement('a');link.href=banner.targetUrl;link.target='_blank';link.rel='noopener noreferrer sponsored';const image=document.createElement('img');image.src=Informe67API.image(banner.imageUrl);image.alt=banner.altText;image.loading='lazy';link.append(image);aside.append(label,link);return aside;},
  async article(body){const data=await this.get();if(!data.inArticle||!body.isConnected)return;body.querySelectorAll('.article-banner').forEach(n=>n.remove());const paragraphs=[...body.children].filter(n=>n.tagName==='P');const banner=this.create(data.inArticle);if(paragraphs.length)paragraphs[Math.floor((paragraphs.length-1)/2)].after(banner);else body.append(banner);},
};
const heroAd=document.querySelector('main > .ad-slot');
if(heroAd){heroAd.hidden=true;PublicBanners.get().then(data=>{if(!data.header)return;const banner=PublicBanners.create(data.header);heroAd.replaceChildren(...banner.children);heroAd.hidden=false;});}
