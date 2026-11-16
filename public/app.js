import {
  assignLanes,
  findConflicts,
  findFreeSlot,
  fromMinutes,
  hasCoords,
  sortStops,
  toMinutes,
} from './conflicts.js';

const L = window.L;
const DAY_COLORS = ['#0f766e', '#7c3aed', '#c2410c', '#1d4ed8', '#be185d', '#4d7c0f', '#b45309'];
const PX_PER_MIN = 1;

let state = { trips: [], activeTripId: null };
const ui = {
  day: 'all',
  tab: 'itinerary',
  editingId: null,
  coords: null, // { lat, lon, forAddress } chosen in the stop form
  suggestions: [],
  suggestDate: null,
  fitKey: '',
};

const $ = (selector) => document.querySelector(selector);
const stopForm = $('#stop-form');
const suggestForm = $('#suggest-form');

// ---- Small helpers ---------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') el.style.cssText = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.filter((c) => c != null && c !== false));
  return el;
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function formatDate(date, long = false) {
  return new Date(`${date}T00:00`).toLocaleDateString(undefined, {
    weekday: long ? 'long' : 'short',
    month: 'short',
    day: 'numeric',
  });
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

// ---- State -----------------------------------------------------------------

const activeTrip = () => state.trips.find((t) => t.id === state.activeTripId) || null;
const tripStops = () => activeTrip()?.stops ?? [];
const tripDays = () => [...new Set(tripStops().map((s) => s.date))].sort();
const dayColor = (date) => DAY_COLORS[Math.max(tripDays().indexOf(date), 0) % DAY_COLORS.length];

let saveTimer;
function persist() {
  $('#save-status').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      $('#save-status').textContent = 'All changes saved';
    } catch (err) {
      $('#save-status').textContent = `Not saved: ${err.message}`;
    }
  }, 300);
}

function commit() {
  persist();
  render();
}

function createTrip(name) {
  const trip = { id: uid(), name, stops: [] };
  state.trips.push(trip);
  state.activeTripId = trip.id;
  ui.day = 'all';
  ui.suggestions = [];
}

// ---- Map -------------------------------------------------------------------

