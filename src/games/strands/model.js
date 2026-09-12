// Strands path/grid model. Client-side validation mirrors the Worker's
// validateStrands so the editor can catch problems before submit. The Worker
// remains the authority — if the two ever drift the server rejects the write.

import {
  ROW_MIN, ROW_MAX, COL_MIN, COL_MAX,
  SPANGRAM_MIN, SPANGRAM_MAX,
  WORD_MIN_LEN, WORD_MIN_COUNT, WORD_MAX_COUNT,
} from './constants.js';

// Normalize author input to grid-storage form: strip diacritics, uppercase,
// drop anything that isn't A–Z. Puzzles are ASCII-only per the design
// (see the Solution Brief: "Skip diacritics").
export function normalizeLetters(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

// 8-neighborhood adjacency on a rows×cols grid, indexed row-major.
export function areAdjacent(a, b, cols) {
  if (a === b) return false;
  const ra = Math.floor(a / cols), ca = a % cols;
  const rb = Math.floor(b / cols), cb = b % cols;
  return Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1;
}

// The eight neighbor cell indices around `idx` (skips out-of-bounds neighbors).
export function neighbors(idx, rows, cols) {
  const r = Math.floor(idx / cols), c = idx % cols;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      out.push(nr * cols + nc);
    }
  }
  return out;
}

// Which edges of a rows×cols grid does cell `idx` lie on? Corner cells lie
// on two. Row-major indexing.
function edgesOfCell(idx, rows, cols) {
  const r = Math.floor(idx / cols), c = idx % cols;
  return { top: r === 0, bottom: r === rows - 1, left: c === 0, right: c === cols - 1 };
}

// Does `path` START on one edge and END on the opposite edge? Only the two
// endpoints count — a mid-path cell that happens to touch an edge does not.
// (This is stricter than the old "touches opposite edges anywhere" rule.)
export function spansOppositeEdges(path, rows, cols) {
  if (!Array.isArray(path) || path.length < 2) return false;
  const a = edgesOfCell(path[0], rows, cols);
  const b = edgesOfCell(path[path.length - 1], rows, cols);
  return (a.top && b.bottom) || (a.bottom && b.top) ||
         (a.left && b.right) || (a.right && b.left);
}

// Validate one path against a grid + expected word. Returns null on success
// or a short error string. Does not check overlaps — the caller aggregates
// covered cells across all paths and checks coverage separately.
export function validatePathForWord({ word, path, grid, rows, cols }) {
  if (!Array.isArray(path)) return 'path must be an array';
  if (path.length !== word.length) return 'path length must equal word length';
  const seen = new Set();
  const cellCount = rows * cols;
  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    if (!Number.isInteger(idx) || idx < 0 || idx >= cellCount) return `path[${i}] out of range`;
    if (seen.has(idx)) return `path revisits cell ${idx}`;
    seen.add(idx);
    if (grid[idx] !== word[i]) return `letter mismatch at path[${i}]`;
    if (i > 0 && !areAdjacent(path[i - 1], idx, cols)) return `path not 8-adjacent at step ${i}`;
  }
  return null;
}

// Full puzzle validation, used by the editor before submit.
// puzzle shape: { rows, cols, grid[], spangram:{word,path}, words:[{word,path}] }
export function validatePuzzle(puzzle) {
  const { rows, cols, grid, spangram, words } = puzzle || {};
  if (!Number.isInteger(rows) || rows < ROW_MIN || rows > ROW_MAX) return `rows must be [${ROW_MIN}, ${ROW_MAX}]`;
  if (!Number.isInteger(cols) || cols < COL_MIN || cols > COL_MAX) return `cols must be [${COL_MIN}, ${COL_MAX}]`;
  const cellCount = rows * cols;
  if (!Array.isArray(grid) || grid.length !== cellCount) return `grid must be ${cellCount} letters`;
  for (const ch of grid) {
    if (typeof ch !== 'string' || !/^[A-Z]$/.test(ch)) return 'grid letters must be single uppercase A–Z';
  }
  if (!spangram || typeof spangram.word !== 'string' || !/^[A-Z]+$/.test(spangram.word)) return 'spangram required';
  if (spangram.word.length < SPANGRAM_MIN || spangram.word.length > SPANGRAM_MAX) {
    return `spangram length must be [${SPANGRAM_MIN}, ${SPANGRAM_MAX}]`;
  }
  if (!Array.isArray(words) || words.length < WORD_MIN_COUNT || words.length > WORD_MAX_COUNT) {
    return `words count must be in [${WORD_MIN_COUNT}, ${WORD_MAX_COUNT}]`;
  }

  const covered = new Array(cellCount).fill(false);
  const checkOne = (word, path, label) => {
    const err = validatePathForWord({ word, path, grid, rows, cols });
    if (err) return `${label}: ${err}`;
    for (const idx of path) {
      if (covered[idx]) return `${label} overlaps another path at cell ${idx}`;
      covered[idx] = true;
    }
    return null;
  };
  const spanErr = checkOne(spangram.word, spangram.path, 'spangram');
  if (spanErr) return spanErr;
  if (!spansOppositeEdges(spangram.path, rows, cols)) return 'spangram must start and end on opposite edges';

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || typeof w.word !== 'string' || !/^[A-Z]+$/.test(w.word)) return `words[${i}].word invalid`;
    if (w.word.length < WORD_MIN_LEN) return `words[${i}] must be at least ${WORD_MIN_LEN} letters`;
    const err = checkOne(w.word, w.path, `words[${i}]`);
    if (err) return err;
  }
  for (let i = 0; i < cellCount; i++) {
    if (!covered[i]) return `cell ${i} not covered by any path`;
  }
  return null;
}

// Sum of letters across spangram + words — used by the editor's live
// validator ("You have N letters, need M more"). Total must equal rows×cols.
export function totalLetters(spangramWord, wordList) {
  let n = spangramWord ? spangramWord.length : 0;
  for (const w of wordList || []) n += (w || '').length;
  return n;
}
