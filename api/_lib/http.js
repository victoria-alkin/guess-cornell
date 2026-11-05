import { StoreNotConfigured } from './store.js';

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const error = (message, status = 400) => json({ error: message }, status);

/** Wrap a handler so unexpected failures return JSON instead of crashing. */
export function route(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (err) {
      if (err instanceof StoreNotConfigured) return error(err.message, 503);
      console.error(err);
      return error('Something went wrong on the server.', 500);
    }
  };
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Player ids are random UUIDs generated in the browser. */
export const isPlayerId = (s) =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export const MAX_NAME_LENGTH = 24;

/** Tidy a display name, or return null if nothing usable is left. */
export function cleanName(name) {
  if (typeof name !== 'string') return null;
  const s = name
    .normalize('NFKC')
    // control characters, zero-width and bidi-override characters
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return s || null;
}
