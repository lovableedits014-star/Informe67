import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const target = new URL('public/admin/vendor/', root);
await mkdir(target, { recursive: true });
for (const name of ['quill.js', 'quill.snow.css']) await copyFile(new URL(`node_modules/quill/dist/${name}`, root), new URL(name, target));
await copyFile(new URL('node_modules/quill/LICENSE', root), new URL('quill.LICENSE.txt', target));
// A new URL for changed assets prevents an older open panel from reusing cached JS.
const index = new URL('public/admin/index.html', root);
let html = await readFile(index, 'utf8');
const assetPattern = /(?:src|href)="(\/admin\/[^"?]+\.(?:js|css))(?:\?v=[^\"]*)?"/g;
for (const path of new Set([...html.matchAll(assetPattern)].map(match => match[1]))) {
  const bytes = await readFile(new URL(`public${path}`, root));
  const version = createHash('sha256').update(bytes).digest('hex').slice(0,12);
  html = html.replaceAll(new RegExp(`(src|href)="${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\?v=[^"]*)?"`, 'g'), `$1="${path}?v=${version}"`);
}
await writeFile(index, html, 'utf8');
console.info('Editor Quill preparado localmente.');
