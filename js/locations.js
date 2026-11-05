import { CONFIG } from './config.js';
import { placeholderPano } from './placeholder.js';

/**
 * Load and validate locations.
 * Each entry: { id, name, lat, lng, image?, funFact?, startYaw? }
 *   image    - filename of an equirectangular JPG (served from
 *              CONFIG.imageBaseUrl) or a full URL. Leave empty/null to use a
 *              generated placeholder.
 *   funFact  - optional text shown on the result card after guessing.
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

// ---------- Image host (R2, or our own proxy if R2 is blocked) ----------

const isRemote = (url) => /^https?:/.test(url);
let useProxy = false;

function imageBase() {
  const base = useProxy ? CONFIG.imageProxyUrl : CONFIG.imageBaseUrl;
  return base.endsWith('/') ? base : `${base}/`;
}

/** Switch all photos to the proxy. Returns false if already switched or not applicable. */
export function switchToProxy() {
  if (useProxy || !CONFIG.imageProxyUrl || !isRemote(CONFIG.imageBaseUrl)) return false;
  useProxy = true;
  console.warn('Photo host unreachable; loading photos through', CONFIG.imageProxyUrl);
  return true;
}

/**
 * Quickly check that the photo host is reachable from this network, so blocked
 * players don't wait out a long timeout on every photo.
 */
export async function checkImageHost(locations, timeoutMs = 4000) {
  const sample = locations.find((l) => l.image && !/^(https?:|blob:|data:|\/)/.test(l.image));
  if (!sample || !isRemote(CONFIG.imageBaseUrl)) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(imageBase() + sample.image, { method: 'HEAD', signal: ctrl.signal });
    if (!res.ok) switchToProxy();
  } catch {
    switchToProxy();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Preloading ----------

const downloads = new Map(); // photo URL -> Promise<blob: URL of the downloaded photo>

/**
 * Download a photo (once) and return a local blob: URL for it. Calling this
 * early, e.g. for the next round, makes the photo appear instantly later.
 */
export function loadPano(url) {
  if (url.startsWith('blob:')) return Promise.resolve(url);
  if (!downloads.has(url)) {
    const p = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.blob();
      })
      .then((blob) => URL.createObjectURL(blob));
    p.catch(() => downloads.delete(url)); // allow a retry later
    downloads.set(url, p);
  }
  return downloads.get(url);
}

/** Free downloaded photos that aren't in `keepUrls`. */
export function forgetPanos(keepUrls = []) {
  const keep = new Set(keepUrls);
  for (const [url, p] of downloads) {
    if (keep.has(url)) continue;
    downloads.delete(url);
    p.then((blobUrl) => URL.revokeObjectURL(blobUrl)).catch(() => {});
  }
}

// ---------- Panorama URLs ----------

const placeholderCache = new Map();

/** URL to feed the panorama viewer for a location. */
export async function panoUrlFor(loc, index) {
  if (loc.image) {
    // Full URLs are used as-is; bare filenames are served from the image host.
    if (/^(https?:|blob:|data:|\/)/.test(loc.image)) return loc.image;
    return imageBase() + loc.image;
  }
  if (!placeholderCache.has(loc.id)) {
    placeholderCache.set(loc.id, placeholderPano(`Placeholder ${index + 1}`, index));
  }
  return placeholderCache.get(loc.id);
}
