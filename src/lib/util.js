// Small shared utilities. Kept intentionally minimal — anything bigger
// gets its own module.

// Escape a string for safe embedding as HTML text or an attribute value.
// Escapes both quote types plus &, <, > so the same helper is safe in
// double- or single-quoted attributes.
export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Fisher-Yates shuffle. Returns a new array; never mutates the input.
export function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ============== SHORT-LINK PARSING ==============

// Puzzle short ids are 5-char base58 (see worker/src/index.js). This matches a
// bare id anywhere it appears on its own.
export const SHORT_ID_RE = /^[A-Za-z0-9]{5}$/;

// Game-type ↔ short-link prefix. Kept here so every surface (home, editor,
// play) agrees on the mapping. Add a row when a new game type ships.
export const TYPE_PREFIX = { connections: 'c', strands: 's' };
const PREFIX_TYPE = { c: 'connections', s: 'strands' };

// Parse a user-supplied puzzle reference into { type, id }, or null if it
// doesn't look like one. Accepts a bare 5-char id, a short path/hash
// ("/c/abc12", "#s/abc12"), or a full URL containing one.
//   opts.defaultType — type to assume for a bare id (default 'connections')
//   opts.types       — allowed type prefixes (default both 'c' and 's')
export function parseShortLink(raw, { defaultType = 'connections', types = ['c', 's'] } = {}) {
  const s = (raw || '').trim();
  if (!s) return null;
  if (SHORT_ID_RE.test(s)) return { type: defaultType, id: s };
  const match = s.match(new RegExp(`[/#](${types.join('|')})/([A-Za-z0-9]{5})(?:[/?#&]|$)`));
  if (match) return { type: PREFIX_TYPE[match[1]], id: match[2] };
  return null;
}

// ============== CLIPBOARD ==============

// Copy `text` to the clipboard and flash a confirmation label on `btn`,
// restoring the original label after `revertMs`. Runs `onFallback` if the
// Clipboard API is unavailable or blocked (e.g. insecure context).
export async function copyWithFeedback(btn, text, copiedLabel, { revertMs = 1500, onFallback } = {}) {
  if (!btn) return;
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = copiedLabel;
    setTimeout(() => { btn.textContent = original; }, revertMs);
  } catch {
    if (typeof onFallback === 'function') onFallback();
  }
}
