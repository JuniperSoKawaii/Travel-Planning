// Pure scheduling logic shared by the browser UI and the Node tests.

export function toMinutes(time) {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function hasCoords(stop) {
  return Number.isFinite(stop?.lat) && Number.isFinite(stop?.lon);
}

export function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Rough door-to-door estimate from straight-line distance. Roads are never
// straight, so distance is padded by 30%; short hops are walked, longer ones
// driven with a few minutes of overhead.
export function estimateTravelMinutes(straightKm) {
  const km = straightKm * 1.3;
  if (km < 0.1) return 0;
  if (km <= 1.5) return Math.ceil((km / 4.5) * 60);
  if (km <= 80) return Math.ceil((km / 25) * 60 + 5);
  return Math.ceil((km / 80) * 60 + 15);
}

export function sortStops(stops) {
  return [...stops].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      toMinutes(a.start) - toMinutes(b.start) ||
      toMinutes(a.end) - toMinutes(b.end)
  );
}

function groupByDate(stops) {
  const days = new Map();
  for (const stop of sortStops(stops)) {
    if (!days.has(stop.date)) days.set(stop.date, []);
    days.get(stop.date).push(stop);
  }
  return days;
}

// Returns a list of { type, date, stopIds, message }.
//   overlap – two stops on the same day whose times intersect
//   travel  – back-to-back stops with too little time to get between them
export function findConflicts(stops) {
  const conflicts = [];
  for (const [date, day] of groupByDate(stops)) {
    for (let i = 0; i < day.length; i++) {
      for (let j = i + 1; j < day.length; j++) {
        const a = day[i];
        const b = day[j];
        if (toMinutes(b.start) >= toMinutes(a.end)) break;
        conflicts.push({
          type: 'overlap',
          date,
          stopIds: [a.id, b.id],
          message: `"${a.name}" (${a.start}–${a.end}) overlaps "${b.name}" (${b.start}–${b.end})`,
        });
      }
    }
    for (let i = 0; i + 1 < day.length; i++) {
      const a = day[i];
      const b = day[i + 1];
      const gap = toMinutes(b.start) - toMinutes(a.end);
      if (gap < 0 || !hasCoords(a) || !hasCoords(b)) continue;
      const km = haversineKm(a, b);
      const need = estimateTravelMinutes(km);
      if (need > gap) {
        conflicts.push({
          type: 'travel',
          date,
          stopIds: [a.id, b.id],
          message: `Only ${gap} min between "${a.name}" and "${b.name}", but they are ${km.toFixed(1)} km apart (about ${need} min of travel)`,
        });
      }
    }
  }
  return conflicts;
}

// First gap of at least `duration` minutes on `date`, as { start, end }
// in "HH:MM", or null when the day is full.
export function findFreeSlot(stops, date, duration = 60, dayStart = 9 * 60, dayEnd = 21 * 60) {
  const busy = stops
    .filter((s) => s.date === date)
    .map((s) => [toMinutes(s.start), toMinutes(s.end)])
    .sort((a, b) => a[0] - b[0]);
  let cursor = dayStart;
  for (const [start, end] of busy) {
    if (start - cursor >= duration) break;
    cursor = Math.max(cursor, end);
  }
  if (cursor + duration > dayEnd) return null;
  return { start: fromMinutes(cursor), end: fromMinutes(cursor + duration) };
}

// Side-by-side layout for overlapping stops on one day.
// Returns Map(stopId -> { lane, lanes }).
export function assignLanes(dayStops) {
  const layout = new Map();
  const sorted = sortStops(dayStops);
  let cluster = [];
  let laneEnds = [];
  let clusterEnd = -1;

  const flush = () => {
    for (const id of cluster) layout.get(id).lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };

  for (const stop of sorted) {
    const start = toMinutes(stop.start);
    const end = toMinutes(stop.end);
    if (cluster.length && start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = end;
    layout.set(stop.id, { lane, lanes: 1 });
    cluster.push(stop.id);
    clusterEnd = Math.max(cluster.length === 1 ? end : clusterEnd, end);
  }
  flush();
  return layout;
}
