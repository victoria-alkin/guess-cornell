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
panos/                built photos for local play (git-ignored; live site uses R2)
scripts/              spreadsheet converter + R2 upload
```

## Adding locations

Locations come from a spreadsheet, `assets/Photos and Infos.xlsx`. The whole `assets/` folder is git-ignored, so it never reaches GitHub.

| Column | Contents |
|---|---|
| Photo | Filename of the 360° JPG in `assets/photos/`. If this is empty, the script uses a photo embedded in that row of the spreadsheet. |
| Title | Location name, shown after the player guesses |
| Pin | `42.4490, -76.4889` or `42°26'55.8"N 76°29'20.0"W` |
| Fun Fact | Optional. Shown on the result card. A leading "Fun Fact:" is removed. |
| Start Direction | Optional. The initial view direction in degrees (0 = photo center). |

Then run:

```sh
python -m pip install -r scripts/requirements.txt   # once
npm run build:locations   # writes data/locations.json + resized photos in panos/
npm run upload            # sends new photos to Cloudflare R2 (run `npx wrangler login` once first)
```

The build step resizes each photo to 5000 px wide (JPEG quality 80) and strips camera and GPS metadata. It names each file after a hash of its contents (e.g. `33df99c2119c3cde.jpg`), so filenames don't give away the answer. During local development, photos load from `panos/`. The live site loads them from R2, set by `R2_PUBLIC_URL` in `js/config.js`.

## Tuning

Everything is in `js/config.js`:

- `roundsPerGame`, `roundTimeSeconds`
- `scoring`: full points inside `perfectRadiusMeters`, then exponential decay. A guess `halfPointsMeters` away earns half the max.
- `units`: `'metric'` or `'imperial'`
- `map.base`: switch from OpenStreetMap tiles to a custom campus map image. There's a commented example. The image must be north-up, and you need the lat/lng of its corners.

## Deploying

The game is static files only. Push the folder to GitHub Pages, Netlify, Vercel, or any static host.

Note: `locations.json` is public, so a determined player could look up the answers. Hiding them would require a small backend that serves one round at a time.
