import './styles/base.css';
import { initChrome } from './lib/chrome.js';
import { t } from './lib/i18n.js';
import { listCollections } from './lib/api.js';
import { escapeHtml, parseShortLink, TYPE_PREFIX } from './lib/util.js';

// Per-game play page path. When adding a new game, add a row here and mirror
// it in vite.config.js (input) and public/_redirects. Falls back to the
// Connections page for unknown types so a stale link never 404s outright.
const PLAY_PAGE = {
  connections: '/play-connections.html',
  strands: '/play-strands.html',
};
function playHref(type, id) {
  const page = PLAY_PAGE[type] || PLAY_PAGE.connections;
  const prefix = TYPE_PREFIX[type] || 'c';
  return `${page}#${prefix}/${encodeURIComponent(id)}`;
}

function onSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('puzzle-input');
  const err = document.getElementById('puzzle-error');
  // Accept a bare 5-char id, "/c/abc12", "/s/abc12", "#c/abc12", or a full URL.
  const parsed = parseShortLink(input.value);
  if (!parsed) {
    err.textContent = t('home.input.invalid');
    err.hidden = false;
    return;
  }
  err.hidden = true;
  window.location.href = playHref(parsed.type, parsed.id);
}

// ============== COLLECTIONS ==============

// Turn one puzzle entry into an <li> with a numbered link. Title falls back
// to "Puzzle #{id}" when the editor didn't set one.
function renderPuzzleLi(puzzle) {
  const href = playHref(puzzle.type, puzzle.id);
  const label = puzzle.title || t('home.collections.puzzleFallback', { id: puzzle.id });
  return `<li><a href="${href}">${escapeHtml(label)}</a></li>`;
}

// Render one collection: name, then one numbered <ol> per game type
// (labeled with the type name when the collection is cross-game).
function renderCollection(collection) {
  const groups = Array.isArray(collection.typeGroups) ? collection.typeGroups : [];
  // Skip collections that have no puzzles at all — nothing to show.
  const nonEmpty = groups.filter((g) => Array.isArray(g.puzzles) && g.puzzles.length > 0);
  if (!nonEmpty.length) return '';

  const isMixed = nonEmpty.length > 1;
  const groupsHtml = nonEmpty
    .map((g) => {
      const heading = isMixed
        ? `<h4 class="collection-type-heading">${escapeHtml(t(`home.collections.type.${g.type}`))}</h4>`
        : '';
      const items = g.puzzles.map(renderPuzzleLi).join('');
      return `${heading}<ol class="collection-list">${items}</ol>`;
    })
    .join('');

  return `
    <article class="collection">
      <h3 class="collection-name">${escapeHtml(collection.name)}</h3>
      ${groupsHtml}
    </article>
  `;
}

async function renderCollections() {
  const slot = document.getElementById('collections-slot');
  if (!slot) return;
  try {
    const res = await listCollections();
    const collections = Array.isArray(res?.collections) ? res.collections : [];
    // The Worker already sorts alphabetically and drops empty entries at
    // the type-group level, but a collection with zero puzzles across all
    // types is filtered out here rather than shown as a bare heading.
    const html = collections.map(renderCollection).join('');
    if (!html.trim()) {
      slot.innerHTML = '';
      return;
    }
    slot.innerHTML = `
      <h2 class="collections-heading">${escapeHtml(t('home.collections.heading'))}</h2>
      ${html}
    `;
  } catch {
    // Silent failure: the home page still works as a puzzle-code entry
    // point even when the collections endpoint is down.
    slot.innerHTML = '';
  }
}

initChrome();
document.getElementById('play-form').addEventListener('submit', onSubmit);
renderCollections();
// Language flip needs a re-render so type headings + fallback titles switch too.
window.addEventListener('lang-changed', renderCollections);
