// Builds the deployable site into dist/: one bundled script (app code plus
// the Anthropic SDK), the stylesheet, and the Leaflet map library. Asset
// links carry a content hash so browsers never mix old and new files.
// Run automatically by `npm start` and by the deploy.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'public');
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'vendor'), { recursive: true });
await cp(path.join(root, 'node_modules', 'leaflet', 'dist'), path.join(dist, 'vendor', 'leaflet'), {
  recursive: true,
});
await cp(path.join(src, 'styles.css'), path.join(dist, 'styles.css'));
await build({
  entryPoints: [path.join(src, 'app.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  outfile: path.join(dist, 'app.js'),
  logLevel: 'warning',
});

const hash = createHash('sha256');
for (const file of ['app.js', 'styles.css']) hash.update(await readFile(path.join(dist, file)));
const version = hash.digest('hex').slice(0, 10);
const html = (await readFile(path.join(src, 'index.html'), 'utf8'))
  .replace('href="styles.css"', `href="styles.css?v=${version}"`)
  .replace('src="app.js"', `src="app.js?v=${version}"`);
if (!html.includes(`app.js?v=${version}`) || !html.includes(`styles.css?v=${version}`)) {
  throw new Error('index.html no longer references app.js and styles.css as expected');
}
await writeFile(path.join(dist, 'index.html'), html);
console.log(`Built dist/ (version ${version})`);
