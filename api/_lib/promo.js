// Giveaways. On a giveaway day every finished puzzle gets the next play number
// (1st, 2nd, 3rd... to finish), and a few special Cornell numbers win a prize.
// The day before, players see an announcement. Dates are puzzle days in Ithaca.
//
// The winning numbers stay on the server: players only learn them after finishing.
//
// A giveaway can also have one "showcase" number, kept apart from the real
// winning numbers: no player ever gets it. Right after the player before it
// finishes, an automatic player plays the puzzle and takes it, so /admin can
// show (and save a picture of) a real winner screen to post afterwards.
// Non-winners are still compared with it like any other winning number.

import { randomInt } from 'node:crypto';
import { distanceMeters, scoreForDistance } from '../../public/js/scoring.js';
import { dailyLocations, saveGame, totalPoints } from './daily.js';
import { redis } from './store.js';

export const PROMOTIONS = [
  {
    id: 'ctb-2026-11',
    announce: '2026-11-17', // "tomorrow" screen
    date: '2026-11-18', // giveaway day
    prize: '$5 Collegetown Bagels gift card',
    email: 'guesscornell@gmail.com',
    // play number -> why it's a Cornell number (finishes the sentence "#161 is ...")
    numbers: {
      70: "the number on Touchdown the Bear's jersey, honoring the Class of 1970, which funded mascot expenses",
      270: 'the length in feet of the Fall Creek Gorge suspension bridge',
      125: 'the number of years of the Dragon Day tradition, celebrated in 2026',
      161: "the number of steps to the top of McGraw Tower, and the number of items on Cornell's famous bucket list",
      412: "the number of students in Cornell's inaugural class in 1868",
    },
    // play number -> a special picture on that winner's screen (drawn in public/js/game.js)
    art: { 70: 'jersey', 125: 'dragon', 161: 'tower', 270: 'bridge', 412: 'classPhoto' },
    // Taken by the automatic player, never by a real one (not one of the five above).
    // e.g. showcase: { n: 200, why: '...finishes "#200 is ..."', art: null }  (off until the number is picked)
    showcase: null,
  },
];

const KEY_TTL = 60 * 60 * 24 * 60; // keep giveaway records for 60 days
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

const key = (promo, part) => `promo:${promo.id}:${part}`;

/** The automatic player's id (a valid player id that no browser will ever generate). */
export const SHOWCASE_PLAYER = '00000000-0000-4000-8000-0000005c0ca5';

/** The giveaway that's announced or running on this date, if any. */
export function promoOn(date) {
  for (const promo of PROMOTIONS) {
    if (date === promo.date) return { promo, stage: 'live' };
    if (date === promo.announce) return { promo, stage: 'announce' };
  }
  return null;
}

/** What players may see before playing (no winning numbers). */
export function publicPromo(date) {
  const on = promoOn(date);
  if (!on) return null;
  const { promo, stage } = on;
  return { stage, date: promo.date, prize: promo.prize, winners: Object.keys(promo.numbers).length };
}

// Every number that shows a winner screen: the real ones plus the showcase.
const winningNumbers = (promo) => [...Object.keys(promo.numbers).map(Number), ...(promo.showcase ? [promo.showcase.n] : [])];
const whyFor = (promo, n) => promo.numbers[n] ?? (promo.showcase?.n === n ? promo.showcase.why : null);
const artFor = (promo, n) => promo.art?.[n] ?? (promo.showcase?.n === n ? promo.showcase.art : null) ?? null;

// The winning number a non-winner is compared with (the showcase counts too): the last one before them,
// or the first one if they finished before any winner.
function nearestWinning(promo, n) {
  const wins = winningNumbers(promo).sort((a, b) => a - b);
  return wins.filter((w) => w < n).pop() ?? wins[0];
}

/** The result screen's data for play number n (also used by admin previews). */
export function resultFor(promo, n, code = null) {
  const base = { n, prize: promo.prize, email: promo.email };
  if (whyFor(promo, n)) return { ...base, won: true, why: whyFor(promo, n), art: artFor(promo, n), code };
  const near = nearestWinning(promo, n);
  return { ...base, won: false, nearest: near, nearestWhy: whyFor(promo, near), nearestArt: artFor(promo, near) };
}

