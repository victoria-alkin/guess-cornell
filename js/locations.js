import { placeholderPano } from './placeholder.js';

/**
 * Load and validate locations.
 * Each entry: { id, name, lat, lng, image?, startYaw? }
 *   image    - path to an equirectangular JPG, e.g. "panos/mcgraw-tower.jpg".
 *              Leave empty/null to use a generated placeholder.
 *   startYaw - optional initial view direction in degrees (0 = image center).
 */
export async function loadLocations(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const raw = await res.json();
  const list = Array.isArray(raw) ? raw : raw.locations;
  if (!Array.isArray(list)) throw new Error(`${url} must be an array of locations`);

  const valid = list.filter((loc, i) => {
    const ok = Number.isFinite(loc.lat) && Number.isFinite(loc.lng);
    if (!ok) console.warn(`Skipping location #${i}: lat/lng missing or not numbers`, loc);
    return ok;
  });
  if (valid.length === 0) throw new Error('No valid locations found');
  return valid.map((loc, i) => ({ id: loc.id ?? `loc-${i}`, ...loc }));
}

/** Pick `n` random locations without repeats. */
export function pickRounds(locations, n) {
  const pool = [...locations];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
}

const placeholderCache = new Map();

/** URL to feed the panorama viewer for a location. */
export async function panoUrlFor(loc, index) {
  if (loc.image) return loc.image;
  if (!placeholderCache.has(loc.id)) {
    placeholderCache.set(loc.id, placeholderPano(`Placeholder ${index + 1}`, index));
  }
  return placeholderCache.get(loc.id);
}
