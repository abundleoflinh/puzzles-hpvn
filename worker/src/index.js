// Cloudflare Worker: puzzle storage API.
//
// Routes:
//   POST /api/puzzle              — create new puzzle (password required)
//   PUT  /api/puzzle/:type/:id    — update existing puzzle (password required)
//   GET  /api/puzzle/:type/:id    — fetch puzzle (public)
//
// Storage: KV namespace bound as env.PUZZLES.
// Auth: shared password sent in X-Editor-Password header, compared to env.EDITOR_PASSWORD.

const ALLOWED_TYPES = new Set(['connections', 'strands']);
const ID_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; // base58, no 0/O/I/l
const ID_LENGTH = 5;
const MAX_PUZZLE_BYTES = 8 * 1024; // 8KB — generous for Connections, room for Strands

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Editor-Password',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
  });
}

// Constant-time string compare to avoid timing attacks on the password.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkPassword(request, env) {
  const provided = request.headers.get('X-Editor-Password') || '';
  const expected = env.EDITOR_PASSWORD || '';
  if (!expected) return false; // fail closed if secret not set
  return timingSafeEqual(provided, expected);
}

function generateId() {
  let id = '';
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return id;
}

// Minimal shape validation. Games do their own richer validation client-side;
// this just prevents obviously broken writes from filling KV.
function validatePuzzle(puzzle, type) {
  if (!puzzle || typeof puzzle !== 'object') return 'puzzle must be an object';
  if (puzzle.type !== type) return 'puzzle.type mismatch';
  if (type === 'connections') {
    if (!Array.isArray(puzzle.groups) || puzzle.groups.length !== 4) {
      return 'connections puzzle needs exactly 4 groups';
    }
    for (const g of puzzle.groups) {
      if (!Array.isArray(g.words) || g.words.length !== 4) return 'each group needs 4 words';
    }
  }
  // strands validation deferred until that game module lands
  return null;
}

async function handleCreate(request, env) {
  if (!checkPassword(request, env)) return json({ error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const { type, puzzle } = body || {};
  if (!ALLOWED_TYPES.has(type)) return json({ error: 'unknown game type' }, 400);

  const validationError = validatePuzzle(puzzle, type);
  if (validationError) return json({ error: validationError }, 400);

  const serialized = JSON.stringify(puzzle);
  if (serialized.length > MAX_PUZZLE_BYTES) return json({ error: 'puzzle too large' }, 413);

  // Retry on rare ID collision (odds ~1 in 656M per attempt).
  let id;
  for (let attempt = 0; attempt < 5; attempt++) {
    id = generateId();
    const existing = await env.PUZZLES.get(`${type}:${id}`);
    if (!existing) break;
    id = null;
  }
  if (!id) return json({ error: 'could not generate unique id' }, 500);

  await env.PUZZLES.put(`${type}:${id}`, serialized);
  const prefix = type === 'connections' ? '/c/' : '/s/';
  return json({ id, url: `${prefix}${id}` }, 201);
}

async function handleUpdate(request, env, type, id) {
  if (!checkPassword(request, env)) return json({ error: 'unauthorized' }, 401);
  if (!ALLOWED_TYPES.has(type)) return json({ error: 'unknown game type' }, 400);

  const existing = await env.PUZZLES.get(`${type}:${id}`);
  if (!existing) return json({ error: 'not found' }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const puzzle = body?.puzzle;
  const validationError = validatePuzzle(puzzle, type);
  if (validationError) return json({ error: validationError }, 400);

  const serialized = JSON.stringify(puzzle);
  if (serialized.length > MAX_PUZZLE_BYTES) return json({ error: 'puzzle too large' }, 413);

  await env.PUZZLES.put(`${type}:${id}`, serialized);
  return json({ ok: true });
}

async function handleFetch(env, type, id) {
  if (!ALLOWED_TYPES.has(type)) return json({ error: 'unknown game type' }, 400);
  const raw = await env.PUZZLES.get(`${type}:${id}`);
  if (!raw) return json({ error: 'not found' }, 404);
  return new Response(`{"puzzle":${raw}}`, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60', // brief edge cache; updates propagate within a minute
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const path = url.pathname;

    // POST /api/puzzle
    if (path === '/api/puzzle' && request.method === 'POST') {
      return handleCreate(request, env);
    }

    // GET/PUT /api/puzzle/:type/:id
    const match = path.match(/^\/api\/puzzle\/([a-z]+)\/([A-Za-z0-9]+)$/);
    if (match) {
      const [, type, id] = match;
      if (request.method === 'GET') return handleFetch(env, type, id);
      if (request.method === 'PUT') return handleUpdate(request, env, type, id);
    }

    // Health check — handy for verifying deployment
    if (path === '/api/health' && request.method === 'GET') {
      return json({ ok: true, ts: new Date().toISOString() });
    }

    return json({ error: 'not found' }, 404);
  },
};
