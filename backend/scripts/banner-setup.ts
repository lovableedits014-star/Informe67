import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {loadBackendEnvironment} from '../src/config/environment.js';
import {readMigrationConfig} from '../src/db/migration-config.js';
import {createBannerStore,uploadBanner} from '../src/admin/banners.js';
loadBackendEnvironment(import.meta.url);const pool=new Pool({...readMigrationConfig(process.env),max:1});
try{
 if((await pool.query('SELECT current_database() AS database')).rows[0].database!=='informe67')throw Error('Destino inesperado.');
 const client=await pool.connect();try{await client.query('BEGIN');const role=(await client.query('SELECT id FROM roles WHERE name=$1',['administrator'])).rows[0];if(!role)throw Error('Administrador ausente.');await client.query("INSERT INTO permissions(code) VALUES('banners.manage') ON CONFLICT DO NOTHING");await client.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code='banners.manage' ON CONFLICT DO NOTHING",[role.id]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 const store=createBannerStore(pool);if(!(await store.list()).length){const image=await uploadBanner(await readFile(new URL('../../assets/ads/banner-mensal.gif',import.meta.url)));await store.save(undefined,{name:'Banner principal',altText:'Anúncio: abrir uma garrafa de água é fácil.',targetUrl:'/',imageUrl:image.imageUrl,position:'header',showInArticles:true,status:'active',sortOrder:0,startsAt:null,endsAt:null},null);}
 console.info('Banner atual disponível no painel, no hero e no meio das matérias. Configure o link do anunciante no painel.');
}finally{await pool.end();}
