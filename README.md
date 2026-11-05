# Guess Cornell

A static website game. Players see a 360° photo taken somewhere on the Cornell campus. They drag to look around, drop a pin on the campus map, and score points based on how close the pin is.

## How it works

- **Daily puzzle:** each day (resetting at midnight Ithaca time) everyone plays the same 5 locations, once. The server picks them automatically and avoids repeating the last week's spots when it has enough locations.
- **Answers stay on the server.** The browser only gets photo filenames. Each guess goes to `/api/guess`, which scores it and only then reveals that round's answer. Rounds can't be re-guessed, and a finished puzzle can't be replayed.
- **Leaderboard:** players type a name, which is remembered in their browser with a random player ID. No sign-up. Scores are stored in Upstash Redis.

## Run locally

```sh
npm start        # http://localhost:8000
```

This runs `scripts/dev-server.mjs`, which serves the site, the API and local photos. It uses an in-memory database, so no accounts are needed, and scores reset when it stops.

## Project layout

```
public/               the website (the only folder Vercel serves)
  index.html          screens: start, round, result/summary, leaderboard
  css/style.css
  js/game.js          game flow, timer, results, leaderboards
  js/api.js           talks to the server; remembers player ID and name
  js/locations.js     photo host (R2 or proxy), preloading
  js/scoring.js       distance + points curve (also used by the server)
  js/map.js           Leaflet map setup
  js/config.js        timer, scoring, units, map, photo URLs
api/                  Vercel serverless functions
  daily.js            GET  today's puzzle (photos only) + your progress
  guess.js            POST score a round, reveal its answer
  leaderboard.js      GET  top scores + your rank
  name.js             POST change your leaderboard name
  _lib/               daily-puzzle logic, Redis client, helpers
data/locations.json   all locations WITH answers (server-only)
panos/                built photos for local play (git-ignored; live site uses R2)
scripts/              spreadsheet converter, R2 upload, local dev server
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

The build step resizes each photo to 5000 px wide (JPEG quality 80) and strips camera and GPS metadata. It names each file after a hash of its contents (e.g. `33df99c2119c3cde.jpg`), so filenames don't give away the answer. During local development, photos load from `panos/`. The live site loads them from R2, set by `R2_PUBLIC_URL` in `public/js/config.js`.

## Tuning

Most settings are in `public/js/config.js`:

- `roundTimeSeconds` (rounds per day are set in `api/_lib/daily.js`)
- `scoring`: full points inside `perfectRadiusMeters`, then exponential decay. A guess `halfPointsMeters` away earns half the max.
- `units`: `'metric'` or `'imperial'`
- `map.base`: switch from OpenStreetMap tiles to a custom campus map image. There's a commented example. The image must be north-up, and you need the lat/lng of its corners.

## Deploying

Pushing to `main` deploys to Vercel. The leaderboard needs the Upstash Redis integration connected to the Vercel project; it provides the `KV_REST_API_URL` and `KV_REST_API_TOKEN` environment variables. `data/locations.json` contains the answers, so keep the GitHub repo private.
