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
