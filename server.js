// Local preview server. The app itself runs entirely in the browser, so this
// only serves the static files in public/ (run `npm run build` first).

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.static(path.join(ROOT, 'public')));

app.listen(PORT, () => {
  console.log(`Travel Planning is running at http://localhost:${PORT}`);
});
