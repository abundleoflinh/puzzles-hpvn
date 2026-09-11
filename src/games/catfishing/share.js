// Build the Catfishing share paste. One line of tiles, one per question in
// order, plus the score and the link:
//   Title
//   ✅✅❌🟰✅  (per-question outcome)
//   3/5
//   Link
//
// Tiles:
//   ✅  hit — matched by the server
//   🟰  override — self-declared correct (honor system); still a point, but
//       flagged distinctly so a shared result stays honest about how it landed
//   ❌  miss
//
// `outcomes` is an ordered array of 'hit' | 'override' | 'miss'.

const TILE = { hit: '✅', override: '🟰', miss: '❌' };

function tileFor(outcome) {
  return TILE[outcome] || TILE.miss;
}

export function buildShareText({ title, outcomes, score, total, url }) {
  const tiles = (outcomes || []).map(tileFor).join('');
  const lines = [];
  if (title) lines.push(title);
  if (tiles) lines.push(tiles);
  lines.push(`${score}/${total}`);
  if (url) lines.push(url);
  return lines.join('\n');
}
