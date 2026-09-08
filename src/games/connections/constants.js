// Shared Connections constants + normalization helpers used by both the play
// page and the editor. Keeping them here means the two surfaces can't drift on
// what counts as a valid size or how a legacy difficulty maps to a tier.
//
// Note: the Worker (worker/src/index.js) deliberately keeps its own copies of
// these bounds. It's a separate deployment/runtime, and wiring a shared import
// across the Pages/Worker boundary would add build coupling for little gain —
// so if you change the range here, mirror it in the Worker's validatePuzzle.

export const MIN_SIZE = 3;
export const MAX_SIZE = 6;
export const DEFAULT_SIZE = 4;
export const DEFAULT_MISTAKES = 4;

// Legacy string difficulties on puzzles saved before the numeric-tier
// migration. yellow→1 (easiest) … purple/red→4 (hardest).
export const LEGACY_DIFFICULTY_MAP = { yellow: 1, green: 2, blue: 3, red: 4, purple: 4 };

// Coerce a difficulty field to a numeric tier. Numeric passthrough; legacy
// strings map via LEGACY_DIFFICULTY_MAP; anything else falls back to `fallback`.
export function coerceDifficulty(d, fallback) {
  if (Number.isInteger(d)) return d;
  if (typeof d === 'string' && d in LEGACY_DIFFICULTY_MAP) return LEGACY_DIFFICULTY_MAP[d];
  return fallback;
}

// Determine a puzzle's grid size: an explicit in-range `size` wins, else infer
// from the first group's word count. Returns null when neither yields a value
// in [MIN_SIZE, MAX_SIZE] — callers treat that as a structurally unusable
// puzzle. `fallback` (when provided) is returned instead of null when nothing
// is inferable at all (used by the editor, which defaults to DEFAULT_SIZE).
export function inferSize(puzzle, fallback = null) {
  const p = puzzle || {};
  if (Number.isInteger(p.size) && p.size >= MIN_SIZE && p.size <= MAX_SIZE) return p.size;
  if (Array.isArray(p.groups) && p.groups[0] && Array.isArray(p.groups[0].words)) {
    const inferred = p.groups[0].words.length;
    if (inferred >= MIN_SIZE && inferred <= MAX_SIZE) return inferred;
    // A first group whose word count is out of range means the payload is
    // corrupt — refuse rather than guess, even if a fallback was offered.
    return null;
  }
  return fallback;
}
