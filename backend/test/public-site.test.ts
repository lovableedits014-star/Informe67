import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildApp } from '../src/app.js';
import type { AdminStore } from '../src/admin/store.js';
import type { NewsStore } from '../src/news/store.js';

function fixture(publicBySlug: NewsStore['publicBySlug'] = async()=>undefined) {
  const queries: string[] = [];
  const adminStore: AdminStore = { findByEmail: async () => undefined, findById: async () => undefined, dashboard: async () => ({counts:{},recentNews:[]}), list: async () => [], audit: async () => {} };
  const newsStore: NewsStore = { list: async () => ({items:[],total:0,page:1,pageSize:20}),get:async()=>undefined,options:async()=>({categories:[],tags:[]}),save:async()=>{throw Error('Read-only fixture');},publishDue:async()=>0,publicList:async()=>[],publicBySlug,publicBrowse:async()=>({items:[],total:0,page:1,pageSize:12,categories:[],featured:[]}) };
  const app=buildApp({query:async(text)=>{queries.push(text);return{rows:[]};},end:async()=>{}},{adminStore,newsStore,adminOrigin:'http://localhost:3000'});
  return{app,queries};
}

test('root and public resources serve the repository frontend without changing its layout',async t=>{
  const {app,queries}=fixture();t.after(()=>app.close());
  for(const path of ['index.html','noticia.html','styles.css','script.js','noticia.js','public-api.js']){
    const result=await app.inject('/'+path);assert.equal(result.statusCode,200,path);
    assert.equal(result.body,readFileSync(new URL('../../'+path,import.meta.url),'utf8'),path);
    assert.equal(result.headers['x-content-type-options'],'nosniff');
  }
  const home=await app.inject('/');assert.equal(home.statusCode,200);assert.match(String(home.headers['content-type']),/text\/html/);assert.equal(home.body,(await app.inject('/index.html')).body);
  const asset=await app.inject('/assets/news-placeholder.svg');assert.equal(asset.statusCode,200);assert.match(String(asset.headers['content-type']),/image\/svg\+xml/);
  const head=await app.inject({method:'HEAD',url:'/'});assert.equal(head.statusCode,200);assert.equal(head.body,'');
  assert.deepEqual(queries,[]);
});

test('static homepage preserves admin, API and media routing and does not provide an HTML fallback for missing endpoints',async t=>{
  const{app,queries}=fixture();t.after(()=>app.close());
  const admin=await app.inject('/admin/');assert.equal(admin.statusCode,200);assert.match(admin.body,/login-form/);assert.equal(admin.headers['cache-control'],'no-store');
  assert.equal((await app.inject('/api/admin/me')).statusCode,401);
  assert.equal((await app.inject('/api/health')).json().status,'ok');
  assert.deepEqual((await app.inject('/api/news')).json(),{items:[]});
  for(const path of ['/api/missing','/media/news/invalid.webp','/media/banners/invalid.gif','/missing.html']){
    const result=await app.inject(path);assert.equal(result.statusCode,404,path);assert.equal(result.body.includes('<!doctype html>'),false,path);
  }
  assert.deepEqual(queries,[]);
});

test('public article route accepts validated slugs longer than the router default',async t=>{
  const slug='inteligencia-artificial-pode-esclarecer-duvidas-mas-nao-substitui-diagnostico-em-saude-mental-alerta-psiquiatra-7f307757';
  assert.ok(slug.length>100);
  const{app}=fixture(async requested=>requested===slug?{slug,title:'Matéria publicada',content:'<p>Conteúdo publicado.</p>',images:[],tags:[]}:undefined);t.after(()=>app.close());
  const response=await app.inject(`/api/news/${slug}`);
  assert.equal(response.statusCode,200);assert.equal(response.json().slug,slug);
});

test('public static directory never exposes secrets, backend files or traversal targets',async t=>{
  const{app}=fixture();t.after(()=>app.close());
  for(const path of ['/.env','/backend/.env','/package.json','/Dockerfile','/src/server.ts','/.git/config','/.private/ai.key','/uploads/news/file.webp','/%2e%2e%2f.env','/assets/%2e%2e/%2e%2e/.env']){
    const result=await app.inject(path);assert.ok([400,403,404].includes(result.statusCode),path);assert.equal(result.body.includes('PGPASSWORD='),false,path);
  }
});

test('deployed frontend resolves API and media through its own HTTPS domain even with an obsolete API meta tag',async()=>{
  for(const url of ['https://informe67.example/','https://informe67.example/noticia.html?slug=publicada','http://localhost:3333/']){
    const dom=new JSDOM('<meta name="informe67-api" content="">',{url,runScripts:'outside-only'}),w=dom.window;
    if(url.startsWith('https:'))w.document.querySelector('meta')!.content='http://127.0.0.1:3000';
    let requested='';(w as any).fetch=async(target:URL)=>{requested=target.href;return{ok:true,json:async()=>({items:[]})};};
    try{w.eval(readFileSync(new URL('../../public-api.js',import.meta.url),'utf8'));await(w as any).Informe67API.get('/api/news');assert.equal(requested,new URL('/api/news',url).href);assert.equal((w as any).Informe67API.image('/media/news/test.webp'),new URL('/media/news/test.webp',url).href);}finally{w.close();}
  }
});

test('homepage never displays demo stories before a delayed API response, then reveals real news', async () => {
  const dom = new JSDOM(readFileSync(new URL('../../index.html', import.meta.url), 'utf8'), { url: 'https://informe67.example/', runScripts: 'outside-only' });
  const w = dom.window;
  let deliver!: (value: unknown) => void;
  (w as any).Informe67API = { get: () => new Promise(resolve => { deliver = resolve; }), image: (path: string) => path, article: (slug: string) => `noticia.html?slug=${slug}` };
  try {
    assert.equal((w.document.querySelector('.lead-section') as HTMLElement).hidden, true);
    assert.equal((w.document.querySelector('main > .ad-slot') as HTMLElement).hidden, true);
    assert.equal(w.document.querySelectorAll('#news-grid .news-card, .brief-item').length, 0);
    w.eval(readFileSync(new URL('../../script.js', import.meta.url), 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((w.document.querySelector('.lead-section') as HTMLElement).hidden, true);
    assert.equal(w.document.querySelector('#news-grid')!.getAttribute('aria-busy'), 'true');
    const item = { id: 'real', slug: 'materia-real', title: 'Matéria real publicada', publishedAt: '2026-10-12T12:00:00Z', categoryName: 'Capital', coverUrl: '/media/news/real.webp' };
    deliver({ items: [item], featured: [], categories: [], total: 1, page: 1, pageSize: 6 });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal((w.document.querySelector('.lead-section') as HTMLElement).hidden, false);
    assert.equal(w.document.querySelector('#lead-title a')!.textContent, item.title);
    assert.equal(w.document.querySelector('#news-grid h3')!.textContent, item.title);
    assert.equal(w.document.querySelector('#news-grid')!.getAttribute('aria-busy'), 'false');
    const article = new JSDOM(readFileSync(new URL('../../noticia.html', import.meta.url), 'utf8'));
    assert.equal((article.window.document.querySelector('.article') as HTMLElement).hidden, true);
    article.window.close();
  } finally { w.close(); }
});
