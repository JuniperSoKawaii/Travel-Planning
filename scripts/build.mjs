// Prepares public/vendor/: the Leaflet map library and a browser bundle of
// the Anthropic SDK. Run automatically by `npm start` and by the deploy.

import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'public', 'vendor');

await rm(vendor, { recursive: true, force: true });
await mkdir(vendor, { recursive: true });
await cp(path.join(root, 'node_modules', 'leaflet', 'dist'), path.join(vendor, 'leaflet'), {
  recursive: true,
});
await build({
  stdin: {
    contents: "export { default } from '@anthropic-ai/sdk';",
    resolveDir: root,
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  outfile: path.join(vendor, 'anthropic.js'),
  logLevel: 'warning',
});
console.log('Built public/vendor');
