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

// Tile-wrap: 5 per line matches the NYT share layout roughly and keeps long
// lines from wrapping awkwardly in chat clients.
const WRAP = 5;

export function buildShareText({ title, theme, events, url }) {
  const tiles = (events || []).map((e) => tileFor(e.kind));
  const rows = [];
  for (let i = 0; i < tiles.length; i += WRAP) rows.push(tiles.slice(i, i + WRAP).join(''));
  const lines = [];
  if (title) lines.push(title);
  if (theme) lines.push(`"${theme}"`);
  lines.push(...rows);
  if (url) lines.push(url);
  return lines.join('\n');
}
