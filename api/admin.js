// Private admin API, used by /admin. Everything needs the admin password,
// which lives only in the ADMIN_PASSWORD environment variable (set in Vercel).
//
//   POST { action: 'login', password }         -> sets a 12-hour session cookie
//   POST { action: 'logout' }
//   GET  ?view=board&date=YYYY-MM-DD            -> that day's full leaderboard, with player ids
//   GET  ?view=puzzles                          -> every spot (with answers) and the stored days around today
//   GET  ?view=promo                            -> giveaways: numbers, plays so far, winners and claim codes
//   GET  ?view=promoPreview&stage=...&n=...     -> data for previewing a giveaway screen in the game
//                                                 (stage=showcase: the automatic player's winner screen)
//   POST { action: 'removeScore', date, player }
//   POST { action: 'rename', player, name }
//   POST { action: 'clearName', player }
//   POST { action: 'setDay', date, ids: [5 location ids] }
//   POST { action: 'hide' | 'unhide', date, player }  -> off that day's leaderboard for everyone but them
//   POST { action: 'setPublicName', date, player, name } / { action: 'clearPublicName', date, player }
//                                                      -> the name everyone but them sees that day
//   POST { action: 'rescore', date, apply }     -> re-score that day's games against the current pins
//                                                  (after a pin moves); apply: false only previews

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { distanceMeters, scoreForDistance } from '../public/js/scoring.js';
import {
  addDays, allLocations, buildingKey, dailyLocations, isDate, puzzleNumber, ROUNDS_PER_DAY, todayDate,
} from './_lib/daily.js';
import { cleanName, error, isPlayerId, json, readJson, route } from './_lib/http.js';
import { pipeline, redis } from './_lib/store.js';
import { promoStatus, resultFor } from './_lib/promo.js';

const COOKIE = 'gc_admin';
const SESSION_SECONDS = 60 * 60 * 12;
const MAX_FAILED_LOGINS = 10; // per IP address, per 15 minutes
const FAILED_WINDOW_SECONDS = 60 * 15;
const DAY_KEY_TTL = 60 * 60 * 24 * 30;
const DAYS_BACK = 30;
const DAYS_AHEAD = 14;

const password = () => process.env.ADMIN_PASSWORD || '';

// The session cookie is "<expiry>.<signature>", signed with the password itself,
// so changing the password signs everyone out.
const sign = (exp) => createHmac('sha256', password()).update(`guess-cornell-admin:${exp}`).digest('base64url');
const sameText = (a, b) => timingSafeEqual(
  createHash('sha256').update(String(a)).digest(),
  createHash('sha256').update(String(b)).digest(),
);

function signedIn(request) {
  if (!password()) return false;
  const cookie = (request.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!cookie) return false;
  const [exp, sig] = cookie.slice(COOKIE.length + 1).split('.');
  return Number(exp) > Date.now() / 1000 && Boolean(sig) && sameText(sig, sign(exp));
}

