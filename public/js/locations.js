import { CONFIG } from './config.js';
import { placeholderPano } from './placeholder.js';

// Photo loading for the game: which host to use, preloading, and placeholders.
// Each round is { id, image, startYaw }; answers stay on the server.

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
export async function checkImageHost(rounds, timeoutMs = 4000) {
  const sample = rounds.find((l) => l.image && !/^(https?:|blob:|data:|\/)/.test(l.image));
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
