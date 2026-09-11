// Build the Strands share paste. Mirrors NYT Strands format:
//   Title
//   Theme clue
//   Emoji sequence — one tile per event, in the order they happened.
//     🔵 theme word found
//     🟡 spangram found
//     💡 hint used
//   Link
//
// `events` is an ordered array of { kind: 'theme'|'spangram'|'hint' }.

import { TILE_THEME, TILE_SPANGRAM, TILE_HINT } from './constants.js';

function tileFor(kind) {
  if (kind === 'spangram') return TILE_SPANGRAM;
  if (kind === 'hint') return TILE_HINT;
  return TILE_THEME;
}

// All tiles on one line. NYT-style. Chat clients that collapse newlines
// won't insert spurious spaces mid-tile-run this way.
export function buildShareText({ title, theme, events, url }) {
  const tiles = (events || []).map((e) => tileFor(e.kind)).join('');
  // Every block on its own line, no blank lines — title, theme, tiles, link.
  const lines = [];
  if (title) lines.push(title);
  if (theme) lines.push(`"${theme}"`);
  if (tiles) lines.push(tiles);
  if (url) lines.push(url);
  return lines.join('\n');
}
