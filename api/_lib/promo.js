// Giveaways. On a giveaway day every finished puzzle gets the next play number
// (1st, 2nd, 3rd... to finish), and a few special Cornell numbers win a prize.
// The day before, players see an announcement. Dates are puzzle days in Ithaca.
//
// The winning numbers stay on the server: players only learn them after finishing.

import { randomInt } from 'node:crypto';
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
      21: 'the number of bells in the Cornell Chimes',
      65: 'for 1865, the year Cornell was founded',
      70: "the number on Touchdown the Bear's jersey, honoring the Class of 1970, which funded mascot expenses",
      161: "the number of steps to the top of McGraw Tower, and the number of items on Cornell's famous bucket list",
      173: 'the height of McGraw Tower in feet',
    },
    // play number -> a special picture on that winner's screen (drawn in public/js/game.js)
    art: { 70: 'jersey', 161: 'tower' },
  },
];

const KEY_TTL = 60 * 60 * 24 * 60; // keep giveaway records for 60 days
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

const key = (promo, part) => `promo:${promo.id}:${part}`;

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

// The winning number a non-winner is compared with: the last one before them,
// or the first one if they finished before any winner.
function nearestWinning(promo, n) {
  const wins = Object.keys(promo.numbers).map(Number).sort((a, b) => a - b);
  return wins.filter((w) => w < n).pop() ?? wins[0];
}

/** The result screen's data for play number n (also used by admin previews). */
export function resultFor(promo, n, code = null) {
  const base = { n, prize: promo.prize, email: promo.email };
  if (promo.numbers[n]) return { ...base, won: true, why: promo.numbers[n], art: promo.art?.[n] ?? null, code };
  const near = nearestWinning(promo, n);
  return { ...base, won: false, nearest: near, nearestWhy: promo.numbers[near], nearestArt: promo.art?.[near] ?? null };
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

  const n = Number(await redis('INCR', key(promo, 'count')));
  await redis('EXPIRE', key(promo, 'count'), KEY_TTL);
  const code = promo.numbers[n] ? newCode() : null;
  const result = resultFor(promo, n, code);
  if (result.won) {
    await redis('HSET', key(promo, 'winners'), String(n), JSON.stringify({ player, name: name || null, code, at: Date.now() }));
    await redis('EXPIRE', key(promo, 'winners'), KEY_TTL);
  }
  await redis('SET', entryKey, JSON.stringify(result), 'EX', KEY_TTL);
  return result;
}

/** Admin view: every giveaway with its numbers, how many have played, and the winners so far. */
export async function promoStatus() {
  const out = [];
  for (const promo of PROMOTIONS) {
    const [count, flat] = [await redis('GET', key(promo, 'count')), await redis('HGETALL', key(promo, 'winners'))];
    const winners = [];
    for (let i = 0; i < (flat || []).length; i += 2) winners.push({ n: Number(flat[i]), ...JSON.parse(flat[i + 1]) });
    winners.sort((a, b) => a.n - b.n);
    out.push({ ...promo, count: Number(count) || 0, winners });
  }
  return out;
}
