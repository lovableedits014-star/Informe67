import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test("publishing updates visible feedback next to the action, shows notice and locks duplicate publication", async () => {
  const dom = new JSDOM('<div id="view"></div>', { url: "http://localhost:3000/admin/", runScripts: "outside-only" });
  const w = dom.window;
  w.eval(read("../node_modules/quill/dist/quill.js"));
  w.eval(read("../public/admin/news.js"));
  let writes = 0;
  const module = (w as any).NewsModule.mount({ root: w.document.querySelector("#view"), user: { permissions: ["news.create", "news.edit", "news.publish"] }, api: async (path: string, options?: { body: string }) => {
    if (path.startsWith("news?")) return { items: [], total: 0, pageSize: 20 };
    if (path === "news/options") return { categories: [{ id: "category-id", name: "Brasil" }], tags: [] };
    if (options) { writes++; return { ...JSON.parse(options.body), id: "news-id", images: [], updatedAt: new Date().toISOString() }; }
    throw Error("Unexpected route");
  } });
  try {
    await settle();
    [...w.document.querySelectorAll("button")].find(b => b.textContent === "+ Nova matéria")!.click(); await settle();
    const title = w.document.querySelector<HTMLInputElement>("#news-title")!; title.value = "Teste publicado"; title.dispatchEvent(new w.Event("input", { bubbles: true }));
    (w as any).Quill.find(w.document.querySelector("#news-text-editor")).setText("Texto da matéria", "user");
    assert.equal(w.document.querySelector("#news-category option:last-child")!.textContent, "Brasil");
    w.document.querySelector<HTMLButtonElement>("#news-publish")!.click(); await settle();
    assert.equal(writes, 1);
    assert.match(w.document.querySelector("#news-action-message")!.textContent!, /Matéria publicada com sucesso/);
    assert.match(w.document.querySelector(".news-notice")!.textContent!, /Matéria publicada com sucesso/);
    assert.equal(w.document.querySelector("#news-state")!.textContent, "Publicada");
    assert.equal(w.document.querySelector<HTMLButtonElement>("#news-publish")!.disabled, true);
    assert.equal(module.canLeave(), true);
  } finally { module.dispose(); w.close(); }
});

test("public grid and featured story render PostgreSQL API data, preserving category and search filters", async () => {
  const dom = new JSDOM(read("../../index.html"), { url: "http://localhost:5500/", runScripts: "outside-only" }); const w = dom.window;
  const items = [{ id: "1", title: "Notícia publicada", slug: "noticia-publicada", summary: "Texto real", categoryName: "Brasil", publishedAt: new Date().toISOString(), isFeatured: true, featuredOrder: 0, coverUrl: "/media/news/a.webp" }];
  let scrolled = 0;
  w.HTMLElement.prototype.scrollIntoView = () => { scrolled++; };
  const cats = [{ slug: "brasil", name: "Brasil", total: 1, highlight: items[0] }, { slug: "campo-grande", name: "Campo Grande", total: 0, highlight: null }, { slug: "politica", name: "Política", total: 0, highlight: null }];
  Object.assign(w, { Informe67API: { get: async (path: string) => { const q=new URL(path,'http://api.test').searchParams; const selected=q.get('category'); const found=selected&&selected!=='brasil'||q.get('search')==='inexistente'?[]:items; return {items:found,total:found.length,page:1,pageSize:6,categories:cats,featured:items}; }, image: (path: string) => `http://localhost:3000${path}`, article: (slug: string) => `noticia.html?slug=${slug}` } });
  try {
    w.eval(read("../../script.js")); await settle();
    const cards = w.document.querySelectorAll("#news-grid .news-card"); assert.equal(cards.length, 1);
    assert.match(cards[0].textContent!, /Notícia publicada/);
    assert.equal(w.document.querySelector("#lead-title")!.textContent, "Notícia publicada");
    assert.equal(cards[0].querySelector("a")!.getAttribute("href"), "noticia.html?slug=noticia-publicada");
    assert.equal(w.document.querySelectorAll('.category-spotlight').length, 3);
    assert.equal(w.document.querySelectorAll('.category-spotlight .category-more').length, 3);
    assert.ok(w.document.querySelector('[data-filter="Política"]'));
    w.document.querySelector<HTMLAnchorElement>('[data-filter="Campo Grande"]')!.click(); await settle(); assert.equal(w.document.querySelectorAll('#news-grid .news-card').length,0); assert.ok(scrolled>0);
    w.document.querySelector<HTMLAnchorElement>('[data-filter="Brasil"]')!.click(); await settle(); assert.equal(w.document.querySelectorAll('#news-grid .news-card').length,1); assert.match(w.location.search,/categoria=brasil/);
    const search = w.document.querySelector<HTMLInputElement>("#search-input")!; search.value = "inexistente"; search.dispatchEvent(new w.Event("input")); await new Promise(resolve=>setTimeout(resolve,350)); assert.equal(w.document.querySelectorAll('#news-grid .news-card').length,0);
  } finally { w.close(); }
});

