import { copyFile, mkdir, readdir, rm, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';

const backend = resolve(fileURLToPath(new URL('../', import.meta.url)));
const source = resolve(backend, '..');
const destination = resolve(backend, 'public', 'site');
const files = ['index.html', 'noticia.html', 'styles.css', 'script.js', 'noticia.js', 'public-api.js'];
const extensions = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.css', '.js', '.json', '.mp4', '.webm', '.mp3', '.ogg']);

// Validate sources before replacing only this generated, non-persistent directory.
for (const name of files) {
  if (!(await lstat(resolve(source, name))).isFile()) throw new Error(`Arquivo público ausente ou inválido: ${name}. Use a raiz do repositório como contexto de build.`);
}
if (!(await lstat(resolve(source, 'assets'))).isDirectory()) throw new Error('Diretório público assets ausente.');
if (destination !== resolve(backend, 'public/site') || !destination.startsWith(backend + sep)) throw new Error('Destino do site fora do backend.');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const name of files) await copyFile(resolve(source, name), resolve(destination, name));
async function copyAssets(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await copyAssets(resolve(from, entry.name), resolve(to, entry.name));
    else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) await copyFile(resolve(from, entry.name), resolve(to, entry.name));
  }
}
await copyAssets(resolve(source, 'assets'), resolve(destination, 'assets'));
console.info('Site público preparado em public/site.');
