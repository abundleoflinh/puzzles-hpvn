// Cloudflare Worker: puzzle + collection storage API.
//
// Routes:
//   POST   /api/puzzle                          — create new puzzle (password required)
//   PUT    /api/puzzle/:type/:id                — update existing puzzle (password required)
//   GET    /api/puzzle/:type/:id                — fetch puzzle (public, Strands solution masked; full when password header valid)
//   POST   /api/puzzle/strands/:id/guess        — validate a Strands path guess (public; never leaks unfound answers)
//   POST   /api/puzzle/strands/:id/hint         — reveal cells of one unfound theme word (public)
//   POST   /api/collection                      — create new collection (password required)
//   GET    /api/collection/:id                  — fetch a single collection (public, metadata only)
//   GET    /api/collections                     — list all collections with their puzzles (public, metadata only)
//   POST   /api/admin/backfill-metadata          — one-shot: attach KV metadata to legacy rows (password required, idempotent)
//
// Storage: KV namespace bound as env.PUZZLES.
//   Puzzles:     `{type}:{id}`     → serialized puzzle JSON (may include title, collectionId)
//                                     metadata: { collectionId?, title?, createdAt? }
//   Collections: `collection:{id}` → { name, createdAt }
//                                     metadata: { name, createdAt }
// Metadata mirrors the fields needed by the collections listing so that endpoint
// can be answered from list() calls alone — no per-key gets. Legacy rows written
// before this scheme have no metadata and fall back to a body fetch; the
// /api/admin/backfill-metadata endpoint (password-gated) upgrades them in place.
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
const CONNECTIONS_MIN_SIZE = 3;
const CONNECTIONS_MAX_SIZE = 6;
const LEGACY_DIFFICULTY_MAP = { yellow: 1, green: 2, blue: 3, red: 4, purple: 4 };

// Strands bounds. Rows 4–10, cols 6–8. If changed, mirror in src/games/strands/constants.js.
const STRANDS_ROW_MIN = 4;
const STRANDS_ROW_MAX = 10;
const STRANDS_COL_MIN = 6;
const STRANDS_COL_MAX = 8;
const STRANDS_SPANGRAM_MIN = 6;
const STRANDS_SPANGRAM_MAX = 10;
const STRANDS_WORD_MIN_LEN = 3;
const STRANDS_WORD_MIN_COUNT = 3;
const STRANDS_WORD_MAX_COUNT = 15;

// 8-adjacency check for two 1-D indices on a rows×cols grid.
function areAdjacent(a, b, cols) {
  if (a === b) return false;
  const ra = Math.floor(a / cols), ca = a % cols;
  const rb = Math.floor(b / cols), cb = b % cols;
  return Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1;
}

