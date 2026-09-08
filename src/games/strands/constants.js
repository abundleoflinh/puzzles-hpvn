// Shared Strands constants. If these change, mirror in worker/src/index.js
// (STRANDS_* group) — the two ranges must agree or the editor can push a
// puzzle the Worker refuses to store.

export const ROW_MIN = 4;
export const ROW_MAX = 10;
export const COL_MIN = 6;
export const COL_MAX = 8;
export const ROW_DEFAULT = 8;
export const COL_DEFAULT = 6;

export const SPANGRAM_MIN = 6;
export const SPANGRAM_MAX = 10;
export const WORD_MIN_LEN = 3;
export const WORD_MIN_COUNT = 3;
export const WORD_MAX_COUNT = 15;

export const TYPE = 'strands';

// Share tiles — mirror the NYT Strands paste format.
export const TILE_THEME = '🔵';
export const TILE_SPANGRAM = '🟡';
export const TILE_HINT = '💡';
