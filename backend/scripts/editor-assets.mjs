import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const target = new URL('public/admin/vendor/', root);
await mkdir(target, { recursive: true });
for (const name of ['quill.js', 'quill.snow.css']) await copyFile(new URL(`node_modules/quill/dist/${name}`, root), new URL(name, target));
await copyFile(new URL('node_modules/quill/LICENSE', root), new URL('quill.LICENSE.txt', target));
console.info('Editor Quill preparado localmente.');
