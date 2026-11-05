// Tiny Redis client.
//  - Production: Upstash Redis over its REST API (env vars added by the Vercel
//    Upstash integration).
//  - Local development (no env vars, not on Vercel): an in-memory stand-in, so
//    `npm start` works without any accounts. Data resets when the server stops.

// The integration may add a custom prefix (e.g. STORAGE_KV_REST_API_URL), so
// match on the suffix. The read-only token is deliberately not used.
function envBySuffix(suffixes) {
  for (const suffix of suffixes) {
    const name = Object.keys(process.env).find((k) => k === suffix || k.endsWith(`_${suffix}`));
    if (name && process.env[name]) return process.env[name];
  }
  return undefined;
}
const URL_ = envBySuffix(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']);
const TOKEN = envBySuffix(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']);

export class StoreNotConfigured extends Error {}

/** Run several Redis commands in one round trip. Returns their results in order. */
export async function pipeline(commands) {
  if (URL_ && TOKEN) return upstash(commands);
  if (process.env.VERCEL) {
    // Names only (never values), to help diagnose a misconfigured integration.
    const seen = Object.keys(process.env).filter((k) => /KV|REDIS|UPSTASH/i.test(k));
    throw new StoreNotConfigured(
      `Leaderboard storage is not connected (Upstash env vars missing in ${process.env.VERCEL_ENV}). ` +
      `Related variables found: ${seen.length ? seen.join(', ') : 'none'}.`,
    );
  }
  return commands.map((c) => memory(c));
}

/** Run one Redis command. */
export async function redis(...command) {
  return (await pipeline([command]))[0];
}

async function upstash(commands) {
  const res = await fetch(`${URL_.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands.map((c) => c.map(String))),
  });
  if (!res.ok) throw new Error(`Upstash HTTP ${res.status}: ${await res.text()}`);
  const out = await res.json();
  return out.map((r, i) => {
    if (r.error) throw new Error(`Redis ${commands[i][0]} failed: ${r.error}`);
    return r.result;
  });
}

// ---------- In-memory stand-in (only the commands this app uses) ----------

const mem = (globalThis.__guessCornellMem ??= new Map());

function zset(key) {
  if (!mem.has(key)) mem.set(key, new Map());
  return mem.get(key);
}

function zsorted(key) {
  // Same order as Redis REV: score desc, then member desc.
  return [...zset(key)].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
}

function memory([cmd, key, ...args]) {
  switch (cmd.toUpperCase()) {
    case 'GET': return mem.has(key) ? mem.get(key) : null;
    case 'SET': {
      const nx = args.map((a) => String(a).toUpperCase()).includes('NX');
      if (nx && mem.has(key)) return null;
      mem.set(key, String(args[0]));
      return 'OK';
    }
    case 'EXPIRE': return 1;
    case 'HSET': {
      if (!mem.has(key)) mem.set(key, new Map());
      for (let i = 0; i < args.length; i += 2) mem.get(key).set(String(args[i]), String(args[i + 1]));
      return 1;
    }
    case 'HGET': return mem.get(key)?.get(String(args[0])) ?? null;
    case 'HMGET': return args.map((f) => mem.get(key)?.get(String(f)) ?? null);
    case 'ZADD': {
      zset(key).set(String(args[1]), Number(args[0]));
      return 1;
    }
    case 'ZSCORE': {
      const s = zset(key).get(String(args[0]));
      return s === undefined ? null : String(s);
    }
    case 'ZCARD': return zset(key).size;
    case 'ZREVRANK': {
      const i = zsorted(key).findIndex(([m]) => m === String(args[0]));
      return i < 0 ? null : i;
    }
    case 'ZRANGE': {
      // Only the form used here: ZRANGE key start stop REV WITHSCORES
      const [start, stop] = [Number(args[0]), Number(args[1])];
      return zsorted(key).slice(start, stop + 1).flatMap(([m, s]) => [m, String(s)]);
    }
    default:
      throw new Error(`In-memory store does not support ${cmd}`);
  }
}
