import './styles/base.css';
import { initChrome } from './lib/chrome.js';
import { t } from './lib/i18n.js';
import { listCollections, fetchPuzzle } from './lib/api.js';
import { escapeHtml, parseShortLink, SHORT_ID_RE, TYPE_PREFIX } from './lib/util.js';

// Per-game play page path. When adding a new game, add a row here and mirror
// it in vite.config.js (input) and public/_redirects. Falls back to the
// Connections page for unknown types so a stale link never 404s outright.
const PLAY_PAGE = {
  connections: '/play-connections.html',
  strands: '/play-strands.html',
  // play-catfishing.html lands in Step 6; until then a /cf/ link resolves here
  // but the page 404s. The mapping is correct now so no relink is needed later.
  catfishing: '/play-catfishing.html',
};
function playHref(type, id) {
  const page = PLAY_PAGE[type] || PLAY_PAGE.connections;
  const prefix = TYPE_PREFIX[type] || 'c';
  return `${page}#${prefix}/${encodeURIComponent(id)}`;
}

async function onSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('puzzle-input');
  const err = document.getElementById('puzzle-error');
  const raw = input.value.trim();
  const parsed = parseShortLink(raw);
  if (!parsed) {
    err.textContent = t('home.input.invalid');
    err.hidden = false;
    return;
  }
  err.hidden = true;
  // A bare 5-char id doesn't tell us the game type; parseShortLink defaults
  // to Connections. Probe both endpoints so a Strands id pasted directly
  // still resolves. URL-prefixed inputs (/c/, /s/, #c/, #s/) skip the probe.
  if (SHORT_ID_RE.test(raw)) {
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      for (const type of ['connections', 'strands', 'catfishing']) {
        try {
          await fetchPuzzle(type, raw);
          window.location.href = playHref(type, raw);
          return;
        } catch (e2) {
          if (e2.status !== 404) throw e2;
        }
      }
      err.textContent = t('home.input.invalid');
      err.hidden = false;
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
    return;
  }
  window.location.href = playHref(parsed.type, parsed.id);
}

// ============== COLLECTIONS ==============

// Display order for game types within a collection. The Worker returns type
// groups sorted alphabetically (catfishing, connections, strands); we override
// that here to a deliberate order. Unknown types sink to the end, alphabetically.
const TYPE_ORDER = ['connections', 'strands', 'catfishing'];
function typeRank(type) {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? TYPE_ORDER.length : i;
}

// The displayed label for a puzzle. Title falls back to "Puzzle #{id}" when the
// editor didn't set one. Shared by the sort and the <li> render so both agree.
function puzzleLabel(puzzle) {
  return puzzle.title || t('home.collections.puzzleFallback', { id: puzzle.id });
}

// Turn one puzzle entry into an <li> with a numbered link.
function renderPuzzleLi(puzzle) {
  const href = playHref(puzzle.type, puzzle.id);
  return `<li><a href="${href}">${escapeHtml(puzzleLabel(puzzle))}</a></li>`;
}

// Render one collection: name, then one numbered <ol> per game type
// (labeled with the type name when the collection is cross-game).
function renderCollection(collection) {
  const groups = Array.isArray(collection.typeGroups) ? collection.typeGroups : [];
  // Skip collections that have no puzzles at all — nothing to show.
  const nonEmpty = groups
    .filter((g) => Array.isArray(g.puzzles) && g.puzzles.length > 0)
    .sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.type.localeCompare(b.type));
  if (!nonEmpty.length) return '';

  // One column per game type, always with a heading — even when only one
  // type is present — so the game-type structure is visible at a glance.
  // Empty type groups are filtered above, so they won't render.
  const groupsHtml = nonEmpty
    .map((g) => {
      const heading = `<h4 class="collection-type-heading">${escapeHtml(t(`home.collections.type.${g.type}`))}</h4>`;
      // Sort puzzles alphabetically by their displayed label (the Worker returns
      // them oldest-first by createdAt). `numeric` gives natural order so a title
      // like "#2" sorts before "#10". Sort a copy — never mutate the API payload.
      const sorted = [...g.puzzles].sort((a, b) =>
        puzzleLabel(a).localeCompare(puzzleLabel(b), undefined, { numeric: true, sensitivity: 'base' })
      );
      const items = sorted.map(renderPuzzleLi).join('');
      return `<div class="collection-group">${heading}<ol class="collection-list">${items}</ol></div>`;
    })
    .join('');

  return `
    <article class="collection">
      <h3 class="collection-name">${escapeHtml(collection.name)}</h3>
      <div class="collection-groups">${groupsHtml}</div>
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
