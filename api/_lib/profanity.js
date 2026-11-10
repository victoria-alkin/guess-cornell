// Checks player names with PurgoMalum (https://www.purgomalum.com), a free
// profanity-filter web service, so no word list lives in this app.
// If the service is slow or down, the name is allowed rather than blocking play.

const ENDPOINT = 'https://www.purgomalum.com/service/containsprofanity';
// The first request from a fresh server can be slow, so wait a while and retry once.
const ATTEMPT_TIMEOUTS_MS = [5000, 4000];

export async function isProfane(text) {
  for (const timeout of ATTEMPT_TIMEOUTS_MS) {
    try {
      const res = await fetch(`${ENDPOINT}?text=${encodeURIComponent(text)}`, {
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) return (await res.text()).trim() === 'true';
    } catch {
      // timed out or unreachable: try again
    }
  }
  return false;
}

export const NAME_NOT_ALLOWED = "That name isn't allowed. Please pick a different one.";
