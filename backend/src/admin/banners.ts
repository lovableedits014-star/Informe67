import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import * as s from "../db/schema.js";
import { NewsError } from "../news/validation.js";
import { processImage } from "../news/media.js";

export const bannerDirectory = resolve(process.env.BANNER_UPLOAD_DIR ?? fileURLToPath(new URL('../../uploads/banners/',import.meta.url)));
export const bannerPath = /^\/media\/banners\/[a-f0-9-]{36}\.(gif|webp)$/;
export async function processBanner(bytes: Buffer) {
  if(bytes.length>5*1024*1024)throw new NewsError(413,'Envie um banner de até 5 MB.');
  try {
    const meta=await sharp(bytes,{animated:true,limitInputPixels:40_000_000}).metadata();
    if(meta.format==='gif') {
      if((meta.pages??1)>200)throw Error();
      const buffer=await sharp(bytes,{animated:true,limitInputPixels:40_000_000}).resize({width:1600,withoutEnlargement:true}).gif().toBuffer();
      if(buffer.length>5*1024*1024)throw Error();return{buffer,extension:'gif'};
    }
    return{buffer:await processImage(bytes),extension:'webp'};
  }catch{throw new NewsError(400,'Banner inválido. Use GIF (até 200 quadros), JPEG, PNG ou WebP, com até 40 megapixels.');}
}
export async function uploadBanner(bytes:Buffer){const result=await processBanner(bytes),name=`${randomUUID()}.${result.extension}`;await mkdir(bannerDirectory,{recursive:true});await writeFile(resolve(bannerDirectory,name),result.buffer,{flag:'wx'});return{imageUrl:`/media/banners/${name}`};}
export type BannerInput={name:string;altText:string;imageUrl:string;targetUrl:string;position:'header'|'in_article';showInArticles:boolean;status:'draft'|'active'|'paused'|'archived';sortOrder:number;startsAt:Date|null;endsAt:Date|null};
export function validateBanner(value:unknown):BannerInput{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new NewsError(400,'Banner inválido.');
  const b=value as Record<string,unknown>,keys=['name','altText','imageUrl','targetUrl','position','showInArticles','status','sortOrder','startsAt','endsAt'];
  if(Object.keys(b).some(k=>!keys.includes(k)))throw new NewsError(400,'Campo não permitido.');
  for(const [key,max]of [['name',160],['altText',300],['targetUrl',2048]] as const)if(typeof b[key]!=='string'||!b[key].trim()||b[key].length>max)throw new NewsError(400,`Campo ${key} inválido.`);
  if(typeof b.imageUrl!=='string'||!bannerPath.test(b.imageUrl))throw new NewsError(400,'Envie a imagem pelo painel.');
  const target=(b.targetUrl as string).trim();
  if(target.startsWith('/')){if(target.startsWith('//')||/[\s\\]/.test(target)||/%2f|%5c/i.test(target))throw new NewsError(400,'Link inválido.');}
  else{try{const u=new URL(target);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error();}catch{throw new NewsError(400,'Use um link HTTP/HTTPS válido.');}}
  if(!['header','in_article'].includes(String(b.position))||!['draft','active','paused','archived'].includes(String(b.status))||typeof b.showInArticles!=='boolean'||!Number.isInteger(b.sortOrder)||Number(b.sortOrder)<0||Number(b.sortOrder)>10000)throw new NewsError(400,'Posição, estado ou ordem inválidos.');
  const date=(value:unknown)=>{if(value==null||value==='')return null;if(typeof value!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw new NewsError(400,'Data inválida.');return new Date(value);};
  const startsAt=date(b.startsAt),endsAt=date(b.endsAt);if(startsAt&&endsAt&&endsAt<=startsAt)throw new NewsError(400,'O término deve ser posterior ao início.');
  return{name:(b.name as string).trim(),altText:(b.altText as string).trim(),targetUrl:target,imageUrl:b.imageUrl,position:b.position as BannerInput['position'],showInArticles:b.showInArticles,status:b.status as BannerInput['status'],sortOrder:Number(b.sortOrder),startsAt,endsAt};
}
export interface BannerStore{list():Promise<any[]>;save(id:string|undefined,input:BannerInput,actorId:string|null):Promise<any>;publicList():Promise<{header:any|null;inArticle:any|null}>;}
export function createBannerStore(pool:Pool):BannerStore{
 const db=drizzle(pool),key=(id:string)=>`banner.${id}.placements`;
 async function target(){if((await db.execute(sql`SELECT current_database() AS database`)).rows[0]?.database!=='informe67')throw Error('Destino inesperado.');}
 async function list(){await target();const rows=await db.select().from(s.banners).orderBy(s.banners.sortOrder,s.banners.createdAt);const settings=await db.select().from(s.portalSettings).where(sql`${s.portalSettings.key} LIKE 'banner.%.placements'`);return rows.map(b=>({...b,showInArticles:(settings.find(x=>x.key===key(b.id))?.value as any)?.showInArticles===true}));}
 return{list,async save(id,input,actorId){await target();try{await access(resolve(bannerDirectory,input.imageUrl.split('/').at(-1)!));}catch{throw new NewsError(400,'Imagem não encontrada. Envie novamente.');}return db.transaction(async tx=>{if(id){const [old]=await tx.select().from(s.banners).where(eq(s.banners.id,id)).for('update');if(!old)throw new NewsError(404,'Banner não encontrado.');}const{showInArticles,...fields}=input;const [saved]=id?await tx.update(s.banners).set(fields).where(eq(s.banners.id,id)).returning():await tx.insert(s.banners).values(fields).returning();await tx.insert(s.portalSettings).values({key:key(saved.id),value:{showInArticles},description:'Exibição do banner no meio das matérias',updatedBy:actorId}).onConflictDoUpdate({target:s.portalSettings.key,set:{value:{showInArticles},updatedBy:actorId,updatedAt:new Date()}});await tx.insert(s.auditLogs).values({actorId,action:id?'banners.edit':'banners.create',entityType:'banners',entityId:saved.id});return{...saved,showInArticles};});},async publicList(){const now=new Date();const active=(await list()).filter(b=>b.status==='active'&&(!b.startsAt||b.startsAt<=now)&&(!b.endsAt||b.endsAt>now));const view=(b:any)=>b?{id:b.id,imageUrl:b.imageUrl,altText:b.altText,targetUrl:b.targetUrl}:null;return{header:view(active.find(b=>b.position==='header')),inArticle:view(active.find(b=>b.position==='in_article'||(b.position==='header'&&b.showInArticles)))};}};
}