test("public article page loads the selected slug and published content instead of demo copy", async () => {
  const dom = new JSDOM(read("../../noticia.html"), { url: "http://localhost:5500/noticia.html?slug=real", runScripts: "outside-only" }); const w = dom.window;
  Object.assign(w, { Informe67API: { get: async () => ({ title: "Matéria real", content: "<p>Conteúdo publicado.</p>", categoryName: "Cultura", authorName: "Redação", publishedAt: new Date().toISOString(), images: [], tags: ["Cultura"] }) } });
  try {
    w.eval(read("../../noticia.js")); await settle();
    assert.equal(w.document.querySelector(".article h1")!.textContent, "Matéria real");
    assert.match(w.document.querySelector(".article-body")!.textContent!, /Conteúdo publicado/);
    assert.equal(w.document.querySelector<HTMLElement>(".article")!.hidden, false);
    assert.equal(w.document.querySelector(".article-demo-note"), null);
  } finally { w.close(); }
});

test("public API works in local and file previews without AbortSignal.timeout", async () => {
  for (const url of ["http://127.0.0.1:5500/index.html", "file:///C:/portal/index.html"]) {
    const dom = new JSDOM('<meta name="informe67-api" content="">', { url, runScripts: "outside-only" }); const w = dom.window;
    let requested = "";
    (w.AbortSignal as any).timeout = undefined;
    Object.assign(w, { fetch: async (url: URL) => { requested = String(url); return { ok: true, json: async () => ({ items: [] }) }; } });
    try {
      w.eval(read("../../public-api.js"));
      const result = await (w as any).Informe67API.get("/api/news");
      assert.equal(requested, "http://127.0.0.1:3000/api/news"); assert.equal(result.items.length, 0);
    } finally { w.close(); }
  }
});

test("a failed load can be retried by category and does not masquerade as zero news", async () => {
  const dom = new JSDOM(read("../../index.html"), { url: "http://127.0.0.1:5500/", runScripts: "outside-only" }); const w = dom.window;
  let attempts = 0;
  Object.assign(w, { Informe67API: {
    get: async () => { if (++attempts === 1) throw Error("Temporary connection failure"); return { items: [{ id: "1", title: "Teste", slug: "teste", categoryName: "Campo Grande", publishedAt: new Date().toISOString() }], total: 1, page: 1, pageSize: 12, categories: [{name:'Campo Grande',slug:'campo-grande',total:1,highlight:null}], featured: [] }; },
    image: () => "assets/news-placeholder.svg", article: () => "noticia.html?slug=teste",
  } });
  w.console.warn = () => {};
  try {
    w.eval(read("../../script.js")); await settle();
    assert.equal(w.document.querySelector("#results-count")!.textContent, "Notícias indisponíveis");
    assert.equal(w.document.querySelector("#empty-state button")!.textContent, "Tentar novamente");
    w.document.querySelector<HTMLButtonElement>('[data-filter="Campo Grande"]')!.click(); await settle();
    assert.equal(w.document.querySelector("#results-count")!.textContent, "1 de 1 notícia");
    assert.equal(w.document.querySelectorAll("#news-grid .news-card:not([hidden])").length, 1);
    assert.equal(w.document.querySelector<HTMLElement>("#empty-state")!.hidden, true);
  } finally { w.close(); }
});

test("homepage stays bounded and category more links open paginated results below the sticky header", async () => {
  const dom = new JSDOM(read('../../index.html'), {url:'http://localhost:5500/index.html',runScripts:'outside-only'}); const w=dom.window;
  const items=Array.from({length:31},(_,i)=>({id:String(i),title:`Matéria ${i}`,slug:`materia-${i}`,categoryName:'Capital',publishedAt:new Date().toISOString()}));
  const cats=[{slug:'capital',name:'Capital',total:31,highlight:items[0]},{slug:'economia',name:'Economia',total:0,highlight:null}];
  let scrolls=0;w.HTMLElement.prototype.scrollIntoView=()=>{scrolls++;};
  const header=w.document.querySelector<HTMLElement>('.site-header')!;header.style.position='sticky';header.getBoundingClientRect=()=>({height:100} as DOMRect);
  Object.assign(w,{Informe67API:{get:async(path:string)=>{const q=new URL(path,'http://api.test').searchParams;const size=Number(q.get('pageSize')),page=Number(q.get('page'));return{items:items.slice((page-1)*size,page*size),total:31,page,pageSize:size,categories:cats,featured:[]};},image:()=> 'assets/news-placeholder.svg',article:(slug:string)=>`noticia.html?slug=${slug}`}});
  try {
    w.eval(read('../../script.js'));await settle();
    assert.equal(w.document.querySelectorAll('#news-grid .news-card').length,6);
    assert.equal(w.document.querySelectorAll('#category-highlights .category-story').length,1);
    w.document.querySelector<HTMLAnchorElement>('#categoria-capital .category-more')!.click();await settle();
    assert.equal(w.document.querySelectorAll('#news-grid .news-card').length,12);
    assert.equal(w.document.querySelector<HTMLElement>('#editorias')!.hidden,true);
    assert.equal(w.document.querySelector<HTMLElement>('#ultimas')!.style.scrollMarginTop,'124px');assert.ok(scrolls>0);
    const next=[...w.document.querySelectorAll<HTMLAnchorElement>('.public-pagination a')].find(a=>a.textContent==='Próxima →')!;next.click();await settle();
    assert.match(w.location.search,/pagina=2/);assert.equal(w.document.querySelector('#news-grid h3')!.textContent,'Matéria 12');
  } finally {w.close();}
});

