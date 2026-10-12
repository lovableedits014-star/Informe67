import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {processBanner,validateBanner} from '../src/admin/banners.js';
import {buildApp} from '../src/app.js';
import {hashPassword} from '../src/admin/password.js';
const id='11111111-1111-4111-8111-111111111111',imageUrl=`/media/banners/${id}.gif`;
const input={name:'Campanha',altText:'Anúncio',targetUrl:'https://example.test',imageUrl,position:'header',showInArticles:true,status:'active',sortOrder:0,startsAt:null,endsAt:null};
test('banner validation permits GIF links and rejects executable URLs and invalid dates',()=>{
 assert.equal(validateBanner(input).showInArticles,true);
 for(const changed of [{targetUrl:'javascript:alert(1)'},{targetUrl:'//evil.test'},{targetUrl:'https://user:secret@example.test'},{imageUrl:'/file.svg'},{sortOrder:-1},{startsAt:'2026-10-13T12:00:00Z',endsAt:'2026-10-12T12:00:00Z'}])assert.throws(()=>validateBanner({...input,...changed}));
});
test('animated GIF remains animated and the existing static banner also decodes safely',async()=>{
 const pixels=Buffer.alloc(4*8*3);for(let i=0;i<pixels.length;i+=3)pixels[i<48?i:i+2]=255;
 const bytes=await sharp(pixels,{raw:{width:4,height:8,channels:3,pageHeight:4}}).gif({delay:[100,150],loop:0}).toBuffer();const before=await sharp(bytes,{animated:true}).metadata();const processed=await processBanner(bytes);const after=await sharp(processed.buffer,{animated:true}).metadata();assert.equal(processed.extension,'gif');assert.equal(after.format,'gif');assert.equal(after.pages,before.pages);assert.ok((after.pages??1)>1);assert.deepEqual(after.delay,before.delay);await assert.rejects(processBanner(Buffer.from('<svg/>')));
 const existing=await processBanner(await readFile(new URL('../../assets/ads/banner-mensal.gif',import.meta.url)));assert.ok(existing.buffer.length>0);
});
test('banner editing requires management permission and CSRF',async t=>{
 const password='test-only-banner-password',hash=await hashPassword(password),user={id,email:'test@example.test',displayName:'Test',passwordHash:hash,isActive:true,permissions:['admin.access','banners.read']};let writes=0;
 const app=buildApp({query:async()=>({rows:[]}),end:async()=>{}},{adminOrigin:'http://localhost:3000',adminStore:{findByEmail:async()=>user,findById:async()=>user,audit:async()=>{},list:async()=>[],dashboard:async()=>({counts:{},recentNews:[]})},bannerStore:{list:async()=>[],save:async()=>{writes++;return{id};},publicList:async()=>({header:null,inArticle:null})}});t.after(()=>app.close());
 const login=await app.inject({method:'POST',url:'/api/admin/login',headers:{origin:'http://localhost:3000'},payload:{email:user.email,password}});const headers={origin:'http://localhost:3000',cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
 assert.equal((await app.inject({method:'POST',url:'/api/admin/banners',headers,payload:input})).statusCode,403);user.permissions.push('banners.manage');assert.equal((await app.inject({method:'POST',url:'/api/admin/banners',headers:{cookie:headers.cookie,origin:headers.origin},payload:input})).statusCode,403);assert.equal((await app.inject({method:'POST',url:'/api/admin/banners',headers,payload:input})).statusCode,201);assert.equal(writes,1);
});
