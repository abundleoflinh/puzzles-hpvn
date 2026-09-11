// Author-time EN→VI category resolver for the Catfishing editor.
//
// PLACEMENT NOTE (divergence from Build Plan §4, confirmed with Linh):
// The plan tentatively filed this under `worker/src/lib/dict-resolver.js`, but
// it runs in the *browser editor* at author time, not in the Worker. Keeping it
// here in `src/games/catfishing/` lets Vite bundle it into the (dynamically
// imported) Catfishing editor chunk and import the committed dictionaries
// directly. The Worker path stays out of the frontend build entirely.
//
// Given a raw EN Fandom category string, produce its Vietnamese rendering by:
//   1. Direct hit in dict_terms (by normalized EN or the aliases index) → VI.
//   2. Template match (e.g. "{X} members") whose slot X is a known term →
//      substitute the term's VI into the VI pattern.
//   3. Template match whose slot X is unknown → return the VI pattern with the
//      slot still to fill (editor prompts the author for the slot translation).
//   4. No match → unresolved (author fills VI by hand).
//
// The dictionaries are the committed build outputs of scripts/build-dicts.mjs
// (see Build Plan §5). `terms` is keyed by normalized (trim+lowercase) EN;
// `aliases` maps a normalized alias → the canonical term key.

import termsDict from '../../../data/dict_terms.json';
import templatesDict from '../../../data/dict_templates.json';

const TERMS = termsDict.terms || {};
const ALIASES = termsDict.aliases || {};
const TEMPLATES = templatesDict.templates || [];

// Match the key normalization used by build-dicts.mjs: trim + lowercase +
// collapse internal whitespace. (The build script trims and lowercases; we also
// collapse runs of whitespace so a double-spaced author input still resolves.)
export function normalizeKey(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Resolve a normalized key to a term record, following the alias index one hop.
// Returns the term object ({ en, vi, aliases_en }) or null.
function lookupTerm(normKey) {
  if (!normKey) return null;
  if (TERMS[normKey]) return TERMS[normKey];
  const canonical = ALIASES[normKey];
  if (canonical && TERMS[canonical]) return TERMS[canonical];
  return null;
}

// Escape a string for use as a literal inside a RegExp.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Precompile each template into a matcher. Exactly one `{X}` slot per side is
// guaranteed by build-dicts.mjs, so we split on the single placeholder, escape
// the literal halves, and capture the slot. Whitespace in the literal halves is
// made flexible (\s+) so authoring/scrape spacing quirks still match. Matching
// is case-insensitive and anchored to the whole string.
const COMPILED_TEMPLATES = TEMPLATES.map((tpl) => {
  const [before, after] = tpl.pattern_en.split('{X}');
  // A malformed template (no slot) can't match anything — skip it defensively.
  if (after === undefined) return null;
  const pattern =
    '^' +
    escapeRegex(before).replace(/\s+/g, '\\s+') +
    '(.+?)' +
    escapeRegex(after).replace(/\s+/g, '\\s+') +
    '$';
  return { re: new RegExp(pattern, 'i'), pattern_vi: tpl.pattern_vi };
}).filter(Boolean);

/**
 * Resolve one raw EN category.
 *
 * Returns one of:
 *   { status: 'direct',              vi, en }            — dict_terms hit (green)
 *   { status: 'template',            vi, slot, slotVi }  — template + known slot (green)
 *   { status: 'template_unresolved', pattern_vi, slot }  — template, unknown slot (yellow)
 *   { status: 'unresolved' }                             — no match (red)
 */
export function resolveCategory(rawEn) {
  const raw = String(rawEn ?? '').trim();
  if (!raw) return { status: 'unresolved' };

  // 1. Direct term / alias hit.
  const direct = lookupTerm(normalizeKey(raw));
  if (direct) return { status: 'direct', vi: direct.vi, en: direct.en };

  // 2 & 3. Template match. First template that matches wins (authoring order).
  for (const tpl of COMPILED_TEMPLATES) {
    const m = raw.match(tpl.re);
    if (!m) continue;
    const slot = m[1].trim();
    const slotTerm = lookupTerm(normalizeKey(slot));
    if (slotTerm) {
      // Known slot → full VI. Substitute the term's VI into the VI pattern.
      return {
        status: 'template',
        vi: tpl.pattern_vi.replace('{X}', slotTerm.vi),
        slot,
        slotVi: slotTerm.vi,
      };
    }
    // Matched a template but the slot term is unknown — hand the author the VI
    // pattern with the slot still open so they only translate the slot.
    return { status: 'template_unresolved', pattern_vi: tpl.pattern_vi, slot };
  }

  // 4. No match.
  return { status: 'unresolved' };
}

// Convenience: resolve a list of raw EN categories to per-clue records the
// editor can render directly. Each record carries the original EN, a suggested
// VI (empty when unresolved), and the resolver status for colour-coding.
export function resolveCategories(rawList) {
  return (rawList || []).map((en) => {
    const r = resolveCategory(en);
    let vi = '';
    if (r.status === 'direct' || r.status === 'template') vi = r.vi;
    return { en, vi, status: r.status, detail: r };
  });
}
