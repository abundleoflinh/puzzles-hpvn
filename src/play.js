// Play page: Connections game.
// URL: /play.html#c/{id}
// Flow: fetch puzzle → apply theme → render grid → gameplay loop → win/lose result.
//
// The full puzzle (including group answers) travels in the initial GET response;
// the client validates guesses locally against puzzle.groups. This keeps the
// game snappy and works offline once loaded.

import './styles/base.css';
import { initChrome } from './lib/chrome.js';
import { t } from './lib/i18n.js';
import { fetchPuzzle } from './lib/api.js';
import { getProgress, setProgress, clearProgress, getTheme } from './lib/storage.js';
import { getActiveTheme, applyTheme } from './lib/theme.js';

const DIFFICULTY_EMOJI = {
  yellow: '🟨',
  green:  '🟩',
  blue:   '🟦',
  red:    '🟪',  // Legacy key name; --diff-4 is purple in the unified palette.
};

let puzzle = null;    // { groups: [{name, words, difficulty}], mistakeMode, defaultTheme, createdAt }
let puzzleId = null;
let state = null;     // see main() for shape

// Module-level timers so we can cancel them across re-renders / resizes.
let feedbackTimer = null;
let resizeTimer = null;

// ============== URL PARSE ==============

function parseUrl() {
  const m = window.location.hash.match(/^#c\/([A-Za-z0-9]{5})$/);
  return m ? m[1] : null;
}

// ============== INIT ==============

async function main() {
  puzzleId = parseUrl();
  if (!puzzleId) {
    renderError(t('play.error.notFound'));
    return;
  }

  renderLoading();

  try {
    const res = await fetchPuzzle('connections', puzzleId);
    puzzle = res.puzzle;
  } catch (err) {
    if (err.status === 404) renderError(t('play.error.notFound'));
    else renderError(t('play.error.generic'));
    return;
  }

  // Apply puzzle's default theme only if user hasn't picked one themselves.
  if (!getTheme() && puzzle.defaultTheme) {
    applyTheme(puzzle.defaultTheme);
  }

  // Restore progress. solvedGroups holds full group objects; on a loss we push
  // any remaining groups into it so the player sees the full solution.
  const saved = getProgress('connections', puzzleId);
  const solvedGroups = saved?.solvedGroups || saved?.foundGroups || [];
  const allWords = puzzle.groups.flatMap((g) => g.words);
  const solvedWords = new Set(solvedGroups.flatMap((g) => g.words));
  const remainingWords = allWords.filter((w) => !solvedWords.has(w));

  state = {
    selected: new Set(),
    solvedGroups,
    mistakes: saved?.mistakes || 0,
    attempts: saved?.attempts || 0,
    guessHistory: saved?.guessHistory || [],
    remainingWords: shuffle(remainingWords),
    feedback: null,
  };

  render();
}

// ============== HELPERS ==============

function mainSlot() {
  return document.querySelector('[data-slot="main"]');
}

function isEndless() {
  return puzzle?.mistakeMode === 'endless';
}

function isDone() {
  if (!state) return false;
  const mistakesLeft = isEndless() ? Infinity : Math.max(0, 4 - state.mistakes);
  return state.solvedGroups.length === 4 || (!isEndless() && mistakesLeft === 0);
}

// ============== RENDERERS ==============

function renderLoading() {
  mainSlot().innerHTML = `<div class="play-loading">${t('play.loading')}</div>`;
}

function renderError(msg) {
  mainSlot().innerHTML = `
    <div class="play-error">
      <p>${msg}</p>
      <a href="/">${t('play.error.backHome')}</a>
    </div>
  `;
}

function render() {
  const main = mainSlot();
  const done = isDone();
  const won = state.solvedGroups.length === 4;

  // Mount the shell once. Subsequent renders update slots in place, so existing
  // solved rows aren't re-created — otherwise the CSS entrance animation fires
  // on every guess and the whole strip flashes.
  if (!main.querySelector('#grid')) {
    main.innerHTML = `
      <div class="play-header">
        <h1>${t('play.puzzleId', { id: puzzleId })}</h1>
      </div>
      <div class="solved-rows" id="solved-rows"></div>
      <div class="grid" id="grid"></div>
      <div class="feedback" id="feedback"></div>
      <div class="mistakes" id="mistakes"></div>
      <div class="play-controls" id="controls"></div>
      <div id="result-slot"></div>
    `;
  } else {
    // Shell already mounted; keep the h1 in sync with current language.
    const h1 = main.querySelector('.play-header h1');
    if (h1) h1.textContent = t('play.puzzleId', { id: puzzleId });
  }

  renderSolvedRows();
  renderGrid();  // idempotent — clears then re-appends state.remainingWords (empty when done)
  renderMistakes();
  renderControls(done);
  restoreFeedback();

  if (done) renderResult(won);
}

// Force a full re-mount on the next render() — used when the whole DOM needs
// to be rebuilt (language change, "Play again" reset).
function invalidateShell() {
  const grid = document.getElementById('grid');
  if (grid) grid.id = '';
}

function renderSolvedRows() {
  const container = document.getElementById('solved-rows');
  if (!container) return;
  // Append only rows that aren't already in the DOM — keyed by difficulty since
  // each puzzle has one group per difficulty. Existing rows stay put, so their
  // entrance animation doesn't re-fire on every render.
  const existing = new Set(
    [...container.querySelectorAll('.solved-row')].map((r) => r.getAttribute('data-difficulty'))
  );
  for (const g of state.solvedGroups) {
    if (existing.has(g.difficulty)) continue;
    const row = document.createElement('div');
    row.className = 'solved-row';
    row.setAttribute('data-difficulty', g.difficulty);
    row.innerHTML = `
      <div class="solved-row-name">${escapeHtml(g.name)}</div>
      <div class="solved-row-words">${g.words.map(escapeHtml).join(', ')}</div>
    `;
    container.appendChild(row);
  }
}

function renderGrid() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const word of state.remainingWords) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.textContent = word;
    tile.setAttribute('data-word', word);
    if (state.selected.has(word)) tile.classList.add('selected');
    tile.addEventListener('click', () => onTileClick(word));
    grid.appendChild(tile);
  }
  fitAllTiles();
}

