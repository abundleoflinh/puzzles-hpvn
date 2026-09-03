// Cloudflare Worker: puzzle + collection storage API.
//
// Routes:
//   POST   /api/puzzle              — create new puzzle (password required)
//   PUT    /api/puzzle/:type/:id    — update existing puzzle (password required)
//   GET    /api/puzzle/:type/:id    — fetch puzzle (public)
//   POST   /api/collection          — create new collection (password required)
//   GET    /api/collection/:id      — fetch a single collection (public, metadata only)
//   GET    /api/collections         — list all collections with their puzzles (public, metadata only)
//
// Storage: KV namespace bound as env.PUZZLES.
//   Puzzles:     `{type}:{id}`     → serialized puzzle JSON (may include title, collectionId)
//   Collections: `collection:{id}` → { name, createdAt }
// Auth: shared password sent in X-Editor-Password header, compared to env.EDITOR_PASSWORD.

const ALLOWED_TYPES = new Set(['connections', 'strands']);
const ID_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; // base58, no 0/O/I/l
const ID_LENGTH = 5;
const MAX_PUZZLE_BYTES = 8 * 1024; // 8KB — generous for Connections, room for Strands
const MAX_COLLECTION_BYTES = 1024; // small — just name + createdAt + id
const MAX_TITLE_LEN = 80;
const MAX_COLLECTION_NAME_LEN = 60;
const COLLECTION_PREFIX = 'collection:';

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
// Optional metadata fields (title, collectionId) are validated here too.
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
  // Optional title: string, trimmed length ≤ MAX_TITLE_LEN.
  if (puzzle.title != null) {
    if (typeof puzzle.title !== 'string') return 'title must be a string';
    if (puzzle.title.length > MAX_TITLE_LEN) return `title too long (max ${MAX_TITLE_LEN})`;
  }
  // Optional collectionId: 5-char base58 id (same shape as puzzle ids).
  if (puzzle.collectionId != null) {
    if (typeof puzzle.collectionId !== 'string' || !/^[A-Za-z0-9]{5}$/.test(puzzle.collectionId)) {
      return 'invalid collectionId';
    }
  }
  // strands validation deferred until that game module lands
  return null;
}

// Parse JSON body or throw a short-circuit Response.
async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    throw json({ error: 'invalid JSON' }, 400);
  }
}

// Validate + serialize a puzzle for storage, or throw a short-circuit Response.
function validateAndSerialize(puzzle, type) {
  const validationError = validatePuzzle(puzzle, type);
  if (validationError) throw json({ error: validationError }, 400);
  const serialized = JSON.stringify(puzzle);
  if (serialized.length > MAX_PUZZLE_BYTES) throw json({ error: 'puzzle too large' }, 413);
  return serialized;
}

// If a puzzle references a collectionId, make sure the collection exists.
// Prevents orphan references from typos or races.
async function assertCollectionExists(env, collectionId) {
  if (!collectionId) return;
  const raw = await env.PUZZLES.get(`${COLLECTION_PREFIX}${collectionId}`);
  if (!raw) throw json({ error: 'collection not found' }, 400);
}

