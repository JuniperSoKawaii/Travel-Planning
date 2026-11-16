import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assignLanes,
  estimateTravelMinutes,
  findConflicts,
  findFreeSlot,
  haversineKm,
} from '../public/conflicts.js';
import { buildOverpassQuery, parseOverpass } from '../lib/suggestions.js';

const stop = (id, start, end, extra = {}) => ({
  id,
  name: id,
  date: '2026-12-01',
  start,
  end,
  ...extra,
});

test('overlapping stops on the same day are flagged', () => {
  const conflicts = findConflicts([stop('a', '10:00', '12:00'), stop('b', '11:30', '13:00')]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, 'overlap');
  assert.deepEqual(conflicts[0].stopIds, ['a', 'b']);
});

test('back-to-back stops and stops on different days do not conflict', () => {
  const conflicts = findConflicts([
    stop('a', '10:00', '12:00'),
    stop('b', '12:00', '13:00'),
    stop('c', '10:00', '12:00', { date: '2026-12-02' }),
  ]);
  assert.deepEqual(conflicts, []);
});

test('one long stop is reported against every stop it overlaps', () => {
  const conflicts = findConflicts([
    stop('long', '09:00', '17:00'),
    stop('b', '10:00', '11:00'),
    stop('c', '13:00', '14:00'),
  ]);
  assert.deepEqual(
    conflicts.map((c) => c.stopIds),
    [
      ['long', 'b'],
      ['long', 'c'],
    ]
  );
});

test('too little travel time between distant stops is flagged', () => {
  const louvre = { lat: 48.8606, lon: 2.3376 };
  const versailles = { lat: 48.8049, lon: 2.1204 };
  const tight = findConflicts([
    stop('a', '10:00', '12:00', louvre),
    stop('b', '12:10', '14:00', versailles),
  ]);
  assert.equal(tight.length, 1);
  assert.equal(tight[0].type, 'travel');

  const relaxed = findConflicts([
    stop('a', '10:00', '12:00', louvre),
    stop('b', '13:30', '15:00', versailles),
  ]);
  assert.deepEqual(relaxed, []);
});

test('travel check is skipped when a stop has no map location', () => {
  const conflicts = findConflicts([
    stop('a', '10:00', '12:00', { lat: 48.86, lon: 2.33 }),
    stop('b', '12:00', '13:00'),
  ]);
  assert.deepEqual(conflicts, []);
});

test('haversine and travel estimates are in a sensible range', () => {
  const km = haversineKm({ lat: 48.8606, lon: 2.3376 }, { lat: 48.8584, lon: 2.2945 });
  assert.ok(km > 3 && km < 3.5, `Louvre to Eiffel Tower was ${km} km`);
  assert.equal(estimateTravelMinutes(0), 0);
  assert.ok(estimateTravelMinutes(0.5) < 15);
  assert.ok(estimateTravelMinutes(10) > 20);
});

test('findFreeSlot returns the first gap that fits', () => {
  const stops = [stop('a', '09:00', '10:30'), stop('b', '11:00', '13:00')];
  assert.deepEqual(findFreeSlot(stops, '2026-12-01', 60), { start: '13:00', end: '14:00' });
  assert.deepEqual(findFreeSlot(stops, '2026-12-01', 30), { start: '10:30', end: '11:00' });
  assert.deepEqual(findFreeSlot(stops, '2026-12-02', 60), { start: '09:00', end: '10:00' });
  assert.equal(findFreeSlot([stop('all', '09:00', '21:00')], '2026-12-01', 60), null);
});

test('assignLanes puts overlapping stops side by side', () => {
  const layout = assignLanes([
    stop('a', '10:00', '12:00'),
    stop('b', '11:00', '13:00'),
    stop('c', '12:30', '14:00'),
    stop('d', '15:00', '16:00'),
  ]);
  assert.deepEqual(layout.get('a'), { lane: 0, lanes: 2 });
  assert.deepEqual(layout.get('b'), { lane: 1, lanes: 2 });
  assert.deepEqual(layout.get('c'), { lane: 0, lanes: 2 });
  assert.deepEqual(layout.get('d'), { lane: 0, lanes: 1 });
});

test('Overpass query and parsing', () => {
  const query = buildOverpassQuery({ lat: 48.86, lon: 2.33, radius: 1000, category: 'museums' });
  assert.match(query, /nwr\(around:1000,48\.86,2\.33\)\["tourism"~"\^\(museum\|gallery\)\$"\]\["name"\];/);

  const places = parseOverpass(
    {
      elements: [
        { type: 'node', id: 1, lat: 48.87, lon: 2.33, tags: { name: 'Far Museum', tourism: 'museum' } },
        { type: 'node', id: 2, lat: 48.861, lon: 2.33, tags: { name: 'Near Gallery', tourism: 'gallery' } },
        { type: 'way', id: 3, center: { lat: 48.88, lon: 2.33 }, tags: { name: 'Famous Museum', tourism: 'museum', wikidata: 'Q1' } },
        { type: 'node', id: 4, lat: 48.86, lon: 2.33, tags: { tourism: 'museum' } },
        { type: 'node', id: 5, lat: 48.862, lon: 2.33, tags: { name: 'near gallery', tourism: 'gallery' } },
      ],
    },
    { lat: 48.86, lon: 2.33 }
  );
  assert.deepEqual(
    places.map((p) => p.name),
    ['Famous Museum', 'Near Gallery', 'Far Museum']
  );
  assert.equal(places[0].id, 'way/3');
});
