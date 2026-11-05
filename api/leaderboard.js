// GET /api/leaderboard?player=<id>&date=YYYY-MM-DD&limit=50
// Top scores for a day (today by default), plus the asking player's own rank.

import { isDate, puzzleNumber, todayDate } from './_lib/daily.js';
import { isPlayerId, json, route } from './_lib/http.js';
import { pipeline, redis } from './_lib/store.js';

export const GET = route(async (request) => {
  const params = new URL(request.url).searchParams;
  const today = todayDate();
  const date = isDate(params.get('date')) && params.get('date') <= today ? params.get('date') : today;
  const limit = Math.min(Math.max(Number.parseInt(params.get('limit'), 10) || 50, 1), 100);
  const player = isPlayerId(params.get('player')) ? params.get('player') : null;
  const key = `lb:${date}`;

  const [flat, count, myRank, myScore] = await pipeline([
    ['ZRANGE', key, 0, limit - 1, 'REV', 'WITHSCORES'],
    ['ZCARD', key],
    ['ZREVRANK', key, player ?? '-'],
    ['ZSCORE', key, player ?? '-'],
  ]);

  const ids = [];
  const scores = [];
  for (let i = 0; i < flat.length; i += 2) {
    ids.push(flat[i]);
    scores.push(Number(flat[i + 1]));
  }
  const nameIds = player && !ids.includes(player) ? [...ids, player] : ids;
  const names = nameIds.length ? await redis('HMGET', 'names', ...nameIds) : [];
  const nameOf = (id) => names[nameIds.indexOf(id)] || 'Anonymous Wanderer';

  // Equal scores share a rank (1, 2, 2, 4...).
  const top = [];
  ids.forEach((id, i) => {
    const rank = i > 0 && scores[i] === scores[i - 1] ? top[i - 1].rank : i + 1;
    top.push({ rank, name: nameOf(id), score: scores[i], you: id === player });
  });

  let you = null;
  if (player && myRank !== null && myScore !== null) {
    const inTop = top.find((t) => t.you);
    you = { rank: inTop ? inTop.rank : Number(myRank) + 1, score: Number(myScore), name: nameOf(player) };
  }

  return json({ date, number: puzzleNumber(date), players: Number(count), top, you });
});
