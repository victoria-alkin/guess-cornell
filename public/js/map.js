import { CONFIG } from './config.js';

/** Create a Leaflet map with the configured campus base layer. */
export function createMap(el, options = {}) {
  const m = CONFIG.map;
  const map = L.map(el, {
    center: m.center,
    zoom: m.zoom,
    minZoom: m.minZoom,
    maxZoom: m.maxZoom,
    maxBounds: m.maxBounds,
    maxBoundsViscosity: 1.0,
    ...options,
  });

  const base = m.base;
  if (base.type === 'image') {
    if (base.background) map.getContainer().style.background = base.background;
    L.imageOverlay(base.url, base.bounds, { attribution: base.attribution }).addTo(map);
  } else {
    L.tileLayer(base.url, base.options).addTo(map);
  }
  return map;
}

/** Round dot marker. kind: 'guess' | 'actual'. */
export function pinIcon(kind, label = '') {
  return L.divIcon({
    className: '',
    html: `<div class="pin pin-${kind}">${label}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

export function resetView(map) {
  map.setView(CONFIG.map.center, CONFIG.map.zoom, { animate: false });
}
