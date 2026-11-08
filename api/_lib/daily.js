// Daily puzzle logic: which locations are in today's puzzle, and players' progress.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { redis } from './store.js';

export const ROUNDS_PER_DAY = 5;
export const TIME_ZONE = 'America/New_York'; // the day resets at midnight in Ithaca
export const LAUNCH_DATE = '2026-11-05'; // puzzle #1

const DAY_KEY_TTL = 60 * 60 * 24 * 30; // keep each day's picks for 30 days
const GAME_TTL = 60 * 60 * 24 * 3; // a player's in-progress game
const AVOID_RECENT_DAYS = 7;
const MIN_POOL = ROUNDS_PER_DAY + 3; // leave some choice for the mix below

// Difficulty mix. Each location may have a rating from 1 (easy) to 10 (hard);
// unrated ones count as average. A day's picks should average close to the
// overall average and include both easier and harder spots.
const DIFFICULTY_TOLERANCE = 0.75; // allowed gap between a day's average and the overall average
const EDGE = 1.5; // "easier"/"harder" = at least this far below/above the average
const CANDIDATES = 400; // random draws to try before settling for the closest

// Indoor/outdoor mix: at least this many of each per day (when available),
// and the first round is outdoor this often.
const MIN_EACH_SETTING = 2;
const OUTDOOR_FIRST_CHANCE = 0.7;

// Same building: names starting with the same two words ("Baker Laboratory
// 200" / "Baker Laboratory 219"). Such pairs are avoided most days but
// allowed (one pair at most) on some.
const SAME_BUILDING_ALLOWED_CHANCE = 0.25;

// ---------- Dates ----------

