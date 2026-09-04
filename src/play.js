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
import { getProgress, setProgress, clearProgress, getTheme, getLang } from './lib/storage.js';
import { switchLang } from './lib/i18n.js';
import { getActiveTheme, applyTheme } from './lib/theme.js';
import { escapeHtml } from './lib/util.js';

// Share-tile emoji per difficulty tier. Six because a puzzle can be up to 6x6.
const DIFFICULTY_EMOJI = {
  1: '🟨',
  2: '🟩',
  3: '🟦',
  4: '🟪',
  5: '🟧',
  6: '🩷',
};
// Legacy string difficulties on puzzles saved before the numeric-tier migration.
const LEGACY_DIFFICULTY_MAP = { yellow: 1, green: 2, blue: 3, red: 4, purple: 4 };
const MIN_SIZE = 3;
const MAX_SIZE = 6;
const DEFAULT_SIZE = 4;
const DEFAULT_MISTAKES = 4;

let puzzle = null;    // normalized: { groups[{name, words, difficulty:int}], size, mistakeMode, revealOnFail, ... }
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

// ============== PUZZLE NORMALIZATION ==============

// Coerce a difficulty field to a numeric tier. Numeric passthrough; legacy
// strings map via LEGACY_DIFFICULTY_MAP; anything else falls back to `fallback`.
function coerceDifficulty(d, fallback) {
  if (Number.isInteger(d)) return d;
  if (typeof d === 'string' && d in LEGACY_DIFFICULTY_MAP) return LEGACY_DIFFICULTY_MAP[d];
  return fallback;
}

// Normalize a fetched puzzle so the rest of play.js can assume:
//  - `size` is an int in [MIN_SIZE, MAX_SIZE]
//  - each group's `difficulty` is a numeric tier in [1, size]
//  - `mistakeMode` is 'endless' or an int
//  - `revealOnFail` is a boolean
// Puzzles saved before these fields existed get sensible defaults so old links
// keep working with no server-side migration.
// Returns null (with an error logged) if the puzzle is structurally unusable —
// caller should show the generic load error rather than a broken board.
function normalizePuzzle(raw) {
  const p = { ...raw };
  // Size: explicit and in-range, else infer from first group's word count.
  // If the inferred value is out of range too, the puzzle is corrupt — refuse
  // rather than silently rendering a mismatched grid.
  let size;
  if (Number.isInteger(p.size) && p.size >= MIN_SIZE && p.size <= MAX_SIZE) {
    size = p.size;
  } else if (Array.isArray(p.groups) && p.groups[0] && Array.isArray(p.groups[0].words)) {
    const inferred = p.groups[0].words.length;
    if (inferred >= MIN_SIZE && inferred <= MAX_SIZE) {
      size = inferred;
    } else {
      console.error(`[connections] puzzle size ${inferred} outside [${MIN_SIZE}, ${MAX_SIZE}]`);
      return null;
    }
  } else {
    size = DEFAULT_SIZE;
  }
  p.size = size;
  p.groups = (p.groups || []).map((g, i) => ({
    ...g,
    difficulty: coerceDifficulty(g.difficulty, i + 1),
  }));
  // mistakeMode: legacy 'four' → 4; already-endless or already-int passthrough; default 4.
  if (p.mistakeMode === 'four') p.mistakeMode = DEFAULT_MISTAKES;
  else if (p.mistakeMode !== 'endless' && !Number.isInteger(p.mistakeMode)) p.mistakeMode = DEFAULT_MISTAKES;
  // revealOnFail: default true (matches legacy behavior — old puzzles always revealed).
  p.revealOnFail = p.revealOnFail !== false;
  return p;
}