async function handleCreatePuzzle(request, env) {
  if (!checkPassword(request, env)) return json({ error: 'unauthorized' }, 401);

  const body = await parseJsonBody(request);
  const { type, puzzle } = body || {};
  if (!ALLOWED_TYPES.has(type)) return json({ error: 'unknown game type' }, 400);

  const serialized = validateAndSerialize(puzzle, type);
  await assertCollectionExists(env, puzzle.collectionId);

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

async function handleUpdatePuzzle(request, env, type, id) {
  if (!checkPassword(request, env)) return json({ error: 'unauthorized' }, 401);
  if (!ALLOWED_TYPES.has(type)) return json({ error: 'unknown game type' }, 400);

  const existing = await env.PUZZLES.get(`${type}:${id}`);
  if (!existing) return json({ error: 'not found' }, 404);

  const body = await parseJsonBody(request);
  const puzzle = body?.puzzle;
  const serialized = validateAndSerialize(puzzle, type);
  await assertCollectionExists(env, puzzle.collectionId);

  await env.PUZZLES.put(`${type}:${id}`, serialized);
  return json({ ok: true });
}

// Public fetch: returns the full puzzle. Answers travel in this response;
// the client validates guesses locally.
async function handleFetchPuzzle(env, type, id) {
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

// ============== COLLECTIONS ==============

function validateCollectionName(name) {
  if (typeof name !== 'string') return 'name must be a string';
  const trimmed = name.trim();
  if (!trimmed) return 'name is required';
  if (trimmed.length > MAX_COLLECTION_NAME_LEN) {
    return `name too long (max ${MAX_COLLECTION_NAME_LEN})`;
  }
  return null;
}

async function handleCreateCollection(request, env) {
  if (!checkPassword(request, env)) return json({ error: 'unauthorized' }, 401);

  const body = await parseJsonBody(request);
  const rawName = body?.name;
  const nameError = validateCollectionName(rawName);
  if (nameError) return json({ error: nameError }, 400);
  const name = rawName.trim();

  const record = { name, createdAt: new Date().toISOString() };
  const serialized = JSON.stringify(record);
  if (serialized.length > MAX_COLLECTION_BYTES) return json({ error: 'collection too large' }, 413);

  // Retry on rare ID collision — same scheme as puzzles.
  let id;
  for (let attempt = 0; attempt < 5; attempt++) {
    id = generateId();
    const existing = await env.PUZZLES.get(`${COLLECTION_PREFIX}${id}`);
    if (!existing) break;
    id = null;
  }
  if (!id) return json({ error: 'could not generate unique id' }, 500);

  await env.PUZZLES.put(`${COLLECTION_PREFIX}${id}`, serialized);
  return json({ id, name, createdAt: record.createdAt }, 201);
}

async function handleFetchCollection(env, id) {
  const raw = await env.PUZZLES.get(`${COLLECTION_PREFIX}${id}`);
  if (!raw) return json({ error: 'not found' }, 404);
  const record = JSON.parse(raw);
  return json({ id, ...record });
}

// List every key with a given prefix. KV list() is paginated; we walk cursors
// until list_complete. At personal scale this is a handful of RTs at most.
async function listAllKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.PUZZLES.list({ prefix, cursor });
    for (const k of page.keys) keys.push(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return keys;
}

// Public: all collections, each with the puzzles that reference it.
// Returns metadata only — no groups, no words, no answers. Order:
// collections alphabetical by name; within a collection, puzzles grouped
// by type (alphabetical) then ordered by createdAt (oldest first).
async function handleListCollections(env) {
  // 1. Load all collections.
  const collectionKeys = await listAllKeys(env, COLLECTION_PREFIX);
  const collections = new Map(); // id → {id, name, createdAt, puzzlesByType}
  for (const key of collectionKeys) {
    const id = key.slice(COLLECTION_PREFIX.length);
    const raw = await env.PUZZLES.get(key);
    if (!raw) continue; // deleted mid-list — skip
    try {
      const rec = JSON.parse(raw);
      collections.set(id, {
        id,
        name: rec.name,
        createdAt: rec.createdAt,
        puzzlesByType: new Map(),
      });
    } catch { /* skip corrupt row */ }
  }

  // 2. Walk each puzzle type, bucket puzzles by their collectionId.
  //    We fetch full bodies to read collectionId + title, then discard
  //    anything answer-shaped from the response.
  for (const type of ALLOWED_TYPES) {
    const keys = await listAllKeys(env, `${type}:`);
    for (const key of keys) {
      const id = key.slice(type.length + 1);
      const raw = await env.PUZZLES.get(key);
      if (!raw) continue;
      let puzzle;
      try { puzzle = JSON.parse(raw); } catch { continue; }
      const collectionId = puzzle.collectionId;
      if (!collectionId) continue;
      const bucket = collections.get(collectionId);
      if (!bucket) continue; // orphan ref — collection was deleted
      const entry = {
        type,
        id,
        title: typeof puzzle.title === 'string' && puzzle.title.trim()
          ? puzzle.title.trim()
          : null,
        createdAt: puzzle.createdAt || null,
      };
      const list = bucket.puzzlesByType.get(type) || [];
      list.push(entry);
      bucket.puzzlesByType.set(type, list);
    }
  }

  // 3. Sort and shape output.
  const out = [];
  const sortedCollections = [...collections.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
  for (const c of sortedCollections) {
    const typeGroups = [];
    const sortedTypes = [...c.puzzlesByType.keys()].sort();
    for (const type of sortedTypes) {
      const puzzles = c.puzzlesByType.get(type).sort((a, b) => {
        // Oldest first. Undefined createdAt sinks to the end deterministically.
        if (!a.createdAt && !b.createdAt) return 0;
        if (!a.createdAt) return 1;
        if (!b.createdAt) return -1;
        return a.createdAt.localeCompare(b.createdAt);
      });
      typeGroups.push({ type, puzzles });
    }
    out.push({ id: c.id, name: c.name, createdAt: c.createdAt, typeGroups });
  }

  return new Response(JSON.stringify({ collections: out }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30', // short cache — new puzzles show up quickly
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ---------- puzzles ----------
      if (path === '/api/puzzle' && request.method === 'POST') {
        return await handleCreatePuzzle(request, env);
      }
      const puzzleMatch = path.match(/^\/api\/puzzle\/([a-z]+)\/([A-Za-z0-9]+)$/);
      if (puzzleMatch) {
        const [, type, id] = puzzleMatch;
        if (request.method === 'GET') return await handleFetchPuzzle(env, type, id);
        if (request.method === 'PUT') return await handleUpdatePuzzle(request, env, type, id);
      }

      // ---------- collections ----------
      if (path === '/api/collections' && request.method === 'GET') {
        return await handleListCollections(env);
      }
      if (path === '/api/collection' && request.method === 'POST') {
        return await handleCreateCollection(request, env);
      }
      const collectionMatch = path.match(/^\/api\/collection\/([A-Za-z0-9]{5})$/);
      if (collectionMatch && request.method === 'GET') {
        return await handleFetchCollection(env, collectionMatch[1]);
      }

      // ---------- misc ----------
      if (path === '/api/health' && request.method === 'GET') {
        return json({ ok: true, ts: new Date().toISOString() });
      }

      return json({ error: 'not found' }, 404);
    } catch (thrown) {
      // Helpers throw a Response to short-circuit. Anything else is a real error.
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  },
};
