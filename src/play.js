// Play page: Connections game.
// URL: /play.html#c/{id}
// Flow: fetch puzzle → apply theme → render grid → gameplay loop → win/lose result.

import './styles/base.css';
import { initChrome } from './lib/chrome.js';
import { t, applyTranslations } from './lib/i18n.js';
import { fetchPuzzle } from './lib/api.js';
import { getProgress, setProgress, clearProgress, getTheme } from './lib/storage.js';
import { getActiveTheme, applyTheme } from './lib/theme.js';

const DIFFICULTY_EMOJI = {
  yellow: '🟨',
  green:  '🟩',
  blue:   '🟦',
  red:    '🟥',
};
const DIFFICULTY_ORDER = ['yellow', 'green', 'blue', 'red'];

let puzzle = null;
let puzzleId = null;
let state = null; // { selected: Set<word>, solvedGroups: [{difficulty,name,words}], mistakes: number, guessHistory: [[difficulty,...]], remainingWords: [word,...] }

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

  // Show loading state (chrome already initialized with stored/system theme)
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

  // Restore progress if any
  const saved = getProgress('connections', puzzleId);
  const allWords = puzzle.groups.flatMap((g) => g.words);
  const solvedWords = saved ? saved.solvedGroups.flatMap((g) => g.words) : [];
  const remainingWords = allWords.filter((w) => !solvedWords.includes(w));

  state = {
    selected: new Set(),
    solvedGroups: saved?.solvedGroups || [],
    mistakes: saved?.mistakes || 0,
    guessHistory: saved?.guessHistory || [],
    remainingWords: shuffle(remainingWords),
    feedback: null,
  };

  render();
}

// ============== RENDERERS ==============

function renderLoading() {
  const main = document.querySelector('[data-slot="main"]');
  main.innerHTML = `<div class="play-loading">${t('play.loading')}</div>`;
}

function renderError(msg) {
  const main = document.querySelector('[data-slot="main"]');
  main.innerHTML = `
    <div class="play-error">
      <p>${msg}</p>
      <a href="/">${t('play.error.backHome')}</a>
    </div>
  `;
}

function render() {
  const main = document.querySelector('[data-slot="main"]');
  const isEndless = puzzle.mistakeMode === 'endless';
  const mistakesLeft = isEndless ? Infinity : Math.max(0, 4 - state.mistakes);
  const done = state.solvedGroups.length === 4 || (!isEndless && mistakesLeft === 0);
  const won = state.solvedGroups.length === 4;

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

  renderSolvedRows();
  renderGrid();
  renderMistakes();
  renderControls(done);
  restoreFeedback();

  if (done) renderResult(won);
}

function renderSolvedRows() {
  const container = document.getElementById('solved-rows');
  container.innerHTML = '';
  for (const g of state.solvedGroups) {
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
}

function renderMistakes() {
  const el = document.getElementById('mistakes');
  const isEndless = puzzle.mistakeMode === 'endless';
  if (isEndless) {
    el.innerHTML = `<span>${t('play.mistakes.endless')}</span>`;
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

let feedbackTimer = null;

function setFeedback(message, tone = '') {
  const el = document.getElementById('feedback');
  if (!el) return;
  // Clear any pending fade-out
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
  // Auto-clear after 2.8s (300ms fade + 2.5s hold)
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

// Restore feedback message after a full re-render (state.feedback persists between renders)
function restoreFeedback() {
  if (!state.feedback) return;
  const el = document.getElementById('feedback');
  if (!el) return;
  el.textContent = state.feedback.message;
  el.setAttribute('data-tone', state.feedback.tone || '');
  el.classList.add('visible');
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

  // Which difficulties are the picked words? Used for one-away check and share history.
  const pickedDifficulties = picked.map((w) => findDifficulty(w));

  // Check "already guessed" — same set of 4 words (order-independent).
  const pickedKey = [...picked].sort().join('|');
  const alreadyGuessed = state.guessHistory.some(
    (h) => h.words && [...h.words].sort().join('|') === pickedKey
  );
  if (alreadyGuessed) {
    setFeedback(t('play.feedback.alreadyGuessed'), 'hint');
    return;
  }

  // Record this guess (difficulties + words for share and dedup)
  state.guessHistory.push({ words: picked, difficulties: pickedDifficulties });

  // Correct? All 4 picked words belong to the same group.
  const firstDiff = pickedDifficulties[0];
  const allSame = pickedDifficulties.every((d) => d === firstDiff);

  if (allSame) {
    // Correct — pop animation, then reveal solved row.
    animateTiles(picked, 'pop');
    await sleep(300);
    const group = puzzle.groups.find((g) => g.difficulty === firstDiff);
    state.solvedGroups.push(group);
    state.remainingWords = state.remainingWords.filter((w) => !picked.includes(w));
    state.selected.clear();
    setFeedback('');
    persist();
    render();
    return;
  }

  // Wrong — shake, deduct, maybe show "one away".
  animateTiles(picked, 'shake');
  state.mistakes++;
  // "One away" = exactly 3 of 4 belong to the same group
  const oneAway = isOneAway(pickedDifficulties);
  setFeedback(oneAway ? t('play.feedback.oneAway') : t('play.feedback.wrong'), 'hint');
  await sleep(450);
  state.selected.clear();
  persist();
  render();
}

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

  // If loss, reveal any remaining groups as solved rows so player sees the solution.
  if (!won) {
    const solvedDiffs = new Set(state.solvedGroups.map((g) => g.difficulty));
    for (const g of puzzle.groups) {
      if (!solvedDiffs.has(g.difficulty)) state.solvedGroups.push(g);
    }
    // Re-render solved rows to include the newly revealed
    renderSolvedRows();
    // Clear grid — game over
    const grid = document.getElementById('grid');
    if (grid) grid.innerHTML = '';
  }

  const title = won ? t('play.result.won.title') : t('play.result.lost.title');
  const isEndless = puzzle.mistakeMode === 'endless';
  const body = won
    ? (state.mistakes === 0 && !isEndless ? t('play.result.won.perfect') : t('play.result.won.body'))
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
  // Format: title line + grid of guesses (one row per guess, using difficulty emojis).
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
    // Fallback: open a prompt with the text so user can copy manually
    window.prompt(t('play.result.share'), text);
  }
}

function onReset() {
  clearProgress('connections', puzzleId);
  state = {
    selected: new Set(),
    solvedGroups: [],
    mistakes: 0,
    guessHistory: [],
    remainingWords: shuffle(puzzle.groups.flatMap((g) => g.words)),
    feedback: null,
  };
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============== PERSISTENCE ==============

function persist() {
  setProgress('connections', puzzleId, {
    solvedGroups: state.solvedGroups,
    mistakes: state.mistakes,
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
  // Minimal escape for use in querySelector attribute value.
  return String(s).replace(/["\\]/g, '\\$&');
}

// ============== BOOT ==============

initChrome();
main();

// Re-render mistake indicator when user cycles theme (dots ↔ wands/skulls)
document.addEventListener('theme-changed', () => {
  if (state && document.getElementById('mistakes')) renderMistakes();
});
