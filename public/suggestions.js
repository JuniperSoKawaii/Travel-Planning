// Builds OpenStreetMap Overpass queries for "things to do nearby" and turns
// the raw response into a short, ranked list.

import { haversineKm } from './conflicts.js';

export const CATEGORIES = {
  sights: {
    label: 'Sights & landmarks',
    filters: ['["tourism"~"^(attraction|viewpoint|artwork)$"]', '["historic"]'],
  },
  museums: {
    label: 'Museums & galleries',
    filters: ['["tourism"~"^(museum|gallery)$"]'],
  },
  food: {
    label: 'Restaurants',
    filters: ['["amenity"="restaurant"]'],
  },
  cafes: {
    label: 'Cafés & bakeries',
    filters: ['["amenity"="cafe"]', '["shop"="bakery"]'],
  },
  parks: {
    label: 'Parks & gardens',
    filters: ['["leisure"~"^(park|garden|nature_reserve)$"]'],
  },
  nightlife: {
    label: 'Bars & nightlife',
    filters: ['["amenity"~"^(bar|pub|nightclub)$"]'],
  },
  shopping: {
    label: 'Shopping & markets',
    filters: ['["shop"~"^(mall|department_store|books|gift)$"]', '["amenity"="marketplace"]'],
  },
};

export function buildOverpassQuery({ lat, lon, radius, category }) {
  const { filters } = CATEGORIES[category];
  const lines = filters.map((f) => `  nwr(around:${radius},${lat},${lon})${f}["name"];`);
  return `[out:json][timeout:25];\n(\n${lines.join('\n')}\n);\nout center tags 200;`;
}

function describeKind(tags) {
  const raw =
    tags.tourism || tags.amenity || tags.leisure || tags.shop || tags.historic || 'place';
  const kind = raw === 'yes' ? 'historic site' : raw.replace(/_/g, ' ');
  return tags.cuisine ? `${kind} · ${tags.cuisine.split(';')[0].replace(/_/g, ' ')}` : kind;
}

function describeAddress(tags) {
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  return [street, tags['addr:city']].filter(Boolean).join(', ');
}

export function parseOverpass(data, origin, limit = 30) {
  const seen = new Set();
  const places = [];
  for (const el of data?.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const tags = el.tags ?? {};
    if (!tags.name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = tags.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({
      id: `${el.type}/${el.id}`,
      name: tags['name:en'] || tags.name,
      kind: describeKind(tags),
      lat,
      lon,
      address: describeAddress(tags),
      website: tags.website || tags['contact:website'] || '',
      openingHours: tags.opening_hours || '',
      // Places with a Wikipedia/Wikidata entry are usually the notable ones.
      notable: Boolean(tags.wikipedia || tags.wikidata),
      distanceKm: Number(haversineKm(origin, { lat, lon }).toFixed(2)),
    });
  }
  places.sort((a, b) => Number(b.notable) - Number(a.notable) || a.distanceKm - b.distanceKm);
  return places.slice(0, limit);
}