const map = L.map('map', { zoomControl: true }).setView([25, 5], 2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const stopLayer = L.layerGroup().addTo(map);
const suggestionLayer = L.layerGroup().addTo(map);
const markersById = new Map();

function pinIcon(label, color, extraClass = '') {
  const size = extraClass.includes('suggestion') ? 16 : 28;
  return L.divIcon({
    className: '',
    html: `<div class="pin ${extraClass}" style="--pin:${color}">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function popupContent(title, lines, button) {
  const box = h('div', {}, h('strong', {}, title));
  for (const line of lines.filter(Boolean)) box.append(h('div', {}, line));
  if (button) box.append(button);
  return box;
}

function renderMap(visibleStops, conflictIds) {
  stopLayer.clearLayers();
  markersById.clear();
  const located = visibleStops.filter(hasCoords);
  const byDay = new Map();
  for (const stop of located) {
    if (!byDay.has(stop.date)) byDay.set(stop.date, []);
    byDay.get(stop.date).push(stop);
  }
  for (const [date, stops] of byDay) {
    const color = dayColor(date);
    if (stops.length > 1) {
      L.polyline(
        stops.map((s) => [s.lat, s.lon]),
        { color, weight: 3, opacity: 0.75, dashArray: '6 6' }
      ).addTo(stopLayer);
    }
    stops.forEach((stop, index) => {
      const marker = L.marker([stop.lat, stop.lon], {
        icon: pinIcon(index + 1, color, conflictIds.has(stop.id) ? 'conflict' : ''),
        title: stop.name,
      })
        .bindPopup(() =>
          popupContent(
            stop.name,
            [`${formatDate(stop.date)} · ${stop.start}–${stop.end}`, stop.address, stop.notes],
            h('button', { type: 'button', onclick: () => editStop(stop.id) }, 'Edit')
          )
        )
        .addTo(stopLayer);
      markersById.set(stop.id, marker);
    });
  }

  suggestionLayer.clearLayers();
  for (const place of ui.suggestions) {
    L.marker([place.lat, place.lon], { icon: pinIcon('', '#f59e0b', 'suggestion'), title: place.name })
      .bindPopup(() =>
        popupContent(
          place.name,
          [place.kind, place.address],
          h('button', { type: 'button', onclick: () => addSuggestion(place) }, 'Add to trip')
        )
      )
      .addTo(suggestionLayer);
  }

  // Only re-frame the map when what is shown actually changes.
  const fitKey = `${state.activeTripId}|${ui.day}|${located.map((s) => s.id).join(',')}`;
  if (fitKey !== ui.fitKey && located.length) {
    ui.fitKey = fitKey;
    map.fitBounds(L.latLngBounds(located.map((s) => [s.lat, s.lon])), { padding: [50, 50], maxZoom: 15 });
  }
}

function focusOnMap(stopId) {
  const marker = markersById.get(stopId);
  if (!marker) return;
  map.setView(marker.getLatLng(), Math.max(map.getZoom(), 14));
  marker.openPopup();
}

// ---- Itinerary -------------------------------------------------------------

function eventButton(stop, { conflictIds, tightIds, style }) {
  const cls = conflictIds.has(stop.id) ? 'conflict' : tightIds.has(stop.id) ? 'tight' : '';
  return h(
    'button',
    {
      type: 'button',
      class: `event ${cls}`,
      style: `--day-color:${dayColor(stop.date)};${style || ''}`,
      title: 'Click to show on map, double-click to edit',
      'data-stop-id': stop.id,
      onclick: () => focusOnMap(stop.id),
      ondblclick: () => editStop(stop.id),
    },
    h('span', { class: 'time' }, `${stop.start}–${stop.end}`),
    h('span', { class: 'name' }, stop.name),
    !hasCoords(stop) && h('span', { class: 'nopin' }, ' · not on map')
  );
}

function renderTimeline(date, flags) {
  const stops = tripStops().filter((s) => s.date === date);
  const first = Math.min(...stops.map((s) => toMinutes(s.start)), 9 * 60);
  const last = Math.max(...stops.map((s) => toMinutes(s.end)), 19 * 60);
  const startHour = Math.max(Math.floor(first / 60) - 1, 0);
  const endHour = Math.min(Math.ceil(last / 60) + 1, 24);
  const top = (mins) => (mins - startHour * 60) * PX_PER_MIN;
  const lanes = assignLanes(stops);

  const timeline = h('div', {
    class: 'timeline',
    style: `height:${(endHour - startHour) * 60 * PX_PER_MIN + 12}px;margin-top:10px`,
  });
  for (let hour = startHour; hour <= endHour; hour++) {
    timeline.append(
      h('div', { class: 'hour', style: `top:${top(hour * 60)}px` }, h('span', {}, `${String(hour).padStart(2, '0')}:00`))
    );
  }
  for (const stop of stops) {
    const { lane, lanes: laneCount } = lanes.get(stop.id);
    const height = Math.max((toMinutes(stop.end) - toMinutes(stop.start)) * PX_PER_MIN - 2, 30);
    const style =
      `top:${top(toMinutes(stop.start)) + 1}px;height:${height}px;` +
      `left:calc(${(lane / laneCount) * 100}% + 6px);width:calc(${100 / laneCount}% - 10px);`;
    timeline.append(eventButton(stop, { ...flags, style }));
  }
  return h(
    'div',
    {},
    h('p', { class: 'hint' }, `${formatDate(date, true)} · click a stop to find it on the map, double-click to edit`),
    timeline
  );
}

function renderAllDays(flags) {
  const wrap = h('div', {});
  for (const date of tripDays()) {
    const stops = sortStops(tripStops().filter((s) => s.date === date));
    wrap.append(
      h(
        'div',
        { class: 'day-group' },
        h('h3', {}, h('span', { class: 'dot', style: `background:${dayColor(date)}` }), formatDate(date, true)),
        h('ul', { class: 'day-list' }, ...stops.map((stop) => h('li', {}, eventButton(stop, flags))))
      )
    );
  }
  return wrap;
}

function renderItinerary(conflicts, flags) {
  const days = tripDays();
  if (ui.day !== 'all' && !days.includes(ui.day)) ui.day = 'all';

  const countByDay = new Map();
  for (const c of conflicts) countByDay.set(c.date, (countByDay.get(c.date) || 0) + 1);

  const chip = (value, label, color, count) =>
    h(
      'button',
      {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(ui.day === value),
        onclick: () => {
          ui.day = value;
          render();
        },
      },
      color && h('span', { class: 'dot', style: `background:${color}` }),
      label,
      count ? h('span', { class: 'badge', title: `${count} conflict(s)` }, String(count)) : null
    );
  $('#day-chips').replaceChildren(
    ...(days.length
      ? [chip('all', 'All days', null, conflicts.length), ...days.map((d) => chip(d, formatDate(d), dayColor(d), countByDay.get(d)))]
      : [])
  );

  const shown = conflicts.filter((c) => ui.day === 'all' || c.date === ui.day);
  const conflictBox = $('#conflicts');
  if (!tripStops().length) {
    conflictBox.replaceChildren();
  } else if (!shown.length) {
    conflictBox.replaceChildren(h('p', { class: 'all-clear' }, '✓ No schedule conflicts'));
  } else {
    conflictBox.replaceChildren(
      h(
        'ul',
        { class: 'conflict-list' },
        ...shown.map((c) =>
          h(
            'li',
            { class: c.type },
            h('strong', {}, `${c.type === 'overlap' ? 'Time overlap' : 'Tight connection'} · ${formatDate(c.date)}`),
            c.message
          )
        )
      )
    );
  }

  const body = $('#itinerary');
  if (!tripStops().length) {
    body.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('p', {}, 'No stops yet. Add your first destination to start planning.'),
        h('button', { type: 'button', class: 'primary', onclick: () => newStop() }, 'Add a stop')
      )
    );
  } else {
    body.replaceChildren(ui.day === 'all' ? renderAllDays(flags) : renderTimeline(ui.day, flags));
  }
}

// ---- Stop form -------------------------------------------------------------

function setTab(tab) {
  ui.tab = tab;
  for (const button of document.querySelectorAll('.tabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }
  for (const panel of document.querySelectorAll('.tab-body')) {
    panel.hidden = panel.dataset.panel !== tab;
  }
}

function setLocationStatus() {
  const address = stopForm.address.value.trim();
  const status = $('#location-status');
  if (ui.coords && ui.coords.forAddress === address) {
    status.textContent = `📍 Located at ${ui.coords.lat.toFixed(4)}, ${ui.coords.lon.toFixed(4)}`;
  } else if (address) {
    status.textContent = 'Not located yet. It will be looked up when you save.';
  } else {
    status.textContent = 'Add an address to see this stop on the map.';
  }
}

function fillForm(stop) {
  stopForm.reset();
  $('#lookup-results').replaceChildren();
  $('#form-error').textContent = '';
  ui.editingId = stop?.id ?? null;
  ui.coords = stop && hasCoords(stop) ? { lat: stop.lat, lon: stop.lon, forAddress: stop.address || '' } : null;

  if (stop) {
    for (const field of ['name', 'address', 'date', 'start', 'end', 'notes']) {
      stopForm[field].value = stop[field] ?? '';
    }
  } else {
    const date = ui.day !== 'all' ? ui.day : tripDays().at(-1) || today();
    const slot = findFreeSlot(tripStops(), date) || { start: '09:00', end: '10:00' };
    stopForm.date.value = date;
    stopForm.start.value = slot.start;
    stopForm.end.value = slot.end;
  }
  $('#tab-stop').textContent = stop ? 'Edit stop' : 'Add stop';
  $('#stop-save').textContent = stop ? 'Save changes' : 'Add to itinerary';
  $('#stop-delete').hidden = !stop;
  setLocationStatus();
}

function newStop() {
  fillForm(null);
  setTab('stop');
  stopForm.name.focus();
}

function editStop(id) {
  const stop = tripStops().find((s) => s.id === id);
  if (!stop) return;
  map.closePopup();
  fillForm(stop);
  setTab('stop');
}

async function lookupAddress() {
  const address = stopForm.address.value.trim();
  const list = $('#lookup-results');
  if (!address) return;
  $('#lookup').disabled = true;
  $('#location-status').textContent = 'Looking up address…';
  try {
    const { results } = await api(`/api/geocode?q=${encodeURIComponent(address)}`);
    if (!results.length) {
      list.replaceChildren();
      $('#location-status').textContent = 'No match found. Try adding a city or country.';
      return;
    }
    const choose = (result) => {
      ui.coords = { lat: result.lat, lon: result.lon, forAddress: stopForm.address.value.trim() };
      list.replaceChildren();
      setLocationStatus();
      map.setView([result.lat, result.lon], 15);
    };
    if (results.length === 1) choose(results[0]);
    else {
      $('#location-status').textContent = 'Several matches. Pick the right one:';
      list.replaceChildren(
        ...results.map((r) => h('li', {}, h('button', { type: 'button', onclick: () => choose(r) }, r.label)))
      );
    }
  } catch (err) {
    $('#location-status').textContent = err.message;
  } finally {
    $('#lookup').disabled = false;
  }
}

async function submitStop(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(stopForm));
  const values = {
    name: data.name.trim(),
    address: data.address.trim(),
    date: data.date,
    start: data.start,
    end: data.end,
    notes: data.notes.trim(),
  };
  if (toMinutes(values.end) <= toMinutes(values.start)) {
    $('#form-error').textContent = 'End time must be after the start time.';
    return;
  }
  $('#form-error').textContent = '';

  let coords = ui.coords && ui.coords.forAddress === values.address ? ui.coords : null;
  let warning = '';
  if (!coords && values.address) {
    $('#stop-save').disabled = true;
    try {
      const { results } = await api(`/api/geocode?q=${encodeURIComponent(values.address)}`);
      if (results.length) coords = results[0];
      else warning = 'Saved, but the address could not be found, so it is not on the map.';
    } catch (err) {
      warning = `Saved without a map pin. ${err.message}`;
    } finally {
      $('#stop-save').disabled = false;
    }
  }

  const trip = activeTrip();
  const stop = {
    id: ui.editingId || uid(),
    ...values,
    lat: coords ? coords.lat : null,
    lon: coords ? coords.lon : null,
  };
  const index = trip.stops.findIndex((s) => s.id === stop.id);
  if (index >= 0) trip.stops[index] = stop;
  else trip.stops.push(stop);

  ui.day = stop.date;
  fillForm(null);
  setTab('itinerary');
  commit();

  const hit = findConflicts(trip.stops).filter((c) => c.stopIds.includes(stop.id));
  toast(warning || (hit.length ? `Saved, with ${hit.length} conflict(s) to review.` : `Saved "${stop.name}".`));
}

function deleteStop() {
  const trip = activeTrip();
  const stop = trip.stops.find((s) => s.id === ui.editingId);
  if (!stop || !confirm(`Delete "${stop.name}" from this trip?`)) return;
  trip.stops = trip.stops.filter((s) => s.id !== stop.id);
  fillForm(null);
  setTab('itinerary');
  commit();
}

// ---- Suggestions -----------------------------------------------------------

function renderSuggestControls() {
  const located = sortStops(tripStops().filter(hasCoords));
  const select = suggestForm.anchor;
  const previous = select.value;
  select.replaceChildren(
    ...located.map((s) => h('option', { value: s.id }, `${s.name} (${formatDate(s.date)})`))
  );
  if (located.some((s) => s.id === previous)) select.value = previous;
  suggestForm.querySelector('button[type=submit]').disabled = !located.length;
  if (!located.length) {
    $('#suggest-status').textContent =
      'Add at least one stop with an address first. Suggestions are searched around a stop.';
  } else if ($('#suggest-status').textContent.startsWith('Add at least')) {
    $('#suggest-status').textContent = '';
  }
}

function renderSuggestions() {
  $('#suggest-results').replaceChildren(
    ...ui.suggestions.map((place) =>
      h(
        'li',
        {},
        h(
          'div',
          { class: 'info' },
          h('div', { class: 'name' }, place.name),
          h(
            'div',
            { class: 'meta' },
            [place.kind, `${place.distanceKm} km away`, place.address, place.openingHours && `Hours: ${place.openingHours}`]
              .filter(Boolean)
              .join(' · ')
          ),
          place.website &&
            h('a', { class: 'meta', href: place.website, target: '_blank', rel: 'noopener noreferrer' }, 'Website')
        ),
        h('button', { type: 'button', onclick: () => addSuggestion(place) }, 'Add')
      )
    )
  );
}

async function searchSuggestions(event) {
  event.preventDefault();
  const anchor = tripStops().find((s) => s.id === suggestForm.anchor.value);
  if (!anchor) return;
  const button = suggestForm.querySelector('button[type=submit]');
  button.disabled = true;
  $('#suggest-status').textContent = 'Searching nearby…';
  try {
    const params = new URLSearchParams({
      lat: anchor.lat,
      lon: anchor.lon,
      radius: suggestForm.radius.value,
      category: suggestForm.category.value,
    });
    const { results } = await api(`/api/suggestions?${params}`);
    const existing = new Set(tripStops().map((s) => s.name.toLowerCase()));
    ui.suggestions = results.filter((p) => !existing.has(p.name.toLowerCase()));
    ui.suggestDate = anchor.date;
    $('#suggest-status').textContent = ui.suggestions.length
      ? `${ui.suggestions.length} places near ${anchor.name}. They are also shown as orange dots on the map.`
      : 'Nothing found. Try a wider radius or another category.';
    if (ui.suggestions.length) {
      map.fitBounds(
        L.latLngBounds([[anchor.lat, anchor.lon], ...ui.suggestions.map((p) => [p.lat, p.lon])]),
        { padding: [40, 40] }
      );
    }
  } catch (err) {
    ui.suggestions = [];
    $('#suggest-status').textContent = err.message;
  } finally {
    button.disabled = false;
    render();
  }
}

function addSuggestion(place) {
  const trip = activeTrip();
  const date = ui.suggestDate || tripDays()[0] || today();
  // Prefer a slot that also leaves enough travel time to its neighbours.
  const id = uid();
  let slot = null;
  for (let start = 9 * 60; start + 60 <= 21 * 60 && !slot; start += 15) {
    const candidate = { id, name: place.name, date, start: fromMinutes(start), end: fromMinutes(start + 60), lat: place.lat, lon: place.lon };
    const clash = findConflicts([...trip.stops, candidate]).some((c) => c.stopIds.includes(id));
    if (!clash) slot = candidate;
  }
  slot ||= findFreeSlot(trip.stops, date);
  trip.stops.push({
    id,
    name: place.name,
    address: place.address,
    date,
    start: slot?.start ?? '09:00',
    end: slot?.end ?? '10:00',
    notes: [place.kind, place.openingHours && `Hours: ${place.openingHours}`, place.website].filter(Boolean).join('\n'),
    lat: place.lat,
    lon: place.lon,
  });
  ui.suggestions = ui.suggestions.filter((p) => p.id !== place.id);
  map.closePopup();
  commit();
  toast(
    slot
      ? `Added "${place.name}" on ${formatDate(date)} at ${slot.start}–${slot.end}. Double-click it to adjust.`
      : `Added "${place.name}" on ${formatDate(date)}, but that day is full, so check the conflicts.`
  );
}

// ---- Trips -----------------------------------------------------------------

function renderTrips() {
  const select = $('#trip-select');
  select.replaceChildren(...state.trips.map((t) => h('option', { value: t.id }, t.name)));
  select.value = state.activeTripId;
}

function render() {
  const conflicts = findConflicts(tripStops());
  const conflictIds = new Set(conflicts.filter((c) => c.type === 'overlap').flatMap((c) => c.stopIds));
  const tightIds = new Set(conflicts.filter((c) => c.type === 'travel').flatMap((c) => c.stopIds));
  const visible = sortStops(tripStops().filter((s) => ui.day === 'all' || s.date === ui.day));

  renderTrips();
  renderItinerary(conflicts, { conflictIds, tightIds });
  // renderItinerary may reset ui.day, so recompute what the map shows.
  renderMap(
    ui.day === 'all' ? sortStops(tripStops()) : visible,
    new Set([...conflictIds, ...tightIds])
  );
  renderSuggestControls();
  renderSuggestions();
}

// ---- Wiring ----------------------------------------------------------------

for (const button of document.querySelectorAll('.tabs button')) {
  button.addEventListener('click', () => {
    if (button.dataset.tab === 'stop' && ui.tab !== 'stop' && !ui.editingId) fillForm(null);
    setTab(button.dataset.tab);
  });
}

stopForm.addEventListener('submit', submitStop);
stopForm.address.addEventListener('input', setLocationStatus);
$('#lookup').addEventListener('click', lookupAddress);
$('#stop-delete').addEventListener('click', deleteStop);
$('#stop-cancel').addEventListener('click', () => {
  fillForm(null);
  setTab('itinerary');
});
suggestForm.addEventListener('submit', searchSuggestions);

$('#trip-select').addEventListener('change', (event) => {
  state.activeTripId = event.target.value;
  ui.day = 'all';
  ui.suggestions = [];
  fillForm(null);
  commit();
});
$('#trip-new').addEventListener('click', () => {
  const name = prompt('Name for the new trip:', 'New trip')?.trim();
  if (!name) return;
  createTrip(name);
  fillForm(null);
  commit();
});
$('#trip-rename').addEventListener('click', () => {
  const trip = activeTrip();
  const name = prompt('Rename trip:', trip.name)?.trim();
  if (!name) return;
  trip.name = name;
  commit();
});
$('#trip-delete').addEventListener('click', () => {
  const trip = activeTrip();
  if (!confirm(`Delete "${trip.name}" and all of its stops?`)) return;
  state.trips = state.trips.filter((t) => t.id !== trip.id);
  if (state.trips.length) state.activeTripId = state.trips[0].id;
  else createTrip('My trip');
  ui.day = 'all';
  ui.suggestions = [];
  fillForm(null);
  commit();
});

async function init() {
  try {
    const [saved, categories] = await Promise.all([api('/api/state'), api('/api/categories')]);
    state = saved;
    suggestForm.category.replaceChildren(...categories.map((c) => h('option', { value: c.id }, c.label)));
  } catch (err) {
    toast(`Could not load saved trips: ${err.message}`);
  }
  if (!state.trips.length) createTrip('My trip');
  if (!activeTrip()) state.activeTripId = state.trips[0].id;
  fillForm(null);
  render();
}

init();
