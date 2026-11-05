// Talks to the server (api/*.js) and remembers who this player is.
// No sign-up: a random player id and the chosen name are kept in this browser.

const PLAYER_KEY = 'guesscornell.player';
const NAME_KEY = 'guesscornell.name';
let fallbackPlayer = null;

export function playerId() {
  try {
    let id = localStorage.getItem(PLAYER_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(PLAYER_KEY, id);
    }
    return id;
  } catch {
    // Storage blocked (e.g. some private modes): works for this visit only.
    return (fallbackPlayer ??= crypto.randomUUID());
  }
}

export function savedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}

export function saveName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function request(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection and try again.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(data?.error || `Server error (${res.status}).`, res.status);
  return data;
}

const post = (path, body) => request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ player: playerId(), ...body }),
});

/** Today's puzzle (photos only) and this player's progress. */
export const getDaily = () => request(`/api/daily?player=${playerId()}`);

/** Score one round; returns the answer and points. */
export const sendGuess = (body) => post('/api/guess', body);

export const getLeaderboard = (limit = 50) =>
  request(`/api/leaderboard?player=${playerId()}&limit=${limit}`);

export const updateName = (name) => post('/api/name', { name });
