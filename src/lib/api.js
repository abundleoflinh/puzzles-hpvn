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

// Public fetch: returns the full puzzle including groups. The client validates
// guesses locally against these answers.
export function fetchPuzzle(type, id) {
  return request(`/api/puzzle/${type}/${id}`);
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

export function createCollection(name, password) {
  return request('/api/collection', {
    method: 'POST',
    headers: { ...jsonHeaders(), ...authHeaders(password) },
    body: JSON.stringify({ name }),
  });
}