test("category deletion dialog requires a destination and reports the transfer", async()=>{
  const dom=new JSDOM('<div id="view"></div>',{url:'http://localhost:3000/admin/',runScripts:'outside-only'}),w=dom.window;
  (w.HTMLDialogElement.prototype as any).showModal=function(){this.open=true;};
  (w.HTMLDialogElement.prototype as any).close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.eval(read('../public/admin/categories.js'));
  const root=w.document.querySelector('#view')!,items=[{id:'one',name:'Capital',newsCount:3,isActive:true},{id:'two',name:'Brasil',newsCount:2,isActive:true}],user={permissions:['categories.delete','categories.transfer']};
  let request:any;
  const api=async(path:string,options:any)=>{request={path,body:JSON.parse(options.body)};return{moved:3};};
  const render=(list:any[]) => (w as any).CategoryModule.render({root,items:list,user,api,reload:async()=>render([items[1]])});
  try{render(items);root.querySelector<HTMLButtonElement>('button')!.click();const select=root.querySelector<HTMLSelectElement>('select')!;assert.equal(select.required,true);assert.equal(select.querySelector('option[value="one"]'),null);select.value='two';root.querySelector('form')!.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.deepEqual(request,{path:'categories/one',body:{targetId:'two'}});assert.match(root.querySelector('[role="status"]')!.textContent!,/3 matéria/);assert.equal(root.querySelectorAll('tbody tr').length,1);}finally{w.close();}
});

test("category editor previews the automatic slug and submits only the name",async()=>{
  const dom=new JSDOM('<div id="view"></div>',{url:'http://localhost:3000/admin/',runScripts:'outside-only'}),w=dom.window;
  (w.HTMLDialogElement.prototype as any).showModal=function(){this.open=true;};(w.HTMLDialogElement.prototype as any).close=function(){this.dispatchEvent(new w.Event('close'));};w.eval(read('../public/admin/categories.js'));
  const root=w.document.querySelector('#view')!;let request:any;
  const render=()=> (w as any).CategoryModule.render({root,items:[{id:'one',name:'Capital',slug:'capital',newsCount:10,isActive:true}],user:{permissions:['categories.edit']},api:async(path:string,options:any)=>{request={path,method:options.method,body:JSON.parse(options.body)};return{};},reload:async()=>render()});
  try{render();root.querySelector<HTMLButtonElement>('button')!.click();const name=root.querySelector<HTMLInputElement>('#category-edit-name')!;name.value='São Paulo';name.dispatchEvent(new w.Event('input'));const slug=root.querySelector<HTMLInputElement>('#category-edit-slug')!;assert.equal(slug.value,'sao-paulo');assert.equal(slug.readOnly,true);root.querySelector('form')!.dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();assert.deepEqual(request,{path:'categories/one',method:'PUT',body:{name:'São Paulo'}});assert.match(root.querySelector('[role="status"]')!.textContent!,/atualizada/);}finally{w.close();}
});

test('same configured GIF is linked above the hero and between article paragraphs',async()=>{
 const dom=new JSDOM('<main><aside class="ad-slot"></aside><div class="article-body"><p>Primeiro</p><p>Segundo</p><p>Terceiro</p><p>Quarto</p></div></main>',{url:'http://127.0.0.1:5500/index.html',runScripts:'outside-only'}),w=dom.window;
 const banner={imageUrl:'/media/banners/11111111-1111-4111-8111-111111111111.gif',targetUrl:'https://example.test',altText:'Anúncio'};
 Object.assign(w,{fetch:async()=>({ok:true,json:async()=>({header:banner,inArticle:banner})})});
 try{w.eval(read('../../public-api.js'));await settle();const body=w.document.querySelector('.article-body')!;await(w as any).PublicBanners.article(body);const ads=w.document.querySelectorAll('.ad-slot');assert.equal(ads.length,2);assert.equal(ads[0].querySelector('a')!.href,'https://example.test/');assert.match(ads[1].querySelector('img')!.src,/\.gif$/);assert.equal(ads[1].previousElementSibling!.textContent,'Segundo');assert.equal(ads[1].nextElementSibling!.textContent,'Terceiro');}finally{w.close();}
});
