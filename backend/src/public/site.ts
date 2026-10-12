import type { FastifyInstance } from 'fastify';
import staticFiles from '@fastify/static';
import { fileURLToPath } from 'node:url';

export async function publicSiteRoutes(app: FastifyInstance) {
  // Serve only the frontend bundle, never the repository or backend directory.
  const root = fileURLToPath(new URL('../../public/site/', import.meta.url));
  await app.register(staticFiles, {
    root,
    prefix: '/',
    index: 'index.html',
    dotfiles: 'deny',
    cacheControl: false,
    setHeaders(response) {
      response.header('X-Content-Type-Options', 'nosniff');
      response.header('Cache-Control', 'no-cache');
    },
  });
}
