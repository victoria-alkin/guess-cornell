import { CONFIG } from './config.js';

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in meters between two {lat, lng} points. */
export function distanceMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Points for a guess `meters` away from the true location. */
export function scoreForDistance(meters) {
  const { maxPoints, perfectRadiusMeters: r, halfPointsMeters: h } = CONFIG.scoring;
  if (meters <= r) return maxPoints;
  const decay = (h - r) / Math.LN2;
  return Math.round(maxPoints * Math.exp(-(meters - r) / decay));
}

export function formatDistance(meters) {
  if (CONFIG.units === 'imperial') {
    const feet = meters * 3.28084;
    if (feet < 1000) return `${Math.round(feet)} ft`;
    return `${(meters / 1609.344).toFixed(2)} mi`;
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

export const formatPoints = (n) => n.toLocaleString('en-US');
