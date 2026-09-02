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

export function fetchPuzzle(type, id) {
  return request(`/api/puzzle/${type}/${id}`);
}

export function createPuzzle(type, puzzle, password) {
  return request('/api/puzzle', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Editor-Password': password,
    },
    body: JSON.stringify({ type, puzzle }),
  });
}

export function updatePuzzle(type, id, puzzle, password) {
  return request(`/api/puzzle/${type}/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Editor-Password': password,
    },
    body: JSON.stringify({ puzzle }),
  });
}
