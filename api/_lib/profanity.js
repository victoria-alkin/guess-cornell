// Checks player names with PurgoMalum (https://www.purgomalum.com), a free
// profanity-filter web service, so no word list lives in this app.
// If the service is slow or down, the name is allowed rather than blocking play.

const ENDPOINT = 'https://www.purgomalum.com/service/containsprofanity';
const TIMEOUT_MS = 3000;

export async function isProfane(text) {
  try {
    const res = await fetch(`${ENDPOINT}?text=${encodeURIComponent(text)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false;
    return (await res.text()).trim() === 'true';
  } catch {
    return false;
  }
}

export const NAME_NOT_ALLOWED = "That name isn't allowed. Please pick a different one.";