// Also normalize a saved-progress solvedGroups array so difficulties from old
// saves (strings) don't mix with numeric tiers in the same UI state.
function normalizeSavedSolvedGroups(saved, groups) {
  if (!Array.isArray(saved)) return [];
  return saved.map((g) => {
    // Try to match by name against the current puzzle groups so we can pick up
    // the puzzle's authoritative difficulty tier. Falls back to coercing what
    // the save had, then to a null-safe default.
    const canonical = groups.find((cg) => cg.name === g.name);
    if (canonical) return { ...g, difficulty: canonical.difficulty };
    return { ...g, difficulty: coerceDifficulty(g.difficulty, 1) };
  });
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
    puzzle = normalizePuzzle(res.puzzle);
  } catch (err) {
    if (err.status === 404) renderError(t('play.error.notFound'));
    else renderError(t('play.error.generic'));
    return;
  }
  // normalizePuzzle returned null → puzzle is structurally unusable (e.g. an
  // out-of-range size). Show the generic error rather than crashing later.
  if (!puzzle) {
    renderError(t('play.error.generic'));
    return;
  }

  // Apply puzzle's default theme only if user hasn't picked one themselves.
  if (!getTheme() && puzzle.defaultTheme) {
    applyTheme(puzzle.defaultTheme);
  }
  // Same for language — respect a viewer's explicit choice, otherwise honor the puzzle's.
  if (!getLang() && puzzle.defaultLang) {
    switchLang(puzzle.defaultLang);
  }

  const size = puzzle.size;
  const totalTiles = size * size;

  // Restore progress. solvedGroups holds full group objects; on a loss with
  // revealOnFail=true we push any remaining groups into it so the player sees
  // the full solution.
  const saved = getProgress('connections', puzzleId);
  const solvedGroups = normalizeSavedSolvedGroups(saved?.solvedGroups, puzzle.groups);
  const allWords = puzzle.groups.flatMap((g) => g.words);
  const solvedWords = new Set(solvedGroups.flatMap((g) => g.words));
  const remainingWords = allWords.filter((w) => !solvedWords.has(w));

  state = {
    selected: new Set(),
    solvedGroups,
    mistakes: saved?.mistakes || 0,
    attempts: saved?.attempts || 0,
    guessHistory: saved?.guessHistory || [],
    // Pinned layout only applies on a genuinely fresh load — no saved progress,
    // full N² tiles remaining, and the puzzle actually declares one. Any prior
    // interaction (Shuffle, guess) means we already saved progress and the
    // pins are ignored for the rest of the session, per the spec.
    remainingWords: (!saved && puzzle.pinnedLayout && puzzle.pinnedLayout.length === totalTiles && remainingWords.length === totalTiles)
      ? applyPinnedLayout(puzzle.pinnedLayout, puzzle.groups, totalTiles)
      : shuffle(remainingWords),
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

// Total lives allowed for this puzzle. Infinity for endless; otherwise the
// numeric mistake mode (falls back to DEFAULT_MISTAKES if somehow missing).
function totalLives() {
  if (isEndless()) return Infinity;
  const m = puzzle?.mistakeMode;
  return Number.isInteger(m) ? m : DEFAULT_MISTAKES;
}

function livesLeft() {
  if (isEndless()) return Infinity;
  return Math.max(0, totalLives() - state.mistakes);
}

function isDone() {
  if (!state || !puzzle) return false;
  return state.solvedGroups.length === puzzle.size || (!isEndless() && livesLeft() === 0);
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
  const won = state.solvedGroups.length === puzzle.size;

  // Mount the shell once. Subsequent renders update slots in place, so existing
  // solved rows aren't re-created — otherwise the CSS entrance animation fires
  // on every guess and the whole strip flashes.
  if (!main.querySelector('#grid')) {
    main.innerHTML = `
      <div class="play-header">
        <h1>${t('play.puzzleId', { id: puzzleId })}</h1>
      </div>
      <div class="solved-rows" id="solved-rows" style="--grid-size: ${puzzle.size}"></div>
      <div class="grid" id="grid" style="--grid-size: ${puzzle.size}"></div>
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
  // Append only rows that aren't already in the DOM — keyed by difficulty tier
  // since each puzzle has one group per tier. Existing rows stay put, so their
  // entrance animation doesn't re-fire on every render.
  const existing = new Set(
    [...container.querySelectorAll('.solved-row')].map((r) => r.getAttribute('data-difficulty'))
  );
  for (const g of state.solvedGroups) {
    const key = String(g.difficulty);
    if (existing.has(key)) continue;
    const row = document.createElement('div');
    row.className = 'solved-row';
    row.setAttribute('data-difficulty', key);
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
    // aria-pressed makes each tile a proper toggle button for screen readers.
    const isSelected = state.selected.has(word);
    tile.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    if (isSelected) tile.classList.add('selected');
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
        <span class="endless-pill-count">${t('play.mistakes.attempt', { n: state.mistakes })}</span>
      </span>
    `;
    return;
  }
  const total = totalLives();
  const used = state.mistakes;
  const isHpvn = getActiveTheme() === 'hpvn';
  const items = [];
  for (let i = 0; i < total; i++) {
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
  const size = puzzle.size;
  const selectedCount = state.selected.size;
  el.innerHTML = `
    <button type="button" class="btn" id="btn-shuffle">${t('play.controls.shuffle')}</button>
    <button type="button" class="btn" id="btn-deselect" ${selectedCount === 0 ? 'disabled' : ''}>${t('play.controls.deselect')}</button>
    <button type="button" class="btn btn-primary" id="btn-submit" ${selectedCount !== size ? 'disabled' : ''}>${t('play.controls.submit')}</button>
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
const MIN_FONT_SINGLE = 10;  // below this, prefer wrapping instead of shrinking further
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
  const size = puzzle.size;
  if (state.selected.has(word)) {
    state.selected.delete(word);
  } else {
    if (state.selected.size >= size) return;
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
  const size = puzzle.size;
  const picked = [...state.selected];
  if (picked.length !== size) return;

  // Check "already guessed" — same set of N words (order-independent).
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
    const oneAway = isOneAway(pickedDifficulties, size);
    setFeedback(oneAway ? t('play.feedback.oneAway') : t('play.feedback.wrong'), 'hint');
    await sleep(450);
  }

  // Shared tail for both branches.
  state.selected.clear();
  persist();
  render();
}

// "One away" = exactly (N-1) of N picked words share a difficulty. Since we
// know every word's difficulty locally, this is exact.
function isOneAway(difficulties, size) {
  const counts = {};
  for (const d of difficulties) counts[d] = (counts[d] || 0) + 1;
  return Object.values(counts).some((c) => c === size - 1);
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

  // On loss, reveal any remaining groups as solved rows so player sees the
  // solution — but only if the editor didn't opt out via revealOnFail=false.
  // Note: puzzle answers travel in the initial GET response (see file header),
  // so a determined user can still read them from the network payload. This
  // toggle only controls the in-UI reveal — the honest UX contract with the
  // editor, not a security boundary.
  if (!won && puzzle.revealOnFail) {
    const solvedDiffs = new Set(state.solvedGroups.map((g) => g.difficulty));
    for (const g of puzzle.groups) {
      if (!solvedDiffs.has(g.difficulty)) state.solvedGroups.push(g);
    }
    renderSolvedRows();
  }

  const title = won ? t('play.result.won.title') : t('play.result.lost.title');
  let body;
  if (won) {
    body = (state.mistakes === 0 && !isEndless()) ? t('play.result.won.perfect') : t('play.result.won.body');
  } else {
    body = puzzle.revealOnFail ? t('play.result.lost.body') : t('play.result.lost.bodyHidden');
  }

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
  const title = puzzle?.title?.trim() || t('home.collections.puzzleFallback', { id: puzzleId });
  const lines = [title];
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
  const totalTiles = puzzle.size * puzzle.size;
  const allWords = puzzle.groups.flatMap((g) => g.words);
  state = {
    selected: new Set(),
    solvedGroups: [],
    mistakes: 0,
    attempts: 0,
    guessHistory: [],
    // "Play this again" = fresh puzzle → re-apply pins if declared and sized to N².
    remainingWords: (puzzle.pinnedLayout && puzzle.pinnedLayout.length === totalTiles)
      ? applyPinnedLayout(puzzle.pinnedLayout, puzzle.groups, totalTiles)
      : shuffle(allWords),
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

// Arrange N² words for first-load render, honoring the editor's pinned tiles.
// Pins reference words by {g, w} index. Any pin that can't resolve (stale
// data from a since-edited puzzle) is silently ignored — the tile just falls
// into the shuffle pool instead. Unpinned words are Fisher-Yates shuffled and
// placed into the remaining slots in order.
function applyPinnedLayout(layout, groups, totalTiles) {
  const arr = Array(totalTiles).fill(null);
  const pinnedWords = new Set();
  for (let i = 0; i < totalTiles; i++) {
    const p = layout[i];
    if (
      p && typeof p === 'object' &&
      Number.isInteger(p.g) && Number.isInteger(p.w) &&
      groups[p.g] && typeof groups[p.g].words?.[p.w] === 'string'
    ) {
      arr[i] = groups[p.g].words[p.w];
      pinnedWords.add(arr[i]);
    }
  }
  const remaining = shuffle(
    groups.flatMap((g) => g.words).filter((w) => !pinnedWords.has(w))
  );
  let idx = 0;
  for (let i = 0; i < totalTiles; i++) {
    if (!arr[i]) arr[i] = remaining[idx++];
  }
  return arr;
}

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