function renderMistakes() {
  const el = document.getElementById('mistakes');
  if (!el) return;
  if (isEndless()) {
    el.innerHTML = `
      <span class="endless-pill">
        <span class="endless-pill-label">${t('play.mistakes.endless')}</span>
        <span class="endless-pill-dot" aria-hidden="true"></span>
        <span class="endless-pill-count">${t('play.mistakes.attempt', { n: state.attempts })}</span>
      </span>
    `;
    return;
  }
  const used = state.mistakes;
  const isHpvn = getActiveTheme() === 'hpvn';
  const items = [];
  for (let i = 0; i < 4; i++) {
    const isUsed = i < used;
    if (isHpvn) {
      items.push(`<span class="mistake-icon ${isUsed ? 'used' : ''}">${isUsed ? '💀' : '🪄'}</span>`);
    } else {
      items.push(`<span class="mistake-dot ${isUsed ? 'used' : ''}"></span>`);
    }
  }
  el.innerHTML = `
    <span>${t('play.mistakes.remaining')}</span>
    <span class="mistake-dots">${items.join('')}</span>
  `;
}

function renderControls(done) {
  const el = document.getElementById('controls');
  if (!el) return;
  if (done) { el.innerHTML = ''; return; }
  const selectedCount = state.selected.size;
  el.innerHTML = `
    <button type="button" class="btn" id="btn-shuffle">${t('play.controls.shuffle')}</button>
    <button type="button" class="btn" id="btn-deselect" ${selectedCount === 0 ? 'disabled' : ''}>${t('play.controls.deselect')}</button>
    <button type="button" class="btn btn-primary" id="btn-submit" ${selectedCount !== 4 ? 'disabled' : ''}>${t('play.controls.submit')}</button>
  `;
  document.getElementById('btn-shuffle').addEventListener('click', onShuffle);
  document.getElementById('btn-deselect').addEventListener('click', onDeselect);
  document.getElementById('btn-submit').addEventListener('click', onSubmit);
}

function setFeedback(message, tone = '') {
  const el = document.getElementById('feedback');
  if (!el) return;
  if (feedbackTimer) { clearTimeout(feedbackTimer); feedbackTimer = null; }
  state.feedback = message ? { message, tone } : null;
  if (!message) {
    el.textContent = '';
    el.classList.remove('visible');
    el.setAttribute('data-tone', '');
    return;
  }
  el.textContent = message;
  el.setAttribute('data-tone', tone);
  // Force reflow to reset opacity transition
  void el.offsetWidth;
  el.classList.add('visible');
  feedbackTimer = setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => {
      state.feedback = null;
      const stillEl = document.getElementById('feedback');
      if (stillEl) stillEl.textContent = '';
    }, 400);
    feedbackTimer = null;
  }, 2500);
}

