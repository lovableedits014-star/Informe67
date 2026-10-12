import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const files = new Set(['index.html', 'noticia.html', 'styles.css', 'script.js', 'noticia.js', 'public-api.js']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const port = Number(process.env.FRONTEND_PORT ?? 5500);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FRONTEND_PORT inválida.');
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  try {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1) || 'index.html';
    const path = resolve(root, name);
    const asset = name.startsWith('assets/') && path.startsWith(resolve(root, 'assets') + sep) && Object.hasOwn(types, extname(path).toLowerCase());
    if (!files.has(name) && !asset) { response.writeHead(404); response.end(); return; }
    const body = await readFile(path);
    response.writeHead(200, { 'Content-Type': types[extname(path).toLowerCase()], 'Content-Length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(404); response.end(); }
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `A porta ${port} já está em uso.` : 'Não foi possível iniciar o site local.'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.info(`Site Informe67: http://127.0.0.1:${port}/index.html\nMantenha este processo ativo enquanto visualizar o site.`));