// Full Strands puzzle validator. Enforces the invariants the play page relies
// on so a bad write can't produce an unplayable game. Kept aligned with the
// client's src/games/strands/model.js — if you change one, mirror the other.
function validateStrands(puzzle) {
  const { rows, cols, grid, spangram, words } = puzzle;
  if (!Number.isInteger(rows) || rows < STRANDS_ROW_MIN || rows > STRANDS_ROW_MAX) {
    return `rows must be an integer in [${STRANDS_ROW_MIN}, ${STRANDS_ROW_MAX}]`;
  }
  if (!Number.isInteger(cols) || cols < STRANDS_COL_MIN || cols > STRANDS_COL_MAX) {
    return `cols must be an integer in [${STRANDS_COL_MIN}, ${STRANDS_COL_MAX}]`;
  }
  const cellCount = rows * cols;
  if (!Array.isArray(grid) || grid.length !== cellCount) return `grid must be ${cellCount} letters`;
  for (const ch of grid) {
    if (typeof ch !== 'string' || !/^[A-Z]$/.test(ch)) return 'grid letters must be single uppercase A–Z';
  }
  if (typeof puzzle.theme !== 'string' || !puzzle.theme.trim()) return 'theme is required';
  if (puzzle.theme.length > 200) return 'theme too long (max 200)';
  if (puzzle.lang != null && puzzle.lang !== 'en' && puzzle.lang !== 'vi') return `lang must be 'en' or 'vi'`;
  if (!spangram || typeof spangram !== 'object') return 'spangram required';
  if (typeof spangram.word !== 'string' || !/^[A-Z]+$/.test(spangram.word)) return 'spangram.word must be uppercase letters';
  if (spangram.word.length < STRANDS_SPANGRAM_MIN || spangram.word.length > STRANDS_SPANGRAM_MAX) {
    return `spangram length must be [${STRANDS_SPANGRAM_MIN}, ${STRANDS_SPANGRAM_MAX}]`;
  }
  if (!Array.isArray(words) || words.length < STRANDS_WORD_MIN_COUNT || words.length > STRANDS_WORD_MAX_COUNT) {
    return `words count must be in [${STRANDS_WORD_MIN_COUNT}, ${STRANDS_WORD_MAX_COUNT}]`;
  }

  // Validate each path: array of unique cell indices, 8-adjacent step to step,
  // letters spell the word. Collect covered cells to check coverage after.
  const covered = new Array(cellCount).fill(false);
  const checkPath = (word, path, label) => {
    if (!Array.isArray(path)) return `${label} path must be an array`;
    if (path.length !== word.length) return `${label} path length must equal word length`;
    const seen = new Set();
    for (let i = 0; i < path.length; i++) {
      const idx = path[i];
      if (!Number.isInteger(idx) || idx < 0 || idx >= cellCount) return `${label} path[${i}] out of range`;
      if (seen.has(idx)) return `${label} path revisits cell ${idx}`;
      seen.add(idx);
      if (grid[idx] !== word[i]) return `${label} letter mismatch at path[${i}]`;
      if (covered[idx]) return `${label} overlaps another path at cell ${idx}`;
      if (i > 0 && !areAdjacent(path[i - 1], idx, cols)) return `${label} path not 8-adjacent at step ${i}`;
    }
    for (const idx of seen) covered[idx] = true;
    return null;
  };

  const spangramErr = checkPath(spangram.word, spangram.path, 'spangram');
  if (spangramErr) return spangramErr;

  // Spangram must touch two opposite edges (top+bottom OR left+right).
  let touchesTop = false, touchesBottom = false, touchesLeft = false, touchesRight = false;
  for (const idx of spangram.path) {
    const r = Math.floor(idx / cols), c = idx % cols;
    if (r === 0) touchesTop = true;
    if (r === rows - 1) touchesBottom = true;
    if (c === 0) touchesLeft = true;
    if (c === cols - 1) touchesRight = true;
  }
  if (!((touchesTop && touchesBottom) || (touchesLeft && touchesRight))) {
    return 'spangram must touch two opposite edges';
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || typeof w !== 'object') return `words[${i}] must be an object`;
    if (typeof w.word !== 'string' || !/^[A-Z]+$/.test(w.word)) return `words[${i}].word must be uppercase letters`;
    if (w.word.length < STRANDS_WORD_MIN_LEN) return `words[${i}] must be at least ${STRANDS_WORD_MIN_LEN} letters`;
    const err = checkPath(w.word, w.path, `words[${i}]`);
    if (err) return err;
  }

  // Full coverage: every cell must be claimed by exactly one path.
  for (let i = 0; i < cellCount; i++) {
    if (!covered[i]) return `cell ${i} not covered by any path`;
  }
  return null;
}

