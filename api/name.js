// POST /api/name  { player, name }
// Change the name shown on the leaderboard (applies to all of this player's scores).

import { cleanName, error, isPlayerId, json, readJson, route } from './_lib/http.js';
import { redis } from './_lib/store.js';
import { isProfane, NAME_NOT_ALLOWED } from './_lib/profanity.js';

export const POST = route(async (request) => {
  const body = await readJson(request);
  if (!body || !isPlayerId(body.player)) return error('Missing or invalid player id.');
  const name = cleanName(body.name);
  if (!name) return error('Please enter a name.');
  if (await isProfane(name)) return error(NAME_NOT_ALLOWED, 422);
  await redis('HSET', 'names', body.player, name);
  return json({ name });
});
