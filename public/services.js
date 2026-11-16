// Calls the free OpenStreetMap services directly from the browser.

import { buildOverpassQuery, parseOverpass } from './suggestions.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// Public Overpass servers are often busy, so each one is tried in turn.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const geocodeCache = new Map();
let geocodeQueue = Promise.resolve();
let lastGeocodeAt = 0;

// Address -> [{ label, lat, lon }]. Requests run one at a time and at most
// once per second, which is Nominatim's usage limit.
export function geocode(address) {
  const key = address.trim().toLowerCase();
  if (geocodeCache.has(key)) return Promise.resolve(geocodeCache.get(key));
  const run = geocodeQueue.then(async () => {
    const wait = lastGeocodeAt + 1000 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastGeocodeAt = Date.now();
    let response;
    try {
      response = await fetch(`${NOMINATIM_URL}?format=jsonv2&limit=5&q=${encodeURIComponent(address)}`);
    } catch {
      throw new Error('Address lookup failed. Check your internet connection and try again.');
    }
    if (!response.ok) throw new Error(`Address lookup failed (service returned ${response.status}).`);
    const results = (await response.json()).map((r) => ({
      label: r.display_name,
      lat: Number(r.lat),
      lon: Number(r.lon),
    }));
    geocodeCache.set(key, results);
    return results;
  });
  geocodeQueue = run.catch(() => {});
  return run;
}

export async function findSuggestions({ lat, lon, radius, category }) {
  const body = new URLSearchParams({ data: buildOverpassQuery({ lat, lon, radius, category }) });
  for (const url of OVERPASS_URLS) {
    try {
      const response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(30000) });
      if (!response.ok) continue;
      return parseOverpass(await response.json(), { lat, lon });
    } catch {
      // Try the next server.
    }
  }
  throw new Error('Suggestion search failed. The places service may be busy, so try again in a moment.');
}
