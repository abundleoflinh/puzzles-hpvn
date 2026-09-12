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

const ALLOWED_TYPES = new Set(['connections', 'strands', 'catfishing']);
const ID_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; // base58, no 0/O/I/l
const ID_LENGTH = 5;
// Per-type payload cap. Connections/Strands are small; a Catfishing set carries
// 5 questions × (bilingual answer + aliases + a 20–40 clue bilingual dump), so
// it needs more headroom. Any unlisted type falls back to the conservative 8KB.
const MAX_BYTES_BY_TYPE = { connections: 8 * 1024, strands: 8 * 1024, catfishing: 16 * 1024 };
const DEFAULT_MAX_PUZZLE_BYTES = 8 * 1024;
function maxBytesForType(type) { return MAX_BYTES_BY_TYPE[type] ?? DEFAULT_MAX_PUZZLE_BYTES; }
const MAX_COLLECTION_BYTES = 1024; // small — just name + createdAt + id
const MAX_TITLE_LEN = 80;
const MAX_COLLECTION_NAME_LEN = 60;
const COLLECTION_PREFIX = 'collection:';

// Catfishing bounds. A published set is exactly CF_QUESTION_COUNT questions;
// each question is one HP entity with a bilingual answer and a dump of
// bilingual category clues. Difficulty is an internal tag, never shown to the
// player. Kept aligned with src/games/catfishing/* when that lands.
const CF_QUESTION_COUNT = 5;
const CF_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const CF_MIN_CLUES = 1;   // minimal shape guard — the editor aims for 20–40
const CF_MAX_CLUES = 60;  // upper bound so a single question can't blow the payload
const CF_FUZZY_THRESHOLD = 0.85; // max(levenshtein, trigram) at/above → "did you mean"

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

  // Spangram must START on one edge and END on the opposite edge: its two
  // endpoints lie on top+bottom or left+right. A mid-path cell touching an edge
  // does not count. Existing stored puzzles are never re-validated on read, so
  // this only gates new writes.
  const edgesOf = (idx) => {
    const r = Math.floor(idx / cols), c = idx % cols;
    return { top: r === 0, bottom: r === rows - 1, left: c === 0, right: c === cols - 1 };
  };
  const spanA = edgesOf(spangram.path[0]);
  const spanB = edgesOf(spangram.path[spangram.path.length - 1]);
  const spansOpposite =
    (spanA.top && spanB.bottom) || (spanA.bottom && spanB.top) ||
    (spanA.left && spanB.right) || (spanA.right && spanB.left);
  if (!spansOpposite) {
    return 'spangram must start and end on opposite edges';
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

// Catfishing set validator. A published set is exactly CF_QUESTION_COUNT
// questions; each carries a bilingual answer (with optional alias arrays), a
// list of bilingual clues, and an internal difficulty tag. Light by design —
// same "reject obviously broken writes" philosophy as the other validators;
// the editor does the richer authoring-time checks.
function validateCatfishing(puzzle) {
  const { questions } = puzzle;
  if (!Array.isArray(questions) || questions.length !== CF_QUESTION_COUNT) {
    return `catfishing set needs exactly ${CF_QUESTION_COUNT} questions`;
  }
  const strOk = (v) => typeof v === 'string' && v.trim().length > 0;
  const strArrOk = (v) => v == null || (Array.isArray(v) && v.every((s) => typeof s === 'string'));
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== 'object') return `questions[${i}] must be an object`;
    const a = q.answer;
    if (!a || typeof a !== 'object') return `questions[${i}].answer required`;
    if (!strOk(a.en) || !strOk(a.vi)) return `questions[${i}].answer needs non-empty en and vi`;
    if (!strArrOk(a.aliases_en) || !strArrOk(a.aliases_vi)) {
      return `questions[${i}].answer aliases must be string arrays`;
    }
    if (!Array.isArray(q.clues) || q.clues.length < CF_MIN_CLUES || q.clues.length > CF_MAX_CLUES) {
      return `questions[${i}].clues must have ${CF_MIN_CLUES}–${CF_MAX_CLUES} entries`;
    }
    for (let c = 0; c < q.clues.length; c++) {
      const clue = q.clues[c];
      if (!clue || typeof clue !== 'object' || !strOk(clue.en) || !strOk(clue.vi)) {
        return `questions[${i}].clues[${c}] needs non-empty en and vi`;
      }
    }
    if (!CF_DIFFICULTIES.has(q.difficulty)) {
      return `questions[${i}].difficulty must be one of easy|medium|hard`;
    }
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
  if (type === 'catfishing') {
    const err = validateCatfishing(puzzle);
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

// Player-facing view of a Catfishing set: each question's bilingual clues and
// its index, but NEVER the answer (or aliases) and NEVER the difficulty tag.
// Per Project Instructions §3 the answer is server-validated via /guess, so it
// must never appear in an unauthenticated payload. This is the single point
// that shapes the public body, and the public GET is edge-cached — so a leak
// here would be a permanent one. Keep it answer-free.
function maskCatfishing(puzzle) {
  return {
    type: 'catfishing',
    title: puzzle.title ?? null,
    collectionId: puzzle.collectionId ?? null,
    questionCount: Array.isArray(puzzle.questions) ? puzzle.questions.length : 0,
    questions: (puzzle.questions || []).map((q, i) => ({
      q_index: i,
      clues: (q.clues || []).map((c) => ({ en: c.en, vi: c.vi })),
    })),
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
  if (serialized.length > maxBytesForType(type)) throw json({ error: 'puzzle too large' }, 413);
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
  const URL_PREFIX = { connections: '/c/', strands: '/s/', catfishing: '/cf/' };
  return json({ id, url: `${URL_PREFIX[type] ?? '/'}${id}` }, 201);
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

  // Types whose public payload hides the solution. Strands masks its theme
  // words/paths; Catfishing masks its answers/difficulty. Editors bypass the
  // mask by presenting the shared password header.
  const MASKERS = { strands: maskStrands, catfishing: maskCatfishing };
  const masker = MASKERS[type];
  if (masker && !checkPassword(request, env)) {
    let puzzle;
    try { puzzle = JSON.parse(raw); } catch { return json({ error: 'corrupt puzzle' }, 500); }
    return new Response(JSON.stringify({ puzzle: masker(puzzle) }), {
      headers: {
        'Content-Type': 'application/json',
        // This URL serves two different bodies: the masked view (no password)
        // and the full puzzle (valid password header). Vary on the password
        // header so a cached masked entry is NEVER reused for the editor's
        // authenticated GET — otherwise the editor loads a solution-less puzzle
        // and renders a blank form.
        'Cache-Control': 'public, max-age=60',
        'Vary': 'X-Editor-Password',
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
      // Same-URL/two-bodies concern as the masked branch above (Strands). Keep
      // the caches keyed on the password header for every fetch path.
      'Vary': 'X-Editor-Password',
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

// ============== CATFISHING ==============

// --- Guess matcher (deterministic, no external deps) -------------------------
//
// Normalize the guess and the answer set, then: exact (post-normalization)
// match → hit; else the best fuzzy score (max of Levenshtein ratio and trigram
// Jaccard) at/above CF_FUZZY_THRESHOLD → confirm (echo the canonical suggestion
// the player effectively typed); else miss.
//
// Language-agnostic: the guess is compared against the EN answer, the VI
// answer, and both alias lists, so a player may answer in either language
// regardless of the UI they are playing in.
//
// Normalization folds Unicode combining marks (so an undiacriticized Vietnamese
// guess still matches — "tu than" ≈ "tử thần"), but đ/Đ is an atomic Vietnamese
// letter with NO combining-mark decomposition, so NFD leaves it intact: it is
// deliberately NOT folded to d. Honorifics (EN + VI) and punctuation are
// stripped and whitespace is collapsed.

const CF_HONORIFICS = [
  'professor', 'prof', 'mr', 'mrs', 'ms', 'miss', 'dr',
  'giao su', 'gs', 'thay', 'co', 'ong', 'ba',
];

function cfNormalize(s) {
  let t = String(s ?? '').toLowerCase();
  // Fold combining diacritics (á→a, ầ→a…) but keep atomic letters like đ.
  t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Punctuation/symbols → spaces; keep letters (incl. đ), digits, whitespace.
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  // Strip leading honorific tokens, repeatedly (e.g. "Professor Dr X").
  let tokens = t.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && CF_HONORIFICS.includes(tokens[0])) tokens = tokens.slice(1);
  return tokens.join(' ').trim();
}

function cfLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function cfLevRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - cfLevenshtein(a, b) / maxLen;
}

function cfTrigrams(s) {
  const padded = `  ${s} `;
  const grams = new Set();
  for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

function cfTrigramSim(a, b) {
  if (a === b) return 1;
  const A = cfTrigrams(a), B = cfTrigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter); // Jaccard
}

// Candidate list [{ canonical, norm }] for a question's answer + all aliases.
function cfCandidates(answer) {
  const raw = [answer.en, answer.vi, ...(answer.aliases_en || []), ...(answer.aliases_vi || [])]
    .filter((s) => typeof s === 'string' && s.trim());
  return raw.map((canonical) => ({ canonical, norm: cfNormalize(canonical) }));
}

// → { status: 'hit' } | { status: 'confirm', suggested } | { status: 'miss' }.
function cfMatch(guess, answer) {
  const g = cfNormalize(guess);
  if (!g) return { status: 'miss' };
  const cands = cfCandidates(answer);
  for (const c of cands) if (c.norm && c.norm === g) return { status: 'hit' };
  let best = null, bestScore = 0;
  for (const c of cands) {
    if (!c.norm) continue;
    const score = Math.max(cfLevRatio(g, c.norm), cfTrigramSim(g, c.norm));
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (best && bestScore >= CF_FUZZY_THRESHOLD) {
    return { status: 'confirm', suggested: best.canonical };
  }
  return { status: 'miss' };
}

// --- Handlers ----------------------------------------------------------------

// Load a set + resolve one question index (from the request body). Throws a
// short-circuit Response on any problem. Shared by /guess and /reveal.
async function cfLoadQuestion(env, id, qIndex) {
  const raw = await env.PUZZLES.get(`catfishing:${id}`);
  if (!raw) throw json({ error: 'not found' }, 404);
  let puzzle;
  try { puzzle = JSON.parse(raw); } catch { throw json({ error: 'corrupt puzzle' }, 500); }
  if (!Number.isInteger(qIndex) || qIndex < 0 || qIndex >= (puzzle.questions?.length || 0)) {
    throw json({ error: 'invalid q_index' }, 400);
  }
  return { puzzle, question: puzzle.questions[qIndex] };
}

// Public: validate a free-text guess for one question. Never returns the answer
// on a miss; 'confirm' echoes only the canonical the player effectively typed.
// On a hit, bumps the aggregate correct[q] counter server-side — the only place
// it's writable — best-effort, so a stats failure can't fail the guess.
async function handleCatfishingGuess(request, env, id) {
  const body = await parseJsonBody(request);
  const qIndex = body?.q_index;
  const guess = body?.guess;
  if (typeof guess !== 'string') return json({ error: 'guess required' }, 400);
  const { question } = await cfLoadQuestion(env, id, qIndex);

  const result = cfMatch(guess, question.answer);
  if (result.status === 'hit') {
    try { await cfBumpCorrect(env, id, qIndex); } catch { /* stats are best-effort */ }
  }
  return json(result);
}

// Public: reveal the canonical answer for one question. Trust model per build
// plan §9 — the client calls this after receiving hit/miss/confirm from /guess.
// Calling it early only spoils the caller's own game; no server-side session
// state is kept, deliberately.
async function handleCatfishingReveal(request, env, id) {
  const body = await parseJsonBody(request);
  const qIndex = body?.q_index;
  const { question } = await cfLoadQuestion(env, id, qIndex);
  const a = question.answer;
  return json({
    answer: {
      en: a.en,
      vi: a.vi,
      aliases_en: a.aliases_en || [],
      aliases_vi: a.aliases_vi || [],
    },
  });
}

// Public: honor-system override. When a player judges the matcher (or an
// answer's alias coverage) too strict and self-declares correct, they keep the
// point client-side; this records the self-declare in the SEPARATE overrides[q]
// counter (never in correct[q]). Deliberately player-callable and trivially
// inflatable — the same trust model as the feature itself. A rising
// overrides[q] is the editor's cue to widen that answer's aliases.
async function handleCatfishingOverride(request, env, id) {
  const body = await parseJsonBody(request);
  const qIndex = body?.q_index;
  await cfLoadQuestion(env, id, qIndex); // validates set exists + q_index in range
  await cfBumpOverride(env, id, qIndex);
  return json({ ok: true });
}

// --- Stats (aggregate only; no per-player data) ------------------------------
// KV key: stats:cf:{id} →
//   { plays, completions,
//     correct:   number[CF_QUESTION_COUNT],   // true matcher hits (server-only)
//     overrides: number[CF_QUESTION_COUNT] }  // honor-system self-declares
// KV is eventually consistent, so concurrent updates can undercount slightly —
// acceptable per build plan §5/§11. start/complete are gated client-side by a
// localStorage flag; correct[] is bumped only inside /guess. overrides[] is
// bumped by the player-callable /stats/override route and is kept SEPARATE from
// correct[] on purpose: correct% stays a true-match measure, while a high
// overrides[q] tells the editor that answer's aliases need widening.

function cfStatsKey(id) { return `stats:cf:${id}`; }

async function cfReadStats(env, id) {
  const raw = await env.PUZZLES.get(cfStatsKey(id));
  let s = null;
  if (raw) { try { s = JSON.parse(raw); } catch { s = null; } }
  if (!s || typeof s !== 'object') s = {};
  // Coerce a stored per-question array to exactly CF_QUESTION_COUNT finite
  // numbers; anything malformed (or absent, e.g. pre-overrides rows) → zeros.
  const arr = (v) => (Array.isArray(v) && v.length === CF_QUESTION_COUNT
    ? v.map((n) => (Number.isFinite(n) ? n : 0))
    : new Array(CF_QUESTION_COUNT).fill(0));
  return {
    plays: Number.isFinite(s.plays) ? s.plays : 0,
    completions: Number.isFinite(s.completions) ? s.completions : 0,
    correct: arr(s.correct),
    overrides: arr(s.overrides),
  };
}

async function cfWriteStats(env, id, stats) {
  await env.PUZZLES.put(cfStatsKey(id), JSON.stringify(stats));
}

async function cfBumpCorrect(env, id, qIndex) {
  const stats = await cfReadStats(env, id);
  stats.correct[qIndex] = (stats.correct[qIndex] || 0) + 1;
  await cfWriteStats(env, id, stats);
}

async function cfBumpOverride(env, id, qIndex) {
  const stats = await cfReadStats(env, id);
  stats.overrides[qIndex] = (stats.overrides[qIndex] || 0) + 1;
  await cfWriteStats(env, id, stats);
}

// Public: bump plays or completions. `which` is fixed by the route (not the
// request body), so a caller can only ever touch those two counters. Requires
// the set to exist so counters can't be spun up for a random id.
async function handleCatfishingStatsBump(env, id, which) {
  const exists = await env.PUZZLES.get(`catfishing:${id}`);
  if (!exists) return json({ error: 'not found' }, 404);
  const stats = await cfReadStats(env, id);
  stats[which] = (stats[which] || 0) + 1;
  await cfWriteStats(env, id, stats);
  return json({ ok: true });
}

// Public: read aggregate stats (players see completions + per-question
// correct% at end-of-set; plays is editor-facing).
async function handleCatfishingStatsGet(env, id) {
  const exists = await env.PUZZLES.get(`catfishing:${id}`);
  if (!exists) return json({ error: 'not found' }, 404);
  return json(await cfReadStats(env, id));
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

      // Catfishing: create/update/fetch reuse the generic /api/puzzle routes
      // above (type-gated by ALLOWED_TYPES; GET masks answers via maskCatfishing).
      // These game-specific routes handle guessing, reveal, and aggregate stats,
      // mirroring the Strands guess/hint pattern under /api/puzzle/{type}/{id}/*.
      const cfGuessMatch = path.match(/^\/api\/puzzle\/catfishing\/([A-Za-z0-9]+)\/guess$/);
      if (cfGuessMatch && request.method === 'POST') {
        return await handleCatfishingGuess(request, env, cfGuessMatch[1]);
      }
      const cfRevealMatch = path.match(/^\/api\/puzzle\/catfishing\/([A-Za-z0-9]+)\/reveal$/);
      if (cfRevealMatch && request.method === 'POST') {
        return await handleCatfishingReveal(request, env, cfRevealMatch[1]);
      }
      const cfStatsStartMatch = path.match(/^\/api\/puzzle\/catfishing\/([A-Za-z0-9]+)\/stats\/start$/);
      if (cfStatsStartMatch && request.method === 'POST') {
        return await handleCatfishingStatsBump(env, cfStatsStartMatch[1], 'plays');
      }
      const cfStatsCompleteMatch = path.match(/^\/api\/puzzle\/catfishing\/([A-Za-z0-9]+)\/stats\/complete$/);
      if (cfStatsCompleteMatch && request.method === 'POST') {
        return await handleCatfishingStatsBump(env, cfStatsCompleteMatch[1], 'completions');
      }
      const cfStatsOverrideMatch = path.match(/^\/api\/puzzle\/catfishing\/([A-Za-z0-9]+)\/stats\/override$/);
      if (cfStatsOverrideMatch && request.method === 'POST') {
        return await handleCatfishingOverride(request, env, cfStatsOverrideMatch[1]);
      }
      const cfStatsGetMatch = path.match(/^\/api\/puzzle\/catfishing\/([A-Za-z0-9]+)\/stats$/);
      if (cfStatsGetMatch && request.method === 'GET') {
        return await handleCatfishingStatsGet(env, cfStatsGetMatch[1]);
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