// Restore feedback message after a full re-render (state.feedback persists between renders).
function restoreFeedback() {
  if (!state.feedback) return;
  const el = document.getElementById('feedback');
  if (!el) return;
  el.textContent = state.feedback.message;
  el.setAttribute('data-tone', state.feedback.tone || '');
  el.classList.add('visible');
}

// ============== TILE TEXT FITTING ==============

// Measure a tile and shrink its font-size until its content fits. If it still
// overflows at MIN_FONT, allow wrap via .tile-wrap.
// Font-fitting bounds. MAX_FONT_CAP keeps short words from looking absurd on
// huge tiles. Two floors: single-line first, wrap fallback (up to 3 lines) if
// single-line can't fit above MIN_FONT_SINGLE.
const MAX_FONT_CAP = 22;
const MIN_FONT_SINGLE = 14;  // below this, prefer wrapping instead of shrinking further
const MIN_FONT_WRAP = 13;    // absolute floor when wrapping
const MAX_LINES = 3;

function fitTileText(tileEl) {
  if (!tileEl) return;
  tileEl.classList.remove('tile-wrap');
  tileEl.style.fontSize = '';
  const width = tileEl.clientWidth;
  const height = tileEl.clientHeight;
  if (!width || !height) return;
  // Start size proportional to tile size (~28% of the smaller dimension), capped.
  const startSize = Math.min(MAX_FONT_CAP, Math.max(MIN_FONT_WRAP, Math.floor(Math.min(width, height) * 0.28)));

  // Phase 1: single line. Shrink down to MIN_FONT_SINGLE.
  for (let size = startSize; size >= MIN_FONT_SINGLE; size--) {
    tileEl.style.fontSize = size + 'px';
    if (tileEl.scrollWidth <= width && tileEl.scrollHeight <= height) return;
  }

  // Phase 2: allow wrap (up to MAX_LINES). Shrink down to MIN_FONT_WRAP.
  tileEl.classList.add('tile-wrap');
  for (let size = startSize; size >= MIN_FONT_WRAP; size--) {
    tileEl.style.fontSize = size + 'px';
    const lineHeight = parseFloat(getComputedStyle(tileEl).lineHeight) || size * 1.25;
    const maxHeight = lineHeight * MAX_LINES;
    if (tileEl.scrollHeight <= Math.min(height, maxHeight) && tileEl.scrollWidth <= width) return;
  }
  // Fallback: hold at the wrap floor even if still overflowing (very rare).
}

function fitAllTiles() {
  // Defer to the next frame so aspect-ratio layout is settled before measuring.
  requestAnimationFrame(() => {
    document.querySelectorAll('.tile').forEach(fitTileText);
  });
}

// ============== ACTIONS ==============

function onTileClick(word) {
  if (state.selected.has(word)) {
    state.selected.delete(word);
  } else {
    if (state.selected.size >= 4) return;
    state.selected.add(word);
  }
  setFeedback('');
  renderGrid();
  renderControls(false);
}

function onShuffle() {
  state.remainingWords = shuffle(state.remainingWords);
  setFeedback('');
  renderGrid();
}

function onDeselect() {
  state.selected.clear();
  setFeedback('');
  renderGrid();
  renderControls(false);
}

async function onSubmit() {
  const picked = [...state.selected];
  if (picked.length !== 4) return;

  // Check "already guessed" — same set of 4 words (order-independent).
  const pickedKey = [...picked].sort().join('|');
  const alreadyGuessed = state.guessHistory.some(
    (h) => h.words && [...h.words].sort().join('|') === pickedKey
  );
  if (alreadyGuessed) {
    setFeedback(t('play.feedback.alreadyGuessed'), 'hint');
    return;
  }

  // Validate the guess locally against the known groups.
  const pickedDifficulties = picked.map((w) => findDifficulty(w));
  const firstDiff = pickedDifficulties[0];
  const allSame = pickedDifficulties.every((d) => d === firstDiff);

  // Record the guess (real difficulties either way — good for share tiles).
  state.guessHistory.push({ words: picked, difficulties: pickedDifficulties });
  state.attempts++;

  if (allSame) {
    const group = puzzle.groups.find((g) => g.difficulty === firstDiff);
    animateTiles(picked, 'pop');
    await sleep(300);
    state.solvedGroups.push(group);
    state.remainingWords = state.remainingWords.filter((w) => !picked.includes(w));
    setFeedback('');
  } else {
    // Wrong — shake, deduct, maybe show "one away".
    animateTiles(picked, 'shake');
    state.mistakes++;
    const oneAway = isOneAway(pickedDifficulties);
    setFeedback(oneAway ? t('play.feedback.oneAway') : t('play.feedback.wrong'), 'hint');
    await sleep(450);
  }

  // Shared tail for both branches.
  state.selected.clear();
  persist();
  render();
}

