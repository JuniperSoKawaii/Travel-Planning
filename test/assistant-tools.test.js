import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOLS, describeTrip, executeTool, validateInput } from '../public/assistant-tools.js';

const places = { 'Louvre Museum, Paris': { lat: 48.8606, lon: 2.3376 }, 'Versailles': { lat: 48.8049, lon: 2.1204 } };
let nextId = 0;
const services = {
  newId: () => `s${++nextId}`,
  geocode: async (address) => (places[address] ? [places[address]] : []),
  findSuggestions: async () => [
    { name: 'Café A', kind: 'cafe', address: '', distanceKm: 0.2, lat: 48.861, lon: 2.338, openingHours: '', notable: false },
  ],
};
const newTrip = () => ({ id: 't', name: 'Paris', stops: [] });

test('every tool has a schema and validation rejects malformed input', () => {
  for (const tool of TOOLS) assert.equal(tool.input_schema.type, 'object');
  const ok = { name: 'Louvre', date: '2026-12-05', start: '10:00', end: '12:00' };
  assert.equal(validateInput('add_stop', ok), null);
  assert.match(validateInput('add_stop', { ...ok, end: undefined }), /end/);
  assert.match(validateInput('add_stop', { name: 'x', date: '2026-12-05', start: '10:00' }), /Missing required field "end"/);
  assert.match(validateInput('add_stop', { ...ok, start: '25:00' }), /start/);
  assert.match(validateInput('add_stop', { ...ok, date: '5 Dec' }), /date/);
  assert.match(validateInput('add_stop', { ...ok, extra: 1 }), /Unexpected field/);
  assert.match(validateInput('add_stop', { ...ok, lat: 48 }), /lat and lon together/);
  assert.match(validateInput('add_stop', { ...ok, lat: 480, lon: 2 }), /lat/);
  assert.match(validateInput('add_stop', 'nope'), /object/);
  assert.match(validateInput('find_nearby', { stop_id: 's1', category: 'casinos' }), /category/);
  assert.match(validateInput('drop_database', {}), /Unknown tool/);
  assert.equal(validateInput('get_trip', {}), null);
});

test('add_stop geocodes the address and reports conflicts it causes', async () => {
  const trip = newTrip();
  const first = await executeTool('add_stop', { name: 'Louvre', address: 'Louvre Museum, Paris', date: '2026-12-05', start: '10:00', end: '12:00' }, trip, services);
  assert.equal(first.changed, true);
  assert.equal(first.result.stop.on_map, true);
  assert.deepEqual(first.result.conflicts, []);

  const second = await executeTool('add_stop', { name: 'Versailles', address: 'Versailles', date: '2026-12-05', start: '11:30', end: '14:00' }, trip, services);
  assert.equal(second.result.conflicts.length, 1);
  assert.match(second.result.conflicts[0], /overlaps/);
  assert.equal(describeTrip(trip).stops.length, 2);
});

test('an address that cannot be found still adds the stop, with a note', async () => {
  const trip = newTrip();
  const out = await executeTool('add_stop', { name: 'Mystery', address: 'Nowhere 123', date: '2026-12-05', start: '10:00', end: '11:00' }, trip, services);
  assert.equal(out.isError, false);
  assert.equal(out.result.stop.on_map, false);
  assert.match(out.result.note, /could not be found/);
});

test('update_stop changes only the given fields and keeps the map pin', async () => {
  const trip = newTrip();
  const { result } = await executeTool('add_stop', { name: 'Louvre', address: 'Louvre Museum, Paris', date: '2026-12-05', start: '10:00', end: '12:00', notes: 'Book ahead' }, trip, services);
  const out = await executeTool('update_stop', { id: result.stop.id, start: '13:00', end: '15:00' }, trip, services);
  assert.equal(out.isError, false);
  assert.deepEqual(
    { ...trip.stops[0] },
    { id: result.stop.id, name: 'Louvre', address: 'Louvre Museum, Paris', date: '2026-12-05', start: '13:00', end: '15:00', notes: 'Book ahead', lat: 48.8606, lon: 2.3376 }
  );
});

test('bad edits are refused without changing the trip', async () => {
  const trip = newTrip();
  const { result } = await executeTool('add_stop', { name: 'Louvre', date: '2026-12-05', start: '10:00', end: '12:00' }, trip, services);
  const snapshot = JSON.stringify(trip);

  const backwards = await executeTool('update_stop', { id: result.stop.id, end: '09:00' }, trip, services);
  assert.equal(backwards.isError, true);
  const missing = await executeTool('update_stop', { id: 'nope', name: 'x' }, trip, services);
  assert.equal(missing.isError, true);
  const gone = await executeTool('remove_stop', { id: 'nope' }, trip, services);
  assert.equal(gone.isError, true);
  const unpinned = await executeTool('find_nearby', { stop_id: result.stop.id, category: 'cafes' }, trip, services);
  assert.equal(unpinned.isError, true);
  assert.equal(JSON.stringify(trip), snapshot);
});

test('remove_stop and find_nearby', async () => {
  const trip = newTrip();
  const { result } = await executeTool('add_stop', { name: 'Louvre', address: 'Louvre Museum, Paris', date: '2026-12-05', start: '10:00', end: '12:00' }, trip, services);
  const nearby = await executeTool('find_nearby', { stop_id: result.stop.id, category: 'cafes' }, trip, services);
  assert.equal(nearby.result.places[0].name, 'Café A');
  assert.equal(nearby.changed, false);

  const withCoords = await executeTool('add_stop', { name: 'Café A', date: '2026-12-05', start: '12:15', end: '13:00', lat: 48.861, lon: 2.338 }, trip, services);
  assert.equal(withCoords.result.stop.on_map, true);

  const removed = await executeTool('remove_stop', { id: result.stop.id }, trip, services);
  assert.equal(removed.changed, true);
  assert.equal(trip.stops.length, 1);
});
