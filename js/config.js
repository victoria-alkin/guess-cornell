// All the knobs for the game live here.

// Public URL of the Cloudflare R2 bucket holding the panoramas, ending in "/".
// e.g. 'https://pub-0123456789abcdef.r2.dev/'. Leave empty until R2 is set up.
const R2_PUBLIC_URL = 'https://pub-11a8582e4e344fa49517a8b4184409b8.r2.dev/';

const isLocal =
  typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname);

export const CONFIG = {
  roundsPerGame: 5,
  roundTimeSeconds: 60,

  // Where the list of locations lives (see data/locations.json).
  locationsUrl: 'data/locations.json',

  // Where panorama photos load from. Local development uses the panos/ folder
  // (filled by `npm run build:locations`); the live site uses R2.
  imageBaseUrl: isLocal || !R2_PUBLIC_URL ? 'panos/' : R2_PUBLIC_URL,

  // The same photos proxied through our own site (see vercel.json), used when
  // a player's network blocks r2.dev (common on school/work networks).
  imageProxyUrl: '/photos/',

  // Scoring: full points inside `perfectRadiusMeters`, then exponential decay
  // so that a guess `halfPointsMeters` away earns half the max.
  //   15 m  -> 5000   |  250 m -> 2500  |  500 m -> ~1200  |  1 km -> ~270
  scoring: {
    maxPoints: 5000,
    perfectRadiusMeters: 15,
    halfPointsMeters: 250,
  },

  // 'metric' (m / km) or 'imperial' (ft / mi)
  units: 'metric',

  map: {
    center: [42.4470, -76.4830],
    zoom: 15,
    minZoom: 14,
    maxZoom: 19,
    // Users can't pan the map outside this box.
    maxBounds: [[42.430, -76.505], [42.465, -76.455]],

    // Base layer. Swap this block to change how the map looks.
    //
    // Tiles (current):
    base: {
      type: 'tiles',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    //
    // Custom campus map image (later): a north-up image plus the lat/lng of its
    // south-west and north-east corners.
    // base: {
    //   type: 'image',
    //   url: 'img/campus-map.png',
    //   bounds: [[42.436, -76.495], [42.458, -76.466]],
    //   background: '#efe9df',
    // },
  },
};
