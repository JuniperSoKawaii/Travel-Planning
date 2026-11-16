// The actions Claude can take on a trip: tool definitions, input validation
// and the code that carries each action out. No network or SDK code here, so
// it can be unit-tested in Node.

import { findConflicts, hasCoords, sortStops, toMinutes } from './conflicts.js';
import { CATEGORIES } from './suggestions.js';

const stopFields = {
  name: { type: 'string', description: 'Short name of the place or activity.' },
  address: {
    type: 'string',
    description:
      'Address or place name that a map search can find, including the city, e.g. "Louvre Museum, Paris". Leave out for things with no fixed location.',
  },
  date: { type: 'string', description: 'Day of the stop as YYYY-MM-DD.' },
  start: { type: 'string', description: 'Start time as 24-hour HH:MM.' },
  end: { type: 'string', description: 'End time as 24-hour HH:MM, after the start, same day.' },
  notes: { type: 'string', description: 'Optional notes: bookings, tips, reminders.' },
  lat: {
    type: 'number',
    description: 'Latitude. Only pass coordinates that find_nearby returned; otherwise give an address.',
  },
  lon: { type: 'number', description: 'Longitude. Same rule as lat.' },
};

// eager_input_streaming is on because requests are streamed; the API then no
// longer validates tool inputs, so validateInput() below does.
export const TOOLS = [
  {
    name: 'get_trip',
    description:
      'Read the current trip: every stop with its id, plus the schedule conflicts. Call this when you need fresh state after making several changes.',
    eager_input_streaming: true,
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add_stop',
    description:
      'Add a stop to the itinerary. The address is looked up and pinned on the map. The result lists any conflicts the new stop causes, so check it and adjust.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: stopFields,
      required: ['name', 'date', 'start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_stop',
    description:
      'Change an existing stop. Pass its id and only the fields to change. The result lists any conflicts the stop is now part of.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Id of the stop to change.' }, ...stopFields },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_stop',
    description: 'Delete a stop from the itinerary.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Id of the stop to delete.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_nearby',
    description:
      'Search OpenStreetMap for places near an existing stop that is on the map. Returns names, kinds, distances, coordinates and opening hours where known.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        stop_id: { type: 'string', description: 'Id of the stop to search around.' },
        category: { type: 'string', enum: Object.keys(CATEGORIES) },
        radius_m: { type: 'integer', description: 'Search radius in metres, 100 to 10000. Default 1000.' },
      },
      required: ['stop_id', 'category'],
      additionalProperties: false,
    },
  },
];

// ---- Validation -------------------------------------------------------------

const isDate = (v) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isText = (max) => (v) => typeof v === 'string' && v.length <= max;

const CHECKS = {
  id: [(v) => typeof v === 'string' && v.length > 0 && v.length <= 64, 'a stop id'],
  stop_id: [(v) => typeof v === 'string' && v.length > 0 && v.length <= 64, 'a stop id'],
  name: [(v) => isText(200)(v) && v.trim().length > 0, 'a non-empty string'],
  address: [isText(300), 'a string'],
  notes: [isText(2000), 'a string'],
  date: [isDate, 'a date as YYYY-MM-DD'],
  start: [isTime, 'a time as HH:MM'],
  end: [isTime, 'a time as HH:MM'],
  lat: [(v) => Number.isFinite(v) && Math.abs(v) <= 90, 'a latitude'],
  lon: [(v) => Number.isFinite(v) && Math.abs(v) <= 180, 'a longitude'],
  category: [(v) => Object.hasOwn(CATEGORIES, v), `one of ${Object.keys(CATEGORIES).join(', ')}`],
  radius_m: [(v) => Number.isInteger(v) && v >= 100 && v <= 10000, 'an integer from 100 to 10000'],
};

// Returns a description of what is wrong with a tool input, or null if it
// matches the tool's schema.
export function validateInput(name, input) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `Unknown tool "${name}"`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Input must be an object';
  const { properties, required = [] } = tool.input_schema;
  for (const key of required) {
    if (!(key in input)) return `Missing required field "${key}"`;
  }
  for (const [key, value] of Object.entries(input)) {
    if (!(key in properties)) return `Unexpected field "${key}"`;
    const [check, expected] = CHECKS[key];
    if (!check(value)) return `Field "${key}" must be ${expected}`;
  }
  if (('lat' in input) !== ('lon' in input)) return 'Pass lat and lon together';
  return null;
}

// ---- Execution --------------------------------------------------------------