const newCode = () => Array.from({ length: 6 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');

/**
 * Give a player who just finished the giveaway day's puzzle their play number.
 * Each player gets one number, however many times this is called.
 */
export async function enterPromo(date, player, name) {
  const on = promoOn(date);
  if (!on || on.stage !== 'live') return null;
  const { promo } = on;
  const entryKey = key(promo, `entry:${player}`);
  const existing = await redis('GET', entryKey);
  if (existing) return existing === 'pending' ? null : JSON.parse(existing);
  if (!(await redis('SET', entryKey, 'pending', 'NX', 'EX', KEY_TTL))) return null; // a duplicate request got here first

  let n = await nextNumber(promo);
  // The showcase number is the automatic player's: it plays now, and this player gets the next number.
  if (promo.showcase?.n === n) {
    try { await playShowcase(promo, date, n); } catch (err) { console.error('showcase', err); }
    n = await nextNumber(promo);
  }
  const code = promo.numbers[n] ? newCode() : null;
  const result = resultFor(promo, n, code);
  if (result.won) {
    await redis('HSET', key(promo, 'winners'), String(n), JSON.stringify({ player, name: name || null, code, at: Date.now() }));
    await redis('EXPIRE', key(promo, 'winners'), KEY_TTL);
  }
  await redis('SET', entryKey, JSON.stringify(result), 'EX', KEY_TTL);
  return result;
}

async function nextNumber(promo) {
  const n = Number(await redis('INCR', key(promo, 'count')));
  await redis('EXPIRE', key(promo, 'count'), KEY_TTL);
  return n;
}

// The automatic player: guesses a short walk from each answer and is scored like
// anyone else. It goes on the leaderboard with no name ("Anonymous Wanderer").
// Its winner screen is saved for /admin.
async function playShowcase(promo, date, n) {
  const locations = await dailyLocations(date);
  const results = locations.map((loc) => {
    const off = 15 + Math.random() * 60; // metres
    const angle = Math.random() * 2 * Math.PI;
    const guess = {
      lat: loc.lat + (off * Math.cos(angle)) / 111320,
      lng: loc.lng + (off * Math.sin(angle)) / (111320 * Math.cos((loc.lat * Math.PI) / 180)),
    };
    const distance = distanceMeters(guess, loc);
    return {
      guess, distance, points: scoreForDistance(distance), timedOut: false,
      answer: { name: loc.name, lat: loc.lat, lng: loc.lng, funFact: loc.funFact ?? null },
    };
  });
  const result = resultFor(promo, n, newCode());
  const game = { results, promo: result, showcase: true };
  await saveGame(date, SHOWCASE_PLAYER, game);
  await redis('ZADD', `lb:${date}`, totalPoints(game), SHOWCASE_PLAYER);
  await redis('EXPIRE', `lb:${date}`, 60 * 60 * 24 * 400);
  await redis('SET', key(promo, 'showcase'), JSON.stringify({ ...result, player: SHOWCASE_PLAYER, total: totalPoints(game), at: Date.now() }), 'EX', KEY_TTL);
  await redis('SET', key(promo, `entry:${SHOWCASE_PLAYER}`), JSON.stringify(result), 'EX', KEY_TTL);
}

/** The automatic player's saved result, once it has played. */
export async function showcaseResult(promo) {
  const raw = await redis('GET', key(promo, 'showcase'));
  return raw ? JSON.parse(raw) : null;
}

/** Admin view: every giveaway with its numbers, how many have played, and the winners so far. */
export async function promoStatus() {
  const out = [];
  for (const promo of PROMOTIONS) {
    const [count, flat] = [await redis('GET', key(promo, 'count')), await redis('HGETALL', key(promo, 'winners'))];
    const winners = [];
    for (let i = 0; i < (flat || []).length; i += 2) winners.push({ n: Number(flat[i]), ...JSON.parse(flat[i + 1]) });
    winners.sort((a, b) => a.n - b.n);
    out.push({ ...promo, count: Number(count) || 0, winners, showcasePlayed: await showcaseResult(promo) });
  }
  return out;
}
