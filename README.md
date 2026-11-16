# Travel Planning

A local web app for planning trips: see your stops on a map, build an hourly
itinerary that checks itself for conflicts, and find nearby things to add.

## Use it online

The app is published with GitHub Pages at
https://junipersokawaii.github.io/Travel-Planning/ and redeploys automatically
whenever `main` changes (see `.github/workflows/deploy.yml`).

One-time setup: in the repository's **Settings → Pages**, set **Source** to
**GitHub Actions**.

## Run it locally

Requires Node.js 22 or later.

```bash
npm install
npm start
```

Then open http://localhost:3000. Set `PORT` to use a different port.

## What it does

- **Stops** – enter a destination name, address, date, start and end time, and
  notes. Addresses are looked up and pinned on the map; if an address matches
  several places you pick the right one.
- **Map** – numbered pins in visiting order with a route line per day, coloured
  by day. Click a stop in the itinerary to jump to it on the map.
- **Hourly itinerary** – a timeline for each day, plus an "All days" overview.
  Double-click a stop to edit or delete it.
- **Conflict checks**
  - *Time overlap* (red): two stops on the same day whose times intersect.
  - *Tight connection* (amber): not enough time between two consecutive stops
    to travel between them. Travel time is a rough estimate from straight-line
    distance (walking for short hops, driving otherwise), not a routed journey.
- **Suggestions** – search around any located stop for sights, museums,
  restaurants, cafés, parks, nightlife or shopping, and add a result straight
  into a free slot on that day.
- **Multiple trips** – create, rename, switch between and delete trips.

Trips are saved automatically in the browser you use, on that device only.
They are never uploaded anywhere, so they do not follow you to another browser
or device, and clearing the browser's site data removes them. Use **Export** to
download a backup file and **Import** to load it elsewhere.

## Data sources

No API keys are needed. The app uses free OpenStreetMap services, so it needs
an internet connection, and addresses you look up are sent to them:

- Map tiles: `tile.openstreetmap.org`
- Address lookup: Nominatim (`nominatim.openstreetmap.org`)
- Suggestions: Overpass API (`overpass-api.de`, with a fallback mirror)

These are shared public services intended for light personal use.

## Development

```bash
npm test
```

- `public/app.js`, `public/index.html`, `public/styles.css` – the interface.
- `public/conflicts.js` – conflict detection and scheduling helpers.
- `public/suggestions.js` – builds and parses the nearby-places queries.
- `public/services.js` – address lookup and suggestion requests.
- `server.js` – small static server for local preview.
- `test/` – unit tests for the scheduling and suggestion logic.
