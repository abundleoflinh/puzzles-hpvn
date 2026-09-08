// Thin fetch wrapper around the Cloudflare Worker API.
// The Worker URL is hardcoded because we're using the direct .workers.dev URL
// (no custom domain, no Pages route). If you ever wire up a custom domain,
// change this one constant and everything else keeps working.

const API_BASE = 'https://hpvn-puzzles-api.vophuonglinh.workers.dev';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

function authHeaders(password) {
  return { 'X-Editor-Password': password };
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(`Invalid response from server (${res.status})`, res.status);
  }
  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

// Public fetch. Connections returns the full puzzle (its client validates
// guesses locally). Strands returns a masked payload with no theme-word or
// spangram paths — pass `password` to get the full puzzle back (used by the
// editor when loading an existing Strands puzzle for editing).
export function fetchPuzzle(type, id, password) {
  const options = password ? { headers: authHeaders(password) } : {};
  return request(`/api/puzzle/${type}/${id}`, options);
}

// Strands: submit a path guess. Server validates against the stored solution
// and returns `{ match: 'theme'|'spangram'|'none', wordIndex?, word? }`.
// Never reveals unfound answers.
export function submitStrandsGuess(id, path) {
  return request(`/api/puzzle/strands/${id}/guess`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ path }),
  });
}

// Strands: ask the server to reveal cells of one unfound theme word for a
// hint. `found` is the array of found word indexes (server excludes them).
// Response: `{ wordIndex, cells: [n, ...] }` (cells are shuffled) or `{ done: true }`.
export function requestStrandsHint(id, found) {
  return request(`/api/puzzle/strands/${id}/hint`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ found }),
  });
}

export function createPuzzle(type, puzzle, password) {
  return request('/api/puzzle', {
    method: 'POST',
    headers: { ...jsonHeaders(), ...authHeaders(password) },
    body: JSON.stringify({ type, puzzle }),
  });
}

export function updatePuzzle(type, id, puzzle, password) {
  return request(`/api/puzzle/${type}/${id}`, {
    method: 'PUT',
    headers: { ...jsonHeaders(), ...authHeaders(password) },
    body: JSON.stringify({ puzzle }),
  });
}

// Collections API. Public list + fetch, password-gated create.
// Response shape from listCollections:
//   { collections: [{ id, name, createdAt, typeGroups: [{ type, puzzles: [...] }] }] }
// Puzzle entries carry only metadata (id, title, createdAt) — no answers.
export function listCollections() {
  return request('/api/collections');
}

// Verify the editor password against the Worker. Resolves true on 200,
// false on 401. Any other error (network, 5xx) rethrows so the caller can
// distinguish "wrong password" from "couldn't reach server".
export async function verifyPassword(password) {
  try {
    await request('/api/auth/check', { headers: authHeaders(password) });
    return true;
  } catch (err) {
    if (err.status === 401) return false;
    throw err;
  }
}

export function createCollection(name, password) {
  return request('/api/collection', {
    method: 'POST',
    headers: { ...jsonHeaders(), ...authHeaders(password) },
    body: JSON.stringify({ name }),
  });
}