function validatePuzzle(puzzle, type) {
  if (!puzzle || typeof puzzle !== 'object') return 'puzzle must be an object';
  if (puzzle.type !== type) return 'puzzle.type mismatch';
  if (type === 'connections') {
    // Size: explicit puzzle.size when present, else infer from groups[0].words.length,
    // else default 4 (legacy puzzles). Must be an int in [3, 6] either way — we
    // reject out-of-range inferred sizes too, so a bogus payload with 8-word groups
    // can't sneak through as an "8×8 puzzle".
    let size;
    if (puzzle.size != null) {
      if (!Number.isInteger(puzzle.size) || puzzle.size < CONNECTIONS_MIN_SIZE || puzzle.size > CONNECTIONS_MAX_SIZE) {
        return `size must be an integer in [${CONNECTIONS_MIN_SIZE}, ${CONNECTIONS_MAX_SIZE}]`;
      }
      size = puzzle.size;
    } else if (Array.isArray(puzzle.groups) && puzzle.groups[0] && Array.isArray(puzzle.groups[0].words)) {
      const inferred = puzzle.groups[0].words.length;
      if (inferred < CONNECTIONS_MIN_SIZE || inferred > CONNECTIONS_MAX_SIZE) {
        return `inferred size ${inferred} out of range [${CONNECTIONS_MIN_SIZE}, ${CONNECTIONS_MAX_SIZE}]`;
      }
      size = inferred;
    } else {
      size = 4;
    }
    if (!Array.isArray(puzzle.groups) || puzzle.groups.length !== size) {
      return `connections puzzle needs exactly ${size} groups`;
    }
    for (const g of puzzle.groups) {
      if (!Array.isArray(g.words) || g.words.length !== size) return `each group needs ${size} words`;
      // Difficulty (optional): int 1..size OR legacy string in LEGACY_DIFFICULTY_MAP.
      // If absent, derived by position in the client; we don't enforce presence here.
      if (g.difficulty != null) {
        if (typeof g.difficulty === 'string') {
          if (!(g.difficulty in LEGACY_DIFFICULTY_MAP)) return `unknown legacy difficulty "${g.difficulty}"`;
        } else if (!Number.isInteger(g.difficulty) || g.difficulty < 1 || g.difficulty > size) {
          return `group difficulty must be an integer in [1, ${size}]`;
        }
      }
    }
    // Optional mistakeMode: 'endless', integer 3..6, or legacy 'four'/'four_strikes'.
    if (puzzle.mistakeMode != null) {
      const m = puzzle.mistakeMode;
      const isLegacyFour = m === 'four';
      const isEndless = m === 'endless';
      const isValidInt = Number.isInteger(m) && m >= 3 && m <= 6;
      if (!isLegacyFour && !isEndless && !isValidInt) {
        return `mistakeMode must be 'endless' or an integer in [3, 6]`;
      }
    }
    // Optional revealOnFail (default true when absent — preserves legacy behavior).
    if (puzzle.revealOnFail != null && typeof puzzle.revealOnFail !== 'boolean') {
      return 'revealOnFail must be a boolean';
    }
    // Optional pinnedLayout: (size*size)-slot array of null | {g:0..size-1, w:0..size-1}.
    // Each {g,w} must be unique — otherwise two tiles would race for one slot.
    if (puzzle.pinnedLayout != null) {
      const expected = size * size;
      if (!Array.isArray(puzzle.pinnedLayout) || puzzle.pinnedLayout.length !== expected) {
        return `pinnedLayout must be a ${expected}-item array`;
      }
      const seen = new Set();
      for (let i = 0; i < expected; i++) {
        const p = puzzle.pinnedLayout[i];
        if (p === null) continue;
        if (!p || typeof p !== 'object') return `pinnedLayout[${i}] must be null or an object`;
        if (!Number.isInteger(p.g) || p.g < 0 || p.g >= size) return `pinnedLayout[${i}].g out of range`;
        if (!Number.isInteger(p.w) || p.w < 0 || p.w >= size) return `pinnedLayout[${i}].w out of range`;
        const key = `${p.g}:${p.w}`;
        if (seen.has(key)) return `pinnedLayout has duplicate reference to group ${p.g} word ${p.w}`;
        seen.add(key);
      }
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
  if (type === 'strands') {
    const err = validateStrands(puzzle);
    if (err) return err;
  }
  return null;
}

// Produce the player-facing view of a Strands puzzle: everything visible on
// the board plus counts, but NEVER the theme-word list or spangram paths.
// Cache-Control on the public GET makes leaking these fields a permanent
// mistake, so keep this function the single point that shapes the payload.
function maskStrands(puzzle) {
  return {
    type: 'strands',
    title: puzzle.title ?? null,
    theme: puzzle.theme,
    lang: puzzle.lang ?? null,
    rows: puzzle.rows,
    cols: puzzle.cols,
    grid: puzzle.grid,
    wordCount: Array.isArray(puzzle.words) ? puzzle.words.length : 0,
    spangramLength: puzzle.spangram?.word?.length ?? 0,
    defaultTheme: puzzle.defaultTheme ?? null,
    defaultLang: puzzle.defaultLang ?? null,
  };
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

// Extract just the fields the collections listing needs, keyed for KV metadata.
// Keeping this tiny (well under KV's 1024-byte metadata cap) means list() can
// answer the /api/collections endpoint without any per-key gets.
function puzzleMetadata(puzzle) {
  const m = {};
  if (typeof puzzle.title === 'string' && puzzle.title.trim()) m.title = puzzle.title.trim();
  if (puzzle.collectionId) m.collectionId = puzzle.collectionId;
  if (puzzle.createdAt) m.createdAt = puzzle.createdAt;
  return m;
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

  await env.PUZZLES.put(`${type}:${id}`, serialized, { metadata: puzzleMetadata(puzzle) });
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

  await env.PUZZLES.put(`${type}:${id}`, serialized, { metadata: puzzleMetadata(puzzle) });
  return json({ ok: true });
}

// Public fetch. Connections returns the full puzzle (its client validates
// guesses locally — that's the design). Strands hides the solution: the
// public payload lets the player see the board but never the theme words or
// spangram paths. Editors get the full puzzle back by presenting the shared
// password header; anyone else's Strands GET returns the masked view.
async function handleFetchPuzzle(request, env, type, id) {
  if (!ALLOWED_TYPES.has(type)) return json({ error: 'unknown game type' }, 400);
  const raw = await env.PUZZLES.get(`${type}:${id}`);
  if (!raw) return json({ error: 'not found' }, 404);

  if (type === 'strands' && !checkPassword(request, env)) {
    let puzzle;
    try { puzzle = JSON.parse(raw); } catch { return json({ error: 'corrupt puzzle' }, 500); }
    return new Response(JSON.stringify({ puzzle: maskStrands(puzzle) }), {
      headers: {
        'Content-Type': 'application/json',
        // No public cache when auth might upgrade the response — keep it simple.
        'Cache-Control': 'public, max-age=60',
        ...CORS_HEADERS,
      },
    });
  }

  return new Response(`{"puzzle":${raw}}`, {
    headers: {
      'Content-Type': 'application/json',
      // Editor GETs shouldn't be cached at the edge (they're authenticated),
      // so send no-store when password header is present. Public GETs get a
      // brief cache; updates propagate within a minute.
      'Cache-Control': checkPassword(request, env) ? 'no-store' : 'public, max-age=60',
      ...CORS_HEADERS,
    },
  });
}

// Public: validate a Strands path guess against the stored solution. Returns
// which word (or the spangram) the path matches, or 'none'. Never returns
// paths or letters for unfound answers — the response shape is fixed.
async function handleStrandsGuess(request, env, id) {
  const raw = await env.PUZZLES.get(`strands:${id}`);
  if (!raw) return json({ error: 'not found' }, 404);
  let puzzle;
  try { puzzle = JSON.parse(raw); } catch { return json({ error: 'corrupt puzzle' }, 500); }

  const body = await parseJsonBody(request);
  const path = body?.path;
  if (!Array.isArray(path) || path.length === 0) return json({ error: 'path required' }, 400);

  const key = path.join(',');
  if (key === puzzle.spangram.path.join(',')) {
    return json({ match: 'spangram', word: puzzle.spangram.word });
  }
  for (let i = 0; i < puzzle.words.length; i++) {
    if (key === puzzle.words[i].path.join(',')) {
      return json({ match: 'theme', wordIndex: i, word: puzzle.words[i].word });
    }
  }
  return json({ match: 'none' });
}

// Public: hand back the letter cells of one still-unfound theme word so the
// play page can highlight them. The path is returned as a shuffled set —
// order isn't part of the hint (player still has to draw the sequence). The
// spangram is never a hint target; those must be earned.
async function handleStrandsHint(request, env, id) {
  const raw = await env.PUZZLES.get(`strands:${id}`);
  if (!raw) return json({ error: 'not found' }, 404);
  let puzzle;
  try { puzzle = JSON.parse(raw); } catch { return json({ error: 'corrupt puzzle' }, 500); }
  const body = await parseJsonBody(request);
  const found = new Set(Array.isArray(body?.found) ? body.found : []);
  const candidates = [];
  for (let i = 0; i < puzzle.words.length; i++) if (!found.has(i)) candidates.push(i);
  if (!candidates.length) return json({ done: true });
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const cells = [...puzzle.words[pick].path];
  // Fisher-Yates so the client can't read the sequence off the array order.
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return json({ wordIndex: pick, cells });
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

  await env.PUZZLES.put(`${COLLECTION_PREFIX}${id}`, serialized, {
    metadata: { name, createdAt: record.createdAt },
  });
  return json({ id, name, createdAt: record.createdAt }, 201);
}

async function handleFetchCollection(env, id) {
  const raw = await env.PUZZLES.get(`${COLLECTION_PREFIX}${id}`);
  if (!raw) return json({ error: 'not found' }, 404);
  const record = JSON.parse(raw);
  return json({ id, ...record });
}

// List every key with a given prefix, keeping the KV list-entry object
// (name + inline metadata). Paginated: we walk cursors until list_complete.
// At personal scale this is a handful of RTs at most.
async function listAllEntries(env, prefix) {
  const entries = [];
  let cursor;
  do {
    const page = await env.PUZZLES.list({ prefix, cursor });
    for (const k of page.keys) entries.push(k);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return entries;
}

// Insert one puzzle into its collection bucket. Shared between the fast path
// (data came from KV metadata) and the legacy fallback (data came from a body
// fetch), so the entry shape stays in one place.
function pushPuzzleEntry(collections, type, id, collectionId, rawTitle, createdAt) {
  const bucket = collections.get(collectionId);
  if (!bucket) return; // orphan ref — collection was deleted
  const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : null;
  const entry = { type, id, title, createdAt: createdAt || null };
  const list = bucket.puzzlesByType.get(type) || [];
  list.push(entry);
  bucket.puzzlesByType.set(type, list);
}

// Public: all collections, each with the puzzles that reference it.
// Returns metadata only — no groups, no words, no answers. Order:
// collections alphabetical by name; within a collection, puzzles grouped
// by type (alphabetical) then ordered by createdAt (oldest first).
//
// Fast path: every list() entry already carries the name/title/collectionId/
// createdAt we need in `metadata` (populated by the create/update handlers), so
// we can answer the whole endpoint from list() calls alone. Legacy rows written
// before metadata was in the schema fall back to a parallel Promise.all of
// gets — only for the rows that need it. As backfill runs (or those rows get
// re-saved by the editor), the fallback list shrinks toward zero.
async function handleListCollections(env) {
  // 1. Load all collections.
  const collectionEntries = await listAllEntries(env, COLLECTION_PREFIX);
  const collections = new Map(); // id → {id, name, createdAt, puzzlesByType}
  const collectionsLegacy = []; // rows without metadata — fetched below

  for (const entry of collectionEntries) {
    const id = entry.name.slice(COLLECTION_PREFIX.length);
    const meta = entry.metadata;
    if (meta && typeof meta.name === 'string') {
      collections.set(id, {
        id,
        name: meta.name,
        createdAt: meta.createdAt || null,
        puzzlesByType: new Map(),
      });
    } else {
      collectionsLegacy.push({ id, key: entry.name });
    }
  }
  if (collectionsLegacy.length) {
    const raws = await Promise.all(collectionsLegacy.map(({ key }) => env.PUZZLES.get(key)));
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i];
      if (!raw) continue; // deleted mid-list
      try {
        const rec = JSON.parse(raw);
        const { id } = collectionsLegacy[i];
        collections.set(id, {
          id,
          name: rec.name,
          createdAt: rec.createdAt || null,
          puzzlesByType: new Map(),
        });
      } catch { /* skip corrupt row */ }
    }
  }

  // 2. Walk each puzzle type in parallel, bucketing puzzles by collectionId.
  //    Metadata gives us collectionId/title/createdAt without a body fetch;
  //    a puzzle is legacy-fetched only if its list entry has no metadata at
  //    all (metadata present but no collectionId means "not in a collection").
  await Promise.all([...ALLOWED_TYPES].map(async (type) => {
    const entries = await listAllEntries(env, `${type}:`);
    const legacy = [];
    for (const entry of entries) {
      const id = entry.name.slice(type.length + 1);
      const meta = entry.metadata;
      if (meta) {
        if (meta.collectionId) {
          pushPuzzleEntry(collections, type, id, meta.collectionId, meta.title, meta.createdAt);
        }
        // else: known not to be in a collection — skip cheaply.
      } else {
        legacy.push({ id, key: entry.name });
      }
    }
    if (!legacy.length) return;
    const raws = await Promise.all(legacy.map(({ key }) => env.PUZZLES.get(key)));
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i];
      if (!raw) continue;
      let puzzle;
      try { puzzle = JSON.parse(raw); } catch { continue; }
      if (!puzzle.collectionId) continue;
      const { id } = legacy[i];
      pushPuzzleEntry(collections, type, id, puzzle.collectionId, puzzle.title, puzzle.createdAt);
    }
  }));

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

// One-shot: walk every collection + puzzle key and, for any row without
// metadata, re-put it with metadata attached. Idempotent — rows that already
// carry metadata are skipped, so re-runs are cheap. Password-gated because it
// rewrites data and can burn KV write units on a large namespace. Safe to
// leave deployed; delete when no legacy rows remain if you want.
async function handleBackfillMetadata(request, env) {
  if (!checkPassword(request, env)) return json({ error: 'unauthorized' }, 401);

  let collectionsScanned = 0, collectionsBackfilled = 0;
  let puzzlesScanned = 0, puzzlesBackfilled = 0, puzzlesSkippedCorrupt = 0;

  // Collections
  const cEntries = await listAllEntries(env, COLLECTION_PREFIX);
  const cLegacy = cEntries.filter((e) => !e.metadata || typeof e.metadata.name !== 'string');
  collectionsScanned = cEntries.length;
  const cRaws = await Promise.all(cLegacy.map((e) => env.PUZZLES.get(e.name)));
  await Promise.all(cLegacy.map(async (entry, i) => {
    const raw = cRaws[i];
    if (!raw) return;
    let rec;
    try { rec = JSON.parse(raw); } catch { return; }
    await env.PUZZLES.put(entry.name, raw, {
      metadata: { name: rec.name, createdAt: rec.createdAt || null },
    });
    collectionsBackfilled++;
  }));

  // Puzzles (per type, in parallel)
  await Promise.all([...ALLOWED_TYPES].map(async (type) => {
    const entries = await listAllEntries(env, `${type}:`);
    puzzlesScanned += entries.length;
    const legacy = entries.filter((e) => !e.metadata);
    const raws = await Promise.all(legacy.map((e) => env.PUZZLES.get(e.name)));
    await Promise.all(legacy.map(async (entry, i) => {
      const raw = raws[i];
      if (!raw) return;
      let puzzle;
      try { puzzle = JSON.parse(raw); } catch { puzzlesSkippedCorrupt++; return; }
      await env.PUZZLES.put(entry.name, raw, { metadata: puzzleMetadata(puzzle) });
      puzzlesBackfilled++;
    }));
  }));

  return json({
    ok: true,
    collectionsScanned,
    collectionsBackfilled,
    puzzlesScanned,
    puzzlesBackfilled,
    puzzlesSkippedCorrupt,
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
        if (request.method === 'GET') return await handleFetchPuzzle(request, env, type, id);
        if (request.method === 'PUT') return await handleUpdatePuzzle(request, env, type, id);
      }
      const guessMatch = path.match(/^\/api\/puzzle\/strands\/([A-Za-z0-9]+)\/guess$/);
      if (guessMatch && request.method === 'POST') {
        return await handleStrandsGuess(request, env, guessMatch[1]);
      }
      const hintMatch = path.match(/^\/api\/puzzle\/strands\/([A-Za-z0-9]+)\/hint$/);
      if (hintMatch && request.method === 'POST') {
        return await handleStrandsHint(request, env, hintMatch[1]);
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

      // ---------- auth ----------
      // Password check for the editor gate. Returns 200 on match, 401 otherwise.
      // No side effects — used only to decide whether to render the editor UI.
      if (path === '/api/auth/check' && request.method === 'GET') {
        if (!checkPassword(request, env)) return json({ error: 'unauthorized' }, 401);
        return json({ ok: true });
      }

      // ---------- admin ----------
      // One-shot metadata backfill for legacy rows (see handler). Idempotent.
      if (path === '/api/admin/backfill-metadata' && request.method === 'POST') {
        return await handleBackfillMetadata(request, env);
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
