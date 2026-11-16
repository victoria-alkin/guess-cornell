// Private admin API, used by /admin. Everything needs the admin password,
// which lives only in the ADMIN_PASSWORD environment variable (set in Vercel).
//
//   POST { action: 'login', password }         -> sets a 12-hour session cookie
//   POST { action: 'logout' }
//   GET  ?view=board&date=YYYY-MM-DD            -> that day's full leaderboard, with player ids
//   GET  ?view=puzzles                          -> every spot (with answers) and the stored days around today
//   POST { action: 'removeScore', date, player }
//   POST { action: 'rename', player, name }
//   POST { action: 'clearName', player }
//   POST { action: 'setDay', date, ids: [5 location ids] }
//   POST { action: 'hide' | 'unhide', date, player }  -> off that day's leaderboard for everyone but them
//   POST { action: 'setPublicName', date, player, name } / { action: 'clearPublicName', date, player }
//                                                      -> the name everyone but them sees that day

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  addDays, allLocations, buildingKey, isDate, puzzleNumber, ROUNDS_PER_DAY, todayDate,
} from './_lib/daily.js';
import { cleanName, error, isPlayerId, json, readJson, route } from './_lib/http.js';
import { pipeline, redis } from './_lib/store.js';

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
