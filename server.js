import express from 'express';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, buildOverpassQuery, parseOverpass } from './lib/suggestions.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'trips.json');
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
// Public Overpass servers are often busy, so each one is tried in turn.
const OVERPASS_URLS = (
  process.env.OVERPASS_URL ||
  'https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter'
).split(',');
const USER_AGENT = 'travel-planning-app/1.0 (personal trip planner)';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules', 'leaflet', 'dist')));

// ---- Saved trips (one JSON file on disk) ----------------------------------

async function loadState() {
  try {
    return JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { trips: [], activeTripId: null };
    throw err;
  }
}

async function saveState(state) {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, DATA_FILE);
}

app.get('/api/state', async (req, res, next) => {
  try {
    res.json(await loadState());
  } catch (err) {
    next(err);
  }
});

app.put('/api/state', async (req, res, next) => {
  try {
    const state = req.body;
    if (!state || !Array.isArray(state.trips)) {
      return res.status(400).json({ error: 'Expected { trips: [...] }' });
    }
    await saveState(state);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- Address lookup (OpenStreetMap Nominatim) -----------------------------

const geocodeCache = new Map();
let nominatimQueue = Promise.resolve();

// Nominatim's usage policy allows at most one request per second.
function throttledNominatim(url) {
  const run = nominatimQueue.then(async () => {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return response;
  });
  nominatimQueue = run.catch(() => {});
  return run;
}

app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing address' });
  const key = q.toLowerCase();
  if (geocodeCache.has(key)) return res.json({ results: geocodeCache.get(key) });
  try {
    const url = `${NOMINATIM_URL}/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
    const response = await throttledNominatim(url);
    if (!response.ok) throw new Error(`Address service returned ${response.status}`);
    const results = (await response.json()).map((r) => ({
      label: r.display_name,
      lat: Number(r.lat),
      lon: Number(r.lon),
    }));
    geocodeCache.set(key, results);
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: `Address lookup failed: ${err.message}` });
  }
});

// ---- Nearby suggestions (OpenStreetMap Overpass) --------------------------

app.get('/api/categories', (req, res) => {
  res.json(Object.entries(CATEGORIES).map(([id, { label }]) => ({ id, label })));
});

app.get('/api/suggestions', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Math.min(Math.max(Number(req.query.radius) || 1000, 100), 10000);
  const category = String(req.query.category || 'sights');
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !CATEGORIES[category]) {
    return res.status(400).json({ error: 'Expected lat, lon and a known category' });
  }
  const body = `data=${encodeURIComponent(buildOverpassQuery({ lat, lon, radius, category }))}`;
  let lastError;
  for (const url of OVERPASS_URLS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`places service returned ${response.status}`);
      return res.json({ results: parseOverpass(await response.json(), { lat, lon }) });
    } catch (err) {
      lastError = err;
    }
  }
  res.status(502).json({
    error: `Suggestion search failed (${lastError.message}). The places service may be busy, so try again in a moment.`,
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(PORT, () => {
  console.log(`Travel Planning is running at http://localhost:${PORT}`);
});
