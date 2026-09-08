// Play page: Strands game.
// URL: /play-strands.html#s/{id}
// Flow: fetch masked puzzle → render grid → tap-to-build path → submit to
// server → track found words → hint button → win state + share.
//
// Answers never leave the server: the initial GET returns letters + counts
// only, guesses go through POST /api/puzzle/strands/:id/guess, and hints
// come from POST /api/puzzle/strands/:id/hint.

import '../../styles/base.css';
import { initChrome } from '../../lib/chrome.js';
import { t, switchLang } from '../../lib/i18n.js';
import { fetchPuzzle, submitStrandsGuess, requestStrandsHint } from '../../lib/api.js';
import { getProgress, setProgress, clearProgress, getTheme, getLang } from '../../lib/storage.js';
import { applyTheme } from '../../lib/theme.js';
import { escapeHtml, copyWithFeedback } from '../../lib/util.js';
import { areAdjacent } from './model.js';
import { buildShareText } from './share.js';

let puzzle = null;   // masked: { rows, cols, grid, theme, title, wordCount, spangramLength }
let puzzleId = null;
let state = null;    // see main() for shape
let feedbackTimer = null;
// Drag input transient state. Lives outside `state` because it never persists.
let drag = { active: false, startIdx: null, moved: false, suppressClick: false };

// ============== URL PARSE ==============

