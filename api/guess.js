// POST /api/guess  { player, name, date, round, guess: {lat, lng} | null, timedOut }
// Scores one round on the server and reveals that round's answer. Each round
// can only be answered once, in order; finishing adds the total to the leaderboard.

import { distanceMeters, scoreForDistance } from '../public/js/scoring.js';
import {
  addDays, dailyLocations, isDate, loadGame, saveGame, todayDate, totalPoints,
} from './_lib/daily.js';
import { cleanName, error, isPlayerId, json, readJson, route } from './_lib/http.js';
import { pipeline } from './_lib/store.js';

const LEADERBOARD_TTL = 60 * 60 * 24 * 400;

export const POST = route(async (request) => {
  const body = await readJson(request);
  if (!body) return error('Invalid request body.');
  const { player, date, round } = body;
  if (!isPlayerId(player)) return error('Missing or invalid player id.');
  if (!isDate(date)) return error('Missing or invalid date.');
  if (!Number.isInteger(round) || round < 0) return error('Missing or invalid round.');

  // Today's puzzle, or yesterday's if it was started before midnight.
  const today = todayDate();
  if (date !== today && date !== addDays(today, -1)) return error('That puzzle has closed.', 410);
  const game = await loadGame(date, player);
  if (date !== today && game.results.length === 0) return error('That puzzle has closed.', 410);

  const locations = await dailyLocations(date);
  if (round >= locations.length) return error('No such round.');

  // Already answered (e.g. a double click or a retry after a lost response).
  if (round < game.results.length) {
    return json(response(game, round, locations.length));
  }
  if (round > game.results.length) return error('Answer the rounds in order.', 409);

  let guess = null;
  if (body.guess != null) {
    const lat = Number(body.guess.lat);
    const lng = Number(body.guess.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return error('Invalid guess coordinates.');
    }
    guess = { lat, lng };
  }

  const loc = locations[round];
  const distance = guess ? distanceMeters(guess, loc) : null;
  game.results.push({
    guess,
    distance,
    points: guess ? scoreForDistance(distance) : 0,
    timedOut: Boolean(body.timedOut),
    answer: { name: loc.name, lat: loc.lat, lng: loc.lng, funFact: loc.funFact ?? null },
  });
  await saveGame(date, player, game);

  const commands = [];
  const name = cleanName(body.name);
  if (name) commands.push(['HSET', 'names', player, name]);
  const finished = game.results.length >= locations.length;
  if (finished) {
    commands.push(['ZADD', `lb:${date}`, totalPoints(game), player]);
    commands.push(['EXPIRE', `lb:${date}`, LEADERBOARD_TTL]);
  }
  if (commands.length) await pipeline(commands);

  return json(response(game, round, locations.length));
});

function response(game, round, roundCount) {
  return {
    round,
    result: game.results[round],
    finished: game.results.length >= roundCount,
    total: totalPoints(game),
  };
}
