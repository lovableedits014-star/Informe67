import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import type { AdminUser } from '../admin/store.js';
import type { RewriteService } from './service.js';

export async function rewriteRoutes(app:FastifyInstance,service:RewriteService,authorize:(request:FastifyRequest,reply:FastifyReply,permission:string,write:boolean)=>Promise<AdminUser|undefined>){
  app.get('/api/admin/settings/ai',async(request,reply)=>{if(await authorize(request,reply,'settings.read',false))return service.config();});
  app.put('/api/admin/settings/ai',{bodyLimit:8192},async(request,reply)=>{const actor=await authorize(request,reply,'settings.ai.manage',true);if(actor)return service.configure(request.body,actor.id);});
  app.post('/api/admin/settings/ai/test',{config:{rateLimit:{max:3,timeWindow:'1 hour'}}},async(request,reply)=>{if(await authorize(request,reply,'settings.ai.manage',true))return service.test();});
  app.get('/api/admin/news/rewrite',async(request,reply)=>{if(await authorize(request,reply,'news.rewrite',false))return{items:await service.list()};});
  app.get<{Params:{id:string}}>('/api/admin/news/rewrite/:id',async(request,reply)=>{if(await authorize(request,reply,'news.rewrite',false))return service.get(request.params.id);});
  app.post('/api/admin/news/rewrite',{bodyLimit:4096,config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(request,reply)=>{const actor=await authorize(request,reply,'news.rewrite',true);if(actor){const result=await service.create(request.body,actor.id);return reply.code(result.duplicate?200:202).send(result);}});
  app.put<{Params:{id:string}}>('/api/admin/news/rewrite/:id/source',{bodyLimit:260000},async(request,reply)=>{const actor=await authorize(request,reply,'news.rewrite',true);if(actor)return service.manual(request.params.id,request.body,actor.id);});
  app.post<{Params:{id:string}}>('/api/admin/news/rewrite/:id/generate',{bodyLimit:1024,config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{const actor=await authorize(request,reply,'news.rewrite',true);if(actor)return reply.code(202).send(await service.generate(request.params.id,request.body,actor.id));});
  app.post<{Params:{id:string}}>('/api/admin/news/rewrite/:id/image',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{const actor=await authorize(request,reply,'news.rewrite',true);if(actor)return service.retryImage(request.params.id,actor.id);});
}
