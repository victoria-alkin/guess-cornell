# Guess Cornell

A static website game. Players see a 360° photo taken somewhere on the Cornell campus. They drag to look around, drop a pin on the campus map, and score points based on how close the pin is.

## Run locally

The page loads `data/locations.json` with `fetch`, so it has to be served over HTTP. Opening `index.html` directly won't work. Use either command:

```sh
npm start                    # http://localhost:8000
python -m http.server 8000   # same thing, no Node needed
```

## Project layout

```
index.html            screens: start, round, result/summary
css/style.css
js/config.js          rounds, timer, scoring curve, units, map base layer
js/game.js            game flow, timer, guessing, results
js/scoring.js         distance (haversine) + points curve
js/map.js             Leaflet map setup (tiles or a custom campus image)
js/locations.js       loads/validates locations, picks random rounds
js/placeholder.js     generated stand-in panoramas until real photos exist
data/locations.json   the list of locations
panos/                put 360° photos here
```

## Adding locations

1. Export each 360° photo as an **equirectangular JPG** (2:1 aspect ratio) into `panos/`. A width of 4096–8192 px works well. Larger files load slowly on phones.
2. Add an entry to `data/locations.json`:

```json
{ "id": "mcgraw-tower", "name": "McGraw Tower", "lat": 42.44736, "lng": -76.48514, "image": "panos/mcgraw-tower.jpg" }
```

- `name` is shown only after the player guesses.
- `image: null` uses a generated placeholder.
- `startYaw` (optional, in degrees) fixes the initial view direction. When it's omitted, the view starts at a random direction.

The sample entries use approximate coordinates and serve only as placeholders.

## Tuning

Everything is in `js/config.js`:

- `roundsPerGame`, `roundTimeSeconds`
- `scoring`: full points inside `perfectRadiusMeters`, then exponential decay. A guess `halfPointsMeters` away earns half the max.
- `units`: `'metric'` or `'imperial'`
- `map.base`: switch from OpenStreetMap tiles to a custom campus map image. There's a commented example. The image must be north-up, and you need the lat/lng of its corners.

## Deploying

The game is static files only. Push the folder to GitHub Pages, Netlify, Vercel, or any static host.

Note: `locations.json` is public, so a determined player could look up the answers. Hiding them would require a small backend that serves one round at a time.
