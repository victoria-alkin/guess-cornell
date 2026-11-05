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

function seededShuffle(items, seed) {
  let a = seed || 1;
  const rand = () => { // mulberry32
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  const recent = new Set();
  for (let i = 1; i <= AVOID_RECENT_DAYS; i++) {
    const prev = await redis('GET', `day:${addDays(date, -i)}`);
    if (prev) JSON.parse(prev).forEach((id) => recent.add(id));
  }
  const fresh = all.filter((l) => !recent.has(l.id));
  const pool = fresh.length >= ROUNDS_PER_DAY ? fresh : all;
  const sorted = [...pool].sort((a, b) => (a.id < b.id ? -1 : 1));
  const ids = seededShuffle(sorted, hashString(`guess-cornell:${date}`))
    .slice(0, ROUNDS_PER_DAY)
    .map((l) => l.id);

  await redis('SET', key, JSON.stringify(ids), 'NX', 'EX', DAY_KEY_TTL);
  return JSON.parse(await redis('GET', key)); // whoever stored first wins
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