const describeStop = (s) => ({
  id: s.id,
  name: s.name,
  address: s.address || '',
  date: s.date,
  start: s.start,
  end: s.end,
  notes: s.notes || '',
  on_map: hasCoords(s),
});

export function describeTrip(trip) {
  return {
    name: trip.name,
    stops: sortStops(trip.stops).map(describeStop),
    conflicts: findConflicts(trip.stops).map((c) => c.message),
  };
}

const conflictsFor = (trip, id) =>
  findConflicts(trip.stops)
    .filter((c) => c.stopIds.includes(id))
    .map((c) => c.message);

const fail = (message) => ({ isError: true, changed: false, summary: '', result: { error: message } });

async function locate(address, services) {
  try {
    const results = await services.geocode(address);
    return results.length ? { lat: results[0].lat, lon: results[0].lon } : null;
  } catch {
    return null;
  }
}

// Carries out one validated tool call against `trip` (mutated in place).
// services: { geocode(address), findSuggestions({lat, lon, radius, category}), newId() }
// Returns { result, isError, changed, summary } where summary is a short
// human-readable line for the chat panel.
export async function executeTool(name, input, trip, services) {
  if (name === 'get_trip') {
    return { isError: false, changed: false, summary: '', result: describeTrip(trip) };
  }

  if (name === 'add_stop' || name === 'update_stop') {
    const existing = name === 'update_stop' ? trip.stops.find((s) => s.id === input.id) : null;
    if (name === 'update_stop' && !existing) return fail(`No stop with id "${input.id}"`);

    const stop = {
      id: existing?.id ?? services.newId(),
      name: (input.name ?? existing?.name).trim(),
      address: (input.address ?? existing?.address ?? '').trim(),
      date: input.date ?? existing?.date,
      start: input.start ?? existing?.start,
      end: input.end ?? existing?.end,
      notes: (input.notes ?? existing?.notes ?? '').trim(),
      lat: existing?.lat ?? null,
      lon: existing?.lon ?? null,
    };
    if (toMinutes(stop.end) <= toMinutes(stop.start)) {
      return fail(`End time ${stop.end} must be after start time ${stop.start}`);
    }

    let note;
    const addressChanged = 'address' in input && stop.address !== (existing?.address ?? '');
    if ('lat' in input) {
      stop.lat = input.lat;
      stop.lon = input.lon;
    } else if (addressChanged || (!existing && stop.address)) {
      const found = stop.address ? await locate(stop.address, services) : null;
      stop.lat = found?.lat ?? null;
      stop.lon = found?.lon ?? null;
      if (stop.address && !found) {
        note =
          'The address could not be found, so the stop is not on the map. Try update_stop with a simpler address such as "Place name, City".';
      }
    }

    if (existing) trip.stops[trip.stops.indexOf(existing)] = stop;
    else trip.stops.push(stop);

    return {
      isError: false,
      changed: true,
      summary: `${existing ? 'Updated' : 'Added'} ${stop.name} · ${stop.date} ${stop.start}–${stop.end}`,
      result: { stop: describeStop(stop), conflicts: conflictsFor(trip, stop.id), ...(note && { note }) },
    };
  }

  if (name === 'remove_stop') {
    const stop = trip.stops.find((s) => s.id === input.id);
    if (!stop) return fail(`No stop with id "${input.id}"`);
    trip.stops = trip.stops.filter((s) => s.id !== input.id);
    return { isError: false, changed: true, summary: `Removed ${stop.name}`, result: { removed: stop.id } };
  }

  if (name === 'find_nearby') {
    const stop = trip.stops.find((s) => s.id === input.stop_id);
    if (!stop) return fail(`No stop with id "${input.stop_id}"`);
    if (!hasCoords(stop)) return fail(`"${stop.name}" is not on the map, so there is nothing to search around`);
    try {
      const places = await services.findSuggestions({
        lat: stop.lat,
        lon: stop.lon,
        radius: input.radius_m ?? 1000,
        category: input.category,
      });
      return {
        isError: false,
        changed: false,
        summary: `Searched ${CATEGORIES[input.category].label.toLowerCase()} near ${stop.name}`,
        result: {
          places: places.slice(0, 15).map((p) => ({
            name: p.name,
            kind: p.kind,
            address: p.address,
            distance_km: p.distanceKm,
            lat: p.lat,
            lon: p.lon,
            opening_hours: p.openingHours,
            well_known: p.notable,
          })),
        },
      };
    } catch (err) {
      return fail(err.message);
    }
  }

  return fail(`Unknown tool "${name}"`);
}