/** Today's date in Ithaca as YYYY-MM-DD. */
export function todayDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function puzzleNumber(date) {
  return Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${LAUNCH_DATE}T12:00:00Z`)) / 86400000) + 1;
}

/** Timestamp (ms) of the next midnight in Ithaca. */
export function nextResetAt(now = Date.now()) {
  const today = todayDate(new Date(now));
  let t = now + 3600_000;
  while (todayDate(new Date(t)) === today) t += 3600_000; // first hour past midnight
  let lo = t - 3600_000;
  while (t - lo > 1000) { // narrow down to the second
    const mid = Math.floor((lo + t) / 2);
    if (todayDate(new Date(mid)) === today) lo = mid; else t = mid;
  }
  return t;
}

// ---------- Locations ----------

let cache = null;

/** All locations, including answers. Server-only: never send this to browsers. */
export function allLocations() {
  if (!cache) {
    const file = path.join(process.cwd(), 'data', 'locations.json');
    const list = JSON.parse(readFileSync(file, 'utf8'));
    cache = list.filter((l) => l && l.id && Number.isFinite(l.lat) && Number.isFinite(l.lng));
  }
  return cache;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function seededRandom(seed) {
  let a = seed || 1;
  return () => { // mulberry32
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The location ids for a day's puzzle. Picked once and stored, so adding new
 * locations mid-day never changes a puzzle people are already playing.
 * Locations used in the past week are avoided when there are enough others.
 */
export async function dailyIds(date) {
  const key = `day:${date}`;
  const stored = await redis('GET', key);
  if (stored) return JSON.parse(stored);

  const all = allLocations();
  // Skip spots from recent days: a whole week if there are enough locations,
  // otherwise as many days back as still leaves room to mix.
  const pastDays = [];
  for (let i = 1; i <= AVOID_RECENT_DAYS; i++) {
    const prev = await redis('GET', `day:${addDays(date, -i)}`);
    pastDays.push(prev ? JSON.parse(prev) : []);
  }
  let pool = all;
  for (let days = AVOID_RECENT_DAYS; days >= 1; days--) {
    const recent = new Set(pastDays.slice(0, days).flat());
    const fresh = all.filter((l) => !recent.has(l.id));
    if (fresh.length >= MIN_POOL) { pool = fresh; break; }
  }
  const sorted = [...pool].sort((a, b) => (a.id < b.id ? -1 : 1));
  const ids = pickMixed(sorted, all, seededRandom(hashString(`guess-cornell:${date}`)))
    .map((l) => l.id);

  await redis('SET', key, JSON.stringify(ids), 'NX', 'EX', DAY_KEY_TTL);
  return JSON.parse(await redis('GET', key)); // whoever stored first wins
}

/**
 * Pick a day's locations from `pool` with a balanced mix of difficulties and
 * of indoor/outdoor spots:
 * random draws, keeping the first that averages near the overall average and
 * includes at least one clearly easier and one clearly harder spot; if none
 * does, the draw that comes closest.
 */
export function pickMixed(pool, all, rand) {
  const count = Math.min(ROUNDS_PER_DAY, pool.length);
  const rated = all.map((l) => Number(l.difficulty)).filter((d) => d >= 1 && d <= 10);
  const target = rated.length ? rated.reduce((s, d) => s + d, 0) / rated.length : 5;
  const difficulty = (l) => {
    const d = Number(l.difficulty);
    return d >= 1 && d <= 10 ? d : target;
  };
  const isEasy = (d) => d <= target - EDGE;
  const isHard = (d) => d >= target + EDGE;
  const poolLevels = pool.map(difficulty);
  const wantEasy = poolLevels.some(isEasy); // only ask for what the pool can give
  const wantHard = poolLevels.some(isHard);
  const wantIndoor = Math.min(MIN_EACH_SETTING, pool.filter((l) => l.indoor === true).length);
  const wantOutdoor = Math.min(MIN_EACH_SETTING, pool.filter((l) => l.indoor === false).length);

  const maxSameBuilding = rand() < SAME_BUILDING_ALLOWED_CHANCE ? 1 : 0;

  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < CANDIDATES; i++) {
    const pick = shuffle(pool, rand).slice(0, count);
    const levels = pick.map(difficulty);
    const avg = levels.reduce((s, d) => s + d, 0) / levels.length;
    const gap = Math.abs(avg - target);
    const missing = (wantEasy && !levels.some(isEasy)) + (wantHard && !levels.some(isHard))
      + Math.max(0, wantIndoor - pick.filter((l) => l.indoor === true).length)
      + Math.max(0, wantOutdoor - pick.filter((l) => l.indoor === false).length)
      + Math.max(0, sameBuildingPairs(pick) - maxSameBuilding);
    if (gap <= DIFFICULTY_TOLERANCE && !missing) return orderRounds(pick, rand);
    const score = Math.max(0, gap - DIFFICULTY_TOLERANCE) + missing;
    if (score < bestScore) { best = pick; bestScore = score; }
  }
  return orderRounds(best, rand);
}

// Spots whose name mentions one of these belong to that building, wherever the
// word appears (e.g. "Ezra Cornell's Tomb Inside Sage Chapel Crypt").
const NAMED_BUILDINGS = ['sage chapel', 'barton'];

function buildingKey(l) {
  const name = String(l.name || '').toLowerCase();
  const named = NAMED_BUILDINGS.find((b) => name.includes(b));
  return named || name.split(/\s+/).slice(0, 2).join(' ');
}

export function sameBuilding(a, b) {
  return buildingKey(a) === buildingKey(b);
}

function sameBuildingPairs(pick) {
  let pairs = 0;
  for (let i = 0; i < pick.length; i++) {
    for (let j = i + 1; j < pick.length; j++) if (sameBuilding(pick[i], pick[j])) pairs++;
  }
  return pairs;
}

/** Usually start outdoors (a gentler first round), sometimes indoors. */
function orderRounds(pick, rand) {
  const wantOutdoor = rand() < OUTDOOR_FIRST_CHANCE;
  const first = pick.findIndex((l) => l.indoor === !wantOutdoor);
  if (first <= 0) return pick;
  const out = [...pick];
  [out[0], out[first]] = [out[first], out[0]];
  return out;
}

export async function dailyLocations(date) {
  const byId = new Map(allLocations().map((l) => [l.id, l]));
  return (await dailyIds(date)).map((id) => byId.get(id)).filter(Boolean);
}

// ---------- Player progress ----------

const gameKey = (date, player) => `game:${date}:${player}`;

export async function loadGame(date, player) {
  const raw = await redis('GET', gameKey(date, player));
  return raw ? JSON.parse(raw) : { results: [] };
}

export async function saveGame(date, player, game) {
  await redis('SET', gameKey(date, player), JSON.stringify(game), 'EX', GAME_TTL);
}

export const totalPoints = (game) => game.results.reduce((s, r) => s + r.points, 0);