// "One away" = exactly 3 of 4 picked words share a difficulty. Since we know
// every word's difficulty locally, this is exact.
function isOneAway(difficulties) {
  const counts = {};
  for (const d of difficulties) counts[d] = (counts[d] || 0) + 1;
  return Object.values(counts).some((c) => c === 3);
}

function findDifficulty(word) {
  for (const g of puzzle.groups) {
    if (g.words.includes(word)) return g.difficulty;
  }
  return null;
}

function animateTiles(words, animClass) {
  for (const w of words) {
    const tile = document.querySelector(`.tile[data-word="${cssEscape(w)}"]`);
    if (tile) {
      tile.classList.remove('shake', 'pop');
      // force reflow so class re-add triggers animation
      void tile.offsetWidth;
      tile.classList.add(animClass);
    }
  }
}

// ============== RESULT ==============

function renderResult(won) {
  const slot = document.getElementById('result-slot');
  if (!slot) return;

  // On loss, reveal any remaining groups as solved rows so player sees the solution.
  if (!won) {
    const solvedDiffs = new Set(state.solvedGroups.map((g) => g.difficulty));
    for (const g of puzzle.groups) {
      if (!solvedDiffs.has(g.difficulty)) state.solvedGroups.push(g);
    }
    renderSolvedRows();
  }

  const title = won ? t('play.result.won.title') : t('play.result.lost.title');
  const body = won
    ? (state.mistakes === 0 && !isEndless() ? t('play.result.won.perfect') : t('play.result.won.body'))
    : t('play.result.lost.body');

  slot.innerHTML = `
    <div class="play-result">
      <h2>${title}</h2>
      <p>${body}</p>
      <div class="play-result-actions">
        <button type="button" class="btn btn-primary" id="btn-share">${t('play.result.share')}</button>
        <button type="button" class="btn" id="btn-reset">${t('play.result.reset')}</button>
        <a href="/" class="btn">${t('play.result.playAnother')}</a>
      </div>
    </div>
  `;
  document.getElementById('btn-share').addEventListener('click', onShare);
  document.getElementById('btn-reset').addEventListener('click', onReset);
}

function buildShareText() {
  const url = `${window.location.origin}/play.html#c/${puzzleId}`;
  const lines = [`Puzzles HPVN #${puzzleId}`];
  for (const g of state.guessHistory) {
    lines.push(g.difficulties.map((d) => DIFFICULTY_EMOJI[d] || '⬜').join(''));
  }
  lines.push(url);
  return lines.join('\n');
}

async function onShare() {
  const text = buildShareText();
  const btn = document.getElementById('btn-share');
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = t('play.result.shareCopied');
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch {
    window.prompt(t('play.result.share'), text);
  }
}

function onReset() {
  clearProgress('connections', puzzleId);
  state = {
    selected: new Set(),
    solvedGroups: [],
    mistakes: 0,
    attempts: 0,
    guessHistory: [],
    remainingWords: shuffle(puzzle.groups.flatMap((g) => g.words)),
    feedback: null,
  };
  invalidateShell();
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============== PERSISTENCE ==============

function persist() {
  setProgress('connections', puzzleId, {
    solvedGroups: state.solvedGroups,
    mistakes: state.mistakes,
    attempts: state.attempts,
    guessHistory: state.guessHistory,
  });
}

// ============== UTILS ==============

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

// ============== BOOT ==============

initChrome();
main();

// Re-render mistake indicator when user cycles theme (dots ↔ wands/skulls)
document.addEventListener('theme-changed', () => {
  if (state && document.getElementById('mistakes')) renderMistakes();
});

// Language flip: re-render everything dynamic. State fully drives the view,
// so a full re-render is safe.
window.addEventListener('lang-changed', () => {
  if (!state) return;
  // Clear stale translated feedback so the new render doesn't restore the old string.
  state.feedback = null;
  // Force a full re-mount so every interpolated string (solved-row names, group
  // labels, etc.) gets rebuilt in the new language.
  invalidateShell();
  render();
});

// Debounced font-fit on resize.
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { fitAllTiles(); }, 120);
});