function sessionCookie(request, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

const clientIp = (request) =>
  (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';

const NOT_SET_UP = 'The admin page is not set up yet: add an ADMIN_PASSWORD environment variable in Vercel and redeploy.';
const SIGN_IN = 'Please sign in.';

export const GET = route(async (request) => {
  if (!password()) return error(NOT_SET_UP, 503);
  if (!signedIn(request)) return error(SIGN_IN, 401);
  const params = new URL(request.url).searchParams;
  const view = params.get('view');
  if (view === 'board') return board(params.get('date'));
  if (view === 'puzzles') return puzzles();
  if (view === 'promo') return json({ today: todayDate(), promos: await promoStatus() });
  if (view === 'promoPreview') return promoPreview(params);
  return error('Unknown view.');
});

export const POST = route(async (request) => {
  if (!password()) return error(NOT_SET_UP, 503);
  if (!(request.headers.get('content-type') || '').includes('application/json')) return error('Expected JSON.');
  const body = await readJson(request);
  if (!body) return error('Invalid request body.');

  if (body.action === 'login') return login(request, body.password);
  if (body.action === 'logout') {
    const res = json({ ok: true });
    res.headers.set('Set-Cookie', sessionCookie(request, '', 0));
    return res;
  }
  if (!signedIn(request)) return error(SIGN_IN, 401);

  switch (body.action) {
    case 'removeScore': {
      if (!isDate(body.date) || !isPlayerId(body.player)) return error('Missing date or player.');
      return json({ removed: await redis('ZREM', `lb:${body.date}`, body.player) });
    }
    case 'rename': {
      const name = cleanName(body.name);
      if (!isPlayerId(body.player) || !name) return error('Missing player or name.');
      await redis('HSET', 'names', body.player, name);
      return json({ name });
    }
    case 'clearName': {
      if (!isPlayerId(body.player)) return error('Missing player.');
      return json({ cleared: await redis('HDEL', 'names', body.player) });
    }
    case 'hide': case 'unhide': {
      if (!isDate(body.date) || !isPlayerId(body.player)) return error('Missing date or player.');
      const key = `hidden:${body.date}`;
      await redis(...(body.action === 'hide' ? ['HSET', key, body.player, '1'] : ['HDEL', key, body.player]));
      return json({ ok: true });
    }
    case 'setPublicName': {
      const name = cleanName(body.name);
      if (!isDate(body.date) || !isPlayerId(body.player) || !name) return error('Missing date, player or name.');
      await redis('HSET', `publicnames:${body.date}`, body.player, name);
      return json({ name });
    }
    case 'clearPublicName': {
      if (!isDate(body.date) || !isPlayerId(body.player)) return error('Missing date or player.');
      await redis('HDEL', `publicnames:${body.date}`, body.player);
      return json({ ok: true });
    }
    case 'setDay': return setDay(body.date, body.ids);
    case 'rescore': return rescore(body.date, body.apply === true);
    default: return error('Unknown action.');
  }
});

async function login(request, given) {
  const failKey = `adminfail:${clientIp(request)}`;
  const failures = Number(await redis('GET', failKey)) || 0;
  if (failures >= MAX_FAILED_LOGINS) return error('Too many wrong passwords. Try again in 15 minutes.', 429);
  if (typeof given !== 'string' || !sameText(given, password())) {
    await pipeline([['INCR', failKey], ['EXPIRE', failKey, FAILED_WINDOW_SECONDS]]);
    return error('Wrong password.', 401);
  }
  await redis('DEL', failKey);
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const res = json({ ok: true });
  res.headers.set('Set-Cookie', sessionCookie(request, `${exp}.${sign(exp)}`, SESSION_SECONDS));
  return res;
}

async function board(date) {
  if (!isDate(date)) date = todayDate();
  const [flat, hiddenIds, publicFlat] = await pipeline([
    ['ZRANGE', `lb:${date}`, 0, -1, 'REV', 'WITHSCORES'],
    ['HKEYS', `hidden:${date}`],
    ['HGETALL', `publicnames:${date}`],
  ]);
  const ids = [];
  const scores = [];
  for (let i = 0; i < flat.length; i += 2) { ids.push(flat[i]); scores.push(Number(flat[i + 1])); }
  const hidden = new Set(hiddenIds || []);
  const publicNames = new Map();
  for (let i = 0; i < (publicFlat || []).length; i += 2) publicNames.set(publicFlat[i], publicFlat[i + 1]);
  const extra = (id) => ({ hidden: hidden.has(id), publicName: publicNames.get(id) ?? null });

  const names = ids.length ? await redis('HMGET', 'names', ...ids) : [];
  const players = ids.map((id, i) => ({ player: id, name: names[i] || null, score: scores[i], ...extra(id) }));
  return json({ date, number: puzzleNumber(date), today: todayDate(), players });
}

async function puzzles() {
  const today = todayDate();
  const dates = [];
  for (let i = -DAYS_BACK; i <= DAYS_AHEAD; i++) dates.push(addDays(today, i));
  const stored = await pipeline(dates.map((d) => ['GET', `day:${d}`]));
  const counts = await pipeline(dates.map((d) => ['ZCARD', `lb:${d}`]));
  const days = dates.map((date, i) => ({
    date,
    number: puzzleNumber(date),
    ids: stored[i] ? JSON.parse(stored[i]) : null,
    players: Number(counts[i]) || 0,
  }));
  const spots = allLocations().map((l) => ({
    id: l.id, name: l.name, image: l.image, lat: l.lat, lng: l.lng,
    indoor: l.indoor ?? null, difficulty: l.difficulty ?? null, funFact: l.funFact ?? null,
    startYaw: l.startYaw ?? null, startYawRange: l.startYawRange ?? null,
    building: buildingKey(l),
  }));
  return json({ today, rounds: ROUNDS_PER_DAY, days, spots });
}

async function setDay(date, ids) {
  if (!isDate(date)) return error('Missing or invalid date.');
  if (date < todayDate()) return error("That day has already passed.");
  const known = new Set(allLocations().map((l) => l.id));
  if (!Array.isArray(ids) || ids.length !== ROUNDS_PER_DAY || new Set(ids).size !== ids.length
    || !ids.every((id) => known.has(id))) {
    return error(`Pick ${ROUNDS_PER_DAY} different spots.`);
  }
  await redis('SET', `day:${date}`, JSON.stringify(ids), 'EX', DAY_KEY_TTL);
  return json({ date, ids });
}

// Games keep the pin they were scored against, so after a pin moves in
// locations.json, recompute any round whose stored answer is off the current
// pin, and update the leaderboard for finished games.
async function rescore(date, apply) {
  if (!isDate(date)) return error('Missing or invalid date.');
  if (date < addDays(todayDate(), -2)) return error('Games older than 3 days are no longer stored.');
  const locations = await dailyLocations(date);
  const keys = [];
  let cursor = '0';
  do {
    const [next, found] = await redis('SCAN', cursor, 'MATCH', `game:${date}:*`, 'COUNT', 1000);
    cursor = String(next);
    keys.push(...found);
  } while (cursor !== '0');
  const raws = keys.length ? await pipeline(keys.map((k) => ['GET', k])) : [];

  const writes = [];
  const changed = [];
  keys.forEach((key, i) => {
    if (!raws[i]) return;
    const game = JSON.parse(raws[i]);
    const before = game.results.reduce((s, r) => s + r.points, 0);
    let touched = false;
    game.results.forEach((r, round) => {
      const loc = locations[round];
      if (!loc || !r.answer || (r.answer.lat === loc.lat && r.answer.lng === loc.lng)) return;
      r.answer = { ...r.answer, lat: loc.lat, lng: loc.lng };
      r.distance = r.guess ? distanceMeters(r.guess, loc) : null;
      r.points = r.guess ? scoreForDistance(r.distance) : 0;
      touched = true;
    });
    if (!touched) return;
    const after = game.results.reduce((s, r) => s + r.points, 0);
    const player = key.slice(`game:${date}:`.length);
    const finished = game.results.length >= locations.length;
    changed.push({ player, before, after });
    writes.push(['SET', key, JSON.stringify(game), 'KEEPTTL']);
    if (finished) writes.push(['ZADD', `lb:${date}`, 'XX', after, player]);
  });
  if (apply) for (let i = 0; i < writes.length; i += 200) await pipeline(writes.slice(i, i + 200));
  return json({
    date,
    applied: apply,
    games: keys.length,
    changed: changed.length,
    up: changed.filter((c) => c.after > c.before).length,
    down: changed.filter((c) => c.after < c.before).length,
  });
}

// What the game shows for a giveaway screen, so /admin can preview it in the real game.
async function promoPreview(params) {
  const [promo] = await promoStatus();
  if (!promo) return error('No giveaway set up.');
  const stage = params.get('stage');
  const base = { date: promo.date, prize: promo.prize, winners: Object.keys(promo.numbers).length };
  if (stage === 'announce' || stage === 'live') return json({ promo: { ...base, stage } });
  if (stage === 'showcase') {
    // The automatic player's real winner screen (or a sample until it has played).
    if (!promo.showcase) return error('No showcase number set up.');
    const played = promo.showcasePlayed;
    return json({ promo: { ...base, stage: 'live' }, promoResult: played ?? resultFor(promo, promo.showcase.n, 'AB12CD'), played: Boolean(played) });
  }
  const n = Number.parseInt(params.get('n'), 10);
  if (!(n > 0)) return error('Pick a play number.');
  return json({ promo: { ...base, stage: 'live' }, promoResult: resultFor(promo, n, 'AB12CD') });
}
