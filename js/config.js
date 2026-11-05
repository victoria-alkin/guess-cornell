// All the knobs for the game live here.

export const CONFIG = {
  roundsPerGame: 5,
  roundTimeSeconds: 60,

  // Where the list of locations lives (see data/locations.json).
  locationsUrl: 'data/locations.json',

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
