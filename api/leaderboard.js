// GET /api/leaderboard?player=<id>&date=YYYY-MM-DD[&limit=N]
// Scores for a day (today by default), best first, plus the asking player's own
// rank. Without a limit, every player is listed.
//
// Moderation (set from /admin) for one day, applied for everyone except the
// player themselves, so they don't notice anything:
//   hash "hidden:{date}"      player -> 1      left off that day's leaderboard
//   hash "publicnames:{date}" player -> name   shown under this name that day

import { isDate, puzzleNumber, todayDate } from './_lib/daily.js';
import { isPlayerId, json, route } from './_lib/http.js';
import { pipeline } from './_lib/store.js';

export const GET = route(async (request) => {
  const params = new URL(request.url).searchParams;
  const today = todayDate();
  const date = isDate(params.get('date')) && params.get('date') <= today ? params.get('date') : today;
  const asked = Number.parseInt(params.get('limit'), 10);
  const player = isPlayerId(params.get('player')) ? params.get('player') : null;
  const key = `lb:${date}`;

  const [hiddenAll, count, myRank, myScore] = await pipeline([
    ['HKEYS', `hidden:${date}`],
    ['ZCARD', key],
    ['ZREVRANK', key, player ?? '-'],
    ['ZSCORE', key, player ?? '-'],
  ]);

  // Hidden players who are on this day's board (never hide someone from themselves).
  const hiddenOthers = (hiddenAll || []).filter((id) => id !== player);
  const hiddenRanks = hiddenOthers.length
    ? await pipeline(hiddenOthers.map((id) => ['ZREVRANK', key, id]))
    : [];
  const hidden = new Set(hiddenOthers.filter((_, i) => hiddenRanks[i] !== null));
  const hiddenAbove = (rank) => hiddenRanks.filter((r) => r !== null && Number(r) < rank).length;

  const stop = asked > 0 ? asked - 1 + hidden.size : -1; // -1 = to the end
  const [flat] = await pipeline([['ZRANGE', key, 0, stop, 'REV', 'WITHSCORES']]);
  const ids = [];
  const scores = [];
  for (let i = 0; i < flat.length; i += 2) {
    if (hidden.has(flat[i])) continue;
    ids.push(flat[i]);
    scores.push(Number(flat[i + 1]));
  }
  if (asked > 0) { ids.length = Math.min(ids.length, asked); scores.length = ids.length; }

  const nameIds = player && !ids.includes(player) ? [...ids, player] : ids;
  const [names, publicNames] = nameIds.length
    ? await pipeline([['HMGET', 'names', ...nameIds], ['HMGET', `publicnames:${date}`, ...nameIds]])
    : [[], []];
  const nameOf = (id) => {
    const i = nameIds.indexOf(id);
    return (id !== player && publicNames[i]) || names[i] || 'Anonymous Wanderer';
  };

  // Equal scores share a rank (1, 2, 2, 4...).
  const top = [];
  ids.forEach((id, i) => {
    const rank = i > 0 && scores[i] === scores[i - 1] ? top[i - 1].rank : i + 1;
    top.push({ rank, name: nameOf(id), score: scores[i], you: id === player });
  });

  let you = null;
  if (player && myRank !== null && myScore !== null) {
    const inTop = top.find((t) => t.you);
    const rank = inTop ? inTop.rank : Number(myRank) + 1 - hiddenAbove(Number(myRank));
    you = { rank, score: Number(myScore), name: nameOf(player) };
  }

  return json({ date, number: puzzleNumber(date), players: Number(count) - hidden.size, top, you });
});
