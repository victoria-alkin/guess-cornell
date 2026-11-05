// GET /api/daily?player=<id>
// Today's puzzle: photos only (no answers), plus this player's progress so a
// reload resumes where they left off and a finished puzzle can't be replayed.

import {
  dailyLocations, loadGame, nextResetAt, puzzleNumber, todayDate, totalPoints,
} from './_lib/daily.js';
import { isPlayerId, json, route } from './_lib/http.js';

export const GET = route(async (request) => {
  const player = new URL(request.url).searchParams.get('player');
  const date = todayDate();
  const locations = await dailyLocations(date);
  const game = isPlayerId(player) ? await loadGame(date, player) : { results: [] };

  return json({
    date,
    number: puzzleNumber(date),
    nextPuzzleAt: nextResetAt(),
    rounds: locations.map((l) => ({ image: l.image ?? null, startYaw: l.startYaw ?? null })),
    results: game.results,
    finished: locations.length > 0 && game.results.length >= locations.length,
    total: totalPoints(game),
  });
});