function parseUrl() {
  const m = window.location.hash.match(/^#s\/([A-Za-z0-9]{5})$/);
  return m ? m[1] : null;
}

// ============== INIT ==============

async function main() {
  puzzleId = parseUrl();
  if (!puzzleId) { renderError(t('play.error.notFound')); return; }
  renderLoading();
  try {
    const res = await fetchPuzzle('strands', puzzleId);
    puzzle = res.puzzle;
  } catch (err) {
    if (err.status === 404) renderError(t('play.error.notFound'));
    else renderError(t('play.error.generic'));
    return;
  }
  if (!puzzle || !Array.isArray(puzzle.grid) || !puzzle.rows || !puzzle.cols) {
    renderError(t('play.error.generic'));
    return;
  }
  if (!getTheme() && puzzle.defaultTheme) applyTheme(puzzle.defaultTheme);
  if (!getLang() && puzzle.defaultLang) switchLang(puzzle.defaultLang);

  const saved = getProgress('strands', puzzleId) || {};
  state = {
    foundWordIndexes: new Set(saved.foundWordIndexes || []),
    // For each found theme word: { wordIndex, cells: [n,...] } so we can paint tiles.
    foundWordCells: new Map((saved.foundWordCells || []).map(({ wordIndex, cells }) => [wordIndex, cells])),
    spangram: saved.spangram || null,   // null or { word, cells: [n,...] }
    hintCells: new Set(saved.hintCells || []), // cells currently highlighted by hint (subset lit until player finds that word)
    hintWordIndex: saved.hintWordIndex ?? null, // which unfound theme word the hint refers to
    hintsUsed: saved.hintsUsed || 0,
    events: saved.events || [],  // ordered [{kind}] for share
    path: [],                    // in-progress path (cell indices)
    feedback: null,
  };
  render();
}

// ============== HELPERS ==============

function mainSlot() { return document.querySelector('[data-slot="main"]'); }

function totalWords() { return puzzle.wordCount + 1; } // theme words + spangram
function foundCount() { return state.foundWordIndexes.size + (state.spangram ? 1 : 0); }
function isDone() { return foundCount() === totalWords(); }

// Set of every cell that belongs to a found word (theme or spangram).
function foundCellSet() {
  const s = new Set();
  for (const cells of state.foundWordCells.values()) for (const c of cells) s.add(c);
  if (state.spangram) for (const c of state.spangram.cells) s.add(c);
  return s;
}

// ============== RENDERERS ==============

function renderLoading() { mainSlot().innerHTML = `<div class="play-loading">${t('play.loading')}</div>`; }

function renderError(msg) {
  mainSlot().innerHTML = `
    <div class="play-error">
      <p>${msg}</p>
      <a href="/">${t('play.error.backHome')}</a>
    </div>`;
}

function render() {
  const main = mainSlot();
  const done = isDone();
  const title = puzzle.title?.trim() || t('home.collections.puzzleFallback', { id: puzzleId });
  if (!main.querySelector('#strands-grid')) {
    main.innerHTML = `
      <div class="play-header">
        <h1>${escapeHtml(title)}</h1>
        <p class="strands-theme">"${escapeHtml(puzzle.theme)}"</p>
      </div>
      <div class="strands-progress" id="strands-progress"></div>
      <div class="strands-board">
        <svg class="strands-lines" id="strands-lines" aria-hidden="true"></svg>
        <div class="strands-grid" id="strands-grid" style="--rows:${puzzle.rows};--cols:${puzzle.cols}"></div>
      </div>
      <div class="strands-current-word" id="strands-current-word" aria-live="polite"></div>
      <div class="feedback" id="feedback"></div>
      <div class="play-controls" id="controls"></div>
      <div id="result-slot"></div>
    `;
    wireDrag();
  } else {
    const h1 = main.querySelector('.play-header h1');
    if (h1) h1.textContent = title;
    const themeEl = main.querySelector('.strands-theme');
    if (themeEl) themeEl.textContent = `"${puzzle.theme}"`;
  }
  renderProgress();
  renderGrid();
  renderCurrentWord();
  renderControls(done);
  restoreFeedback();
  drawLines();
  if (done) renderResult();
}

// Current in-progress word (letters as they're chosen). Shown under the grid
// so the player can see what they're spelling.
function renderCurrentWord() {
  const el = document.getElementById('strands-current-word');
  if (!el) return;
  const letters = state.path.map((idx) => puzzle.grid[idx]).join('');
  el.textContent = letters;
  el.classList.toggle('empty', !letters);
}

function renderProgress() {
  const el = document.getElementById('strands-progress');
  if (!el) return;
  el.textContent = t('strands.progress', {
    found: foundCount(), total: totalWords(), hints: state.hintsUsed,
  });
}

function renderGrid() {
  const grid = document.getElementById('strands-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const found = foundCellSet();
  const spangramCells = new Set(state.spangram ? state.spangram.cells : []);
  const inPath = new Set(state.path);
  for (let i = 0; i < puzzle.grid.length; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'strands-cell';
    cell.textContent = puzzle.grid[i];
    cell.dataset.idx = String(i);
    if (spangramCells.has(i)) cell.classList.add('spangram-found');
    else if (found.has(i)) cell.classList.add('theme-found');
    if (state.hintCells.has(i) && !found.has(i)) cell.classList.add('hinted');
    if (inPath.has(i)) cell.classList.add('in-path');
    if (state.path.length && state.path[state.path.length - 1] === i) cell.classList.add('path-tail');
    cell.addEventListener('click', () => onCellClick(i));
    grid.appendChild(cell);
  }
}

// Convert an ordered list of cell indexes into an SVG path centred on each
// cell's midpoint. Returns null when a cell can't be found (mid-transition).
function pathFromCells(cells, grid, gridRect) {
  const centers = cells.map((idx) => {
    const cell = grid.querySelector(`.strands-cell[data-idx="${idx}"]`);
    if (!cell) return null;
    const r = cell.getBoundingClientRect();
    return { x: r.left - gridRect.left + r.width / 2, y: r.top - gridRect.top + r.height / 2 };
  }).filter(Boolean);
  if (centers.length < 2) return null;
  return centers.map((p, i) => (i === 0 ? `M${p.x},${p.y}` : `L${p.x},${p.y}`)).join(' ');
}

// Draws every visible path onto the SVG overlay: one line per found theme
// word (blue), one for the spangram (yellow), and the in-progress path on top.
function drawLines() {
  const svg = document.getElementById('strands-lines');
  const grid = document.getElementById('strands-grid');
  if (!svg || !grid) return;
  svg.innerHTML = '';
  const gridRect = grid.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${gridRect.width} ${gridRect.height}`);
  svg.setAttribute('width', String(gridRect.width));
  svg.setAttribute('height', String(gridRect.height));

  const addLine = (cells, cls) => {
    const d = pathFromCells(cells, grid, gridRect);
    if (!d) return;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', cls);
    svg.appendChild(p);
  };

  for (const cells of state.foundWordCells.values()) addLine(cells, 'strands-line found theme');
  if (state.spangram) addLine(state.spangram.cells, 'strands-line found spangram');
  addLine(state.path, 'strands-line active');
}

function renderControls(done) {
  const el = document.getElementById('controls');
  if (!el) return;
  if (done) { el.innerHTML = ''; return; }
  const canSubmit = state.path.length >= 3;
  el.innerHTML = `
    <button type="button" class="btn" id="btn-hint">${t('strands.controls.hint')}</button>
    <button type="button" class="btn" id="btn-clear" ${state.path.length === 0 ? 'disabled' : ''}>${t('strands.controls.clear')}</button>
    <button type="button" class="btn btn-primary" id="btn-submit" ${canSubmit ? '' : 'disabled'}>${t('strands.controls.submit')}</button>
  `;
  document.getElementById('btn-hint').addEventListener('click', onHint);
  document.getElementById('btn-clear').addEventListener('click', onClear);
  document.getElementById('btn-submit').addEventListener('click', onSubmit);
}

function setFeedback(message, tone = '') {
  const el = document.getElementById('feedback');
  if (!el) return;
  if (feedbackTimer) { clearTimeout(feedbackTimer); feedbackTimer = null; }
  state.feedback = message ? { message, tone } : null;
  if (!message) { el.textContent = ''; el.classList.remove('visible'); el.setAttribute('data-tone', ''); return; }
  el.textContent = message;
  el.setAttribute('data-tone', tone);
  void el.offsetWidth;
  el.classList.add('visible');
  feedbackTimer = setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => { state.feedback = null; const still = document.getElementById('feedback'); if (still) still.textContent = ''; }, 400);
    feedbackTimer = null;
  }, 2500);
}

function restoreFeedback() {
  if (!state.feedback) return;
  const el = document.getElementById('feedback');
  if (!el) return;
  el.textContent = state.feedback.message;
  el.setAttribute('data-tone', state.feedback.tone || '');
  el.classList.add('visible');
}

// ============== INPUT ==============

// Tap-mode: click one cell at a time to build a path, double-tap the last
// cell to submit. Drag-mode (below) supplements this by handling pointer
// movement; it does not replace tap.
function onCellClick(idx) {
  if (drag.suppressClick) { drag.suppressClick = false; return; }
  const found = foundCellSet();
  if (found.has(idx)) return; // already claimed by a solved word
  const p = state.path;
  if (p.length === 0) { state.path = [idx]; render(); return; }
  const last = p[p.length - 1];
  if (last === idx) { onSubmit(); return; }         // double-tap tail = submit
  const existingPos = p.indexOf(idx);
  if (existingPos !== -1) {                          // clicked a cell already in path = truncate to it
    state.path = p.slice(0, existingPos + 1);
    render();
    return;
  }
  if (!areAdjacent(last, idx, puzzle.cols)) {        // non-adjacent = start over from this cell
    state.path = [idx];
    render();
    return;
  }
  state.path = [...p, idx];
  render();
}

// Try to extend the path to `idx` under drag rules: adjacent, unclaimed,
// not-already-in-path (or backtrack to it). Returns true if the path changed.
function extendPathTo(idx) {
  if (foundCellSet().has(idx)) return false;
  const p = state.path;
  if (p.length === 0) { state.path = [idx]; return true; }
  const last = p[p.length - 1];
  if (last === idx) return false;
  const existingPos = p.indexOf(idx);
  if (existingPos !== -1) {
    // Backtrack.
    state.path = p.slice(0, existingPos + 1);
    return true;
  }
  if (!areAdjacent(last, idx, puzzle.cols)) return false;
  state.path = [...p, idx];
  return true;
}

// Locate a Strands cell by pointer coordinates. Uses elementFromPoint so
// pointermove works across cells even when the pointerdown target is stale.
function cellIdxFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const cell = el.closest('.strands-cell');
  if (!cell) return null;
  const idx = parseInt(cell.dataset.idx, 10);
  return Number.isInteger(idx) ? idx : null;
}

// One-time drag wiring on the grid element. `wireDrag` runs after the shell
// mounts; pointerdown starts a drag session, pointermove extends the path,
// pointerup auto-submits when the drag actually moved.
function wireDrag() {
  const grid = document.getElementById('strands-grid');
  if (!grid) return;
  grid.addEventListener('pointerdown', (e) => {
    const idx = cellIdxFromPoint(e.clientX, e.clientY);
    if (idx == null) return;
    if (foundCellSet().has(idx)) return;
    drag.active = true;
    drag.startIdx = idx;
    drag.moved = false;
    // If the drag starts on a fresh cell, seed the path so the player sees
    // feedback immediately. Tap-only clicks still route through onCellClick
    // (below) because pointerup with moved=false suppresses nothing.
    if (state.path.length === 0 || !areAdjacent(state.path[state.path.length - 1], idx, puzzle.cols)) {
      state.path = [idx];
      render();
    } else if (state.path[state.path.length - 1] !== idx) {
      extendPathTo(idx);
      render();
    }
    // Prevent text selection while dragging.
    try { grid.setPointerCapture(e.pointerId); } catch {}
  });
  grid.addEventListener('pointermove', (e) => {
    if (!drag.active) return;
    const idx = cellIdxFromPoint(e.clientX, e.clientY);
    if (idx == null) return;
    if (idx !== drag.startIdx) drag.moved = true;
    if (extendPathTo(idx)) render();
  });
  const end = (e) => {
    if (!drag.active) return;
    drag.active = false;
    try { grid.releasePointerCapture(e.pointerId); } catch {}
    if (drag.moved) {
      // A real drag happened → auto-submit. Suppress the trailing click so it
      // doesn't run onCellClick (which would double-submit or truncate).
      drag.suppressClick = true;
      if (state.path.length >= 3) onSubmit();
    }
    drag.moved = false;
    drag.startIdx = null;
  };
  grid.addEventListener('pointerup', end);
  grid.addEventListener('pointercancel', end);
}

function onClear() { state.path = []; render(); }

async function onSubmit() {
  if (state.path.length < 3) return;
  const path = [...state.path];
  try {
    const res = await submitStrandsGuess(puzzleId, path);
    if (res.match === 'spangram') {
      state.spangram = { word: res.word, cells: path };
      state.events.push({ kind: 'spangram' });
      state.path = [];
      setFeedback(t('strands.feedback.spangram'), 'good');
    } else if (res.match === 'theme') {
      state.foundWordIndexes.add(res.wordIndex);
      state.foundWordCells.set(res.wordIndex, path);
      state.events.push({ kind: 'theme' });
      // If this word was the hinted one, clear the hint highlight.
      if (state.hintWordIndex === res.wordIndex) {
        state.hintCells = new Set();
        state.hintWordIndex = null;
      }
      state.path = [];
      setFeedback(t('strands.feedback.themeFound', { word: res.word }), 'good');
    } else {
      // Not a theme word: clear the path so the player can immediately try
      // another word instead of having to hit Clear first.
      state.path = [];
      setFeedback(t('strands.feedback.notATheme'), 'hint');
    }
  } catch {
    setFeedback(t('play.error.generic'), 'hint');
    return;
  }
  persist();
  render();
}

async function onHint() {
  try {
    const res = await requestStrandsHint(puzzleId, [...state.foundWordIndexes]);
    if (res.done) { setFeedback(t('strands.feedback.noHintsLeft'), 'hint'); return; }
    state.hintCells = new Set(res.cells);
    state.hintWordIndex = res.wordIndex;
    state.hintsUsed++;
    state.events.push({ kind: 'hint' });
    setFeedback(t('strands.feedback.hintGiven'), 'good');
  } catch {
    setFeedback(t('play.error.generic'), 'hint');
    return;
  }
  persist();
  render();
}

// ============== RESULT ==============

function renderResult() {
  const slot = document.getElementById('result-slot');
  if (!slot) return;
  slot.innerHTML = `
    <div class="play-result">
      <h2>${t('strands.result.won.title')}</h2>
      <p>${t('strands.result.won.body', { hints: state.hintsUsed })}</p>
      <div class="play-result-actions">
        <button type="button" class="btn btn-primary" id="btn-share">${t('play.result.share')}</button>
        <button type="button" class="btn" id="btn-reset">${t('play.result.reset')}</button>
        <a href="/" class="btn">${t('play.result.playAnother')}</a>
      </div>
    </div>`;
  document.getElementById('btn-share').addEventListener('click', onShare);
  document.getElementById('btn-reset').addEventListener('click', onReset);
}

async function onShare() {
  const url = `${window.location.origin}/play-strands.html#s/${puzzleId}`;
  const title = puzzle.title?.trim() || t('home.collections.puzzleFallback', { id: puzzleId });
  const text = buildShareText({ title, theme: puzzle.theme, events: state.events, url });
  const btn = document.getElementById('btn-share');
  await copyWithFeedback(btn, text, t('play.result.shareCopied'), {
    onFallback: () => window.prompt(t('play.result.share'), text),
  });
}

function onReset() {
  clearProgress('strands', puzzleId);
  state = {
    foundWordIndexes: new Set(),
    foundWordCells: new Map(),
    spangram: null,
    hintCells: new Set(),
    hintWordIndex: null,
    hintsUsed: 0,
    events: [],
    path: [],
    feedback: null,
  };
  // Force full re-mount so the result card is cleared.
  const grid = document.getElementById('strands-grid'); if (grid) grid.id = '';
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============== PERSISTENCE ==============

function persist() {
  setProgress('strands', puzzleId, {
    foundWordIndexes: [...state.foundWordIndexes],
    foundWordCells: [...state.foundWordCells.entries()].map(([wordIndex, cells]) => ({ wordIndex, cells })),
    spangram: state.spangram,
    hintCells: [...state.hintCells],
    hintWordIndex: state.hintWordIndex,
    hintsUsed: state.hintsUsed,
    events: state.events,
  });
}

// ============== BOOT ==============

initChrome({ games: ['strands'] });
main();

window.addEventListener('lang-changed', () => {
  if (!state) return;
  state.feedback = null;
  const g = document.getElementById('strands-grid'); if (g) g.id = '';
  render();
});
window.addEventListener('resize', () => { if (state) drawLines(); });
