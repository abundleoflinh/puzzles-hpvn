// Play page: Catfishing game.
// URL: /play-catfishing.html#cf/{id}
// Flow (Build Plan §9): fetch masked set (clues only, no answers) → render one
// question at a time as an alphabetized clue dump + a single free-text guess →
// POST /guess → hit / "did you mean X?" confirm / miss → reveal the canonical
// answer → optional honor-system override on a miss → Next → after Q5, an
// end-of-set score with per-question summary, aggregate stats, and share.
//
// Answers never leave the server unmasked: the initial GET returns clues only,
// guesses are validated by POST /guess, and the canonical is only revealed via
// POST /reveal after the player has already committed a guess for that question.

import '../../styles/base.css';
import { initChrome } from '../../lib/chrome.js';
import { t } from '../../lib/i18n.js';
import { getCurrentLang } from '../../lib/i18n.js';
import {
  fetchPuzzle,
  submitCatfishingGuess,
  revealCatfishingAnswer,
  catfishingStatsStart,
  catfishingStatsComplete,
  catfishingStatsOverride,
  getCatfishingStats,
} from '../../lib/api.js';
import { getProgress, setProgress, clearProgress, getFlag, setFlag } from '../../lib/storage.js';
import { escapeHtml, copyWithFeedback } from '../../lib/util.js';
import { buildShareText } from './share.js';

const RARE_ANSWER_PCT = 30; // per-question correct% below this → "rare answer" flag

let puzzle = null;    // masked: { type, title, collectionId, questionCount, questions:[{q_index, clues:[{en,vi}]}] }
let puzzleId = null;
let state = null;     // see main() for shape
let feedbackTimer = null;
let endStats = undefined; // undefined = not yet fetched, null = fetch failed, object = loaded
let endStatsPending = false;

// ============== URL PARSE ==============

function parseUrl() {
  const m = window.location.hash.match(/^#cf\/([A-Za-z0-9]{5})$/);
  return m ? m[1] : null;
}

// ============== INIT ==============

async function main() {
  puzzleId = parseUrl();
  if (!puzzleId) { renderError(t('play.error.notFound')); return; }
  renderLoading();
  try {
    const res = await fetchPuzzle('catfishing', puzzleId);
    puzzle = res.puzzle;
  } catch (err) {
    if (err.status === 404) renderError(t('play.error.notFound'));
    else renderError(t('play.error.generic'));
    return;
  }
  if (!puzzle || !Array.isArray(puzzle.questions) || !puzzle.questions.length) {
    renderError(t('play.error.generic'));
    return;
  }

  const saved = getProgress('catfishing', puzzleId) || {};
  state = {
    current: Number.isInteger(saved.current) ? saved.current : 0,
    // Per-question finalized outcome: { outcome:'hit'|'miss'|'override', answer:{en,vi,aliases_en,aliases_vi} }
    results: Array.isArray(saved.results) ? saved.results : [],
    phase: saved.phase === 'revealed' || saved.phase === 'confirming' ? saved.phase : 'guessing',
    confirmSuggested: typeof saved.confirmSuggested === 'string' ? saved.confirmSuggested : null,
    finished: !!saved.finished,
    guessValue: '',
    feedback: null,
  };
  // Clamp a resumed index into range and repair an inconsistent phase.
  if (state.current < 0 || state.current >= totalQuestions()) state.current = 0;
  if (state.phase === 'revealed' && !state.results[state.current]) state.phase = 'guessing';
  if (state.phase === 'confirming' && !state.confirmSuggested) state.phase = 'guessing';

  // Count one play per device, once. The flag makes a resume/refresh cheap and
  // keeps the aggregate honest. Best-effort — a stats failure never blocks play.
  if (!getFlag(`cf.played.${puzzleId}`)) {
    setFlag(`cf.played.${puzzleId}`);
    catfishingStatsStart(puzzleId).catch(() => {});
  }

  render();
  if (state.finished) fireComplete();
}

// ============== HELPERS ==============

function mainSlot() { return document.querySelector('[data-slot="main"]'); }

function totalQuestions() {
  return puzzle.questionCount || puzzle.questions.length;
}

function currentQuestion() {
  return puzzle.questions[state.current];
}

function score() {
  return state.results.filter((r) => r && (r.outcome === 'hit' || r.outcome === 'override')).length;
}

function titleText() {
  return puzzle.title?.trim() || t('home.collections.puzzleFallback', { id: puzzleId });
}

// Clues alphabetized in the current UI language. Falls back to the other
// language for a clue missing that side (the editor guarantees both, but be
// defensive). Re-sorted whenever the language flips.
function sortedClues() {
  const lang = getCurrentLang();
  const clues = (currentQuestion().clues || []).map((c) =>
    lang === 'vi' ? (c.vi || c.en || '') : (c.en || c.vi || '')
  );
  return clues.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// ============== RENDERERS ==============

function renderLoading() { mainSlot().innerHTML = `<div class="play-loading">${t('play.loading')}</div>`; }

function renderError(msg) {
  mainSlot().innerHTML = `
    <div class="play-error">
      <p>${escapeHtml(msg)}</p>
      <a href="/">${t('play.error.backHome')}</a>
    </div>`;
}

function render() {
  if (state.finished) { renderEnd(); return; }
  const main = mainSlot();
  const total = totalQuestions();
  // Clues render as plain text, left-aligned, separated by a gold sparkle —
  // matching the reference mockup (the ✦ is the site's own HPVN brand glyph).
  const clueChips = sortedClues()
    .map((c) => `<span class="cf-clue">${escapeHtml(c)}</span>`)
    .join('<span class="cf-clue-sep" aria-hidden="true">✦</span>');
  main.innerHTML = `
    <div class="play-header">
      <h1>${escapeHtml(titleText())}</h1>
    </div>
    <div class="cf-play-progress">
      <span>${escapeHtml(t('catfishing.play.questionOf', { n: state.current + 1, total }))}</span>
      <span class="cf-play-score">${escapeHtml(t('catfishing.play.score', { score: score(), total }))}</span>
    </div>
    <div class="cf-clue-dump" id="cf-clue-dump">${clueChips}</div>
    <div class="feedback" id="feedback"></div>
    <div class="cf-play-interact" id="cf-interact"></div>
  `;
  renderInteract();
  restoreFeedback();
}

function renderInteract() {
  const el = document.getElementById('cf-interact');
  if (!el) return;
  if (state.phase === 'confirming') { renderConfirm(el); return; }
  if (state.phase === 'revealed') { renderRevealed(el); return; }
  renderGuess(el);
}

function renderGuess(el) {
  el.innerHTML = `
    <form class="cf-guess-row" id="cf-guess-form">
      <input type="text" class="input-block cf-guess-input" id="cf-guess-input"
             placeholder="${escapeHtml(t('catfishing.play.guessPlaceholder'))}"
             autocomplete="off" autocapitalize="off" spellcheck="false"
             aria-label="${escapeHtml(t('catfishing.play.guessPlaceholder'))}" />
      <button type="submit" class="btn btn-primary" id="cf-guess-btn">${escapeHtml(t('catfishing.play.guessButton'))}</button>
    </form>
  `;
  const input = document.getElementById('cf-guess-input');
  input.value = state.guessValue;
  input.addEventListener('input', (e) => { state.guessValue = e.target.value; });
  document.getElementById('cf-guess-form').addEventListener('submit', (e) => {
    e.preventDefault();
    onGuess();
  });
  input.focus();
}

function renderConfirm(el) {
  el.innerHTML = `
    <div class="cf-confirm">
      <p class="cf-confirm-prompt">${t('catfishing.play.confirmPrompt', { name: `<strong>${escapeHtml(state.confirmSuggested)}</strong>` })}</p>
      <div class="cf-confirm-actions">
        <button type="button" class="btn btn-primary" id="cf-confirm-yes">${escapeHtml(t('catfishing.play.yes'))}</button>
        <button type="button" class="btn" id="cf-confirm-no">${escapeHtml(t('catfishing.play.no'))}</button>
      </div>
    </div>
  `;
  document.getElementById('cf-confirm-yes').addEventListener('click', onConfirmYes);
  document.getElementById('cf-confirm-no').addEventListener('click', onConfirmNo);
}

function renderRevealed(el) {
  const r = state.results[state.current];
  const credited = r.outcome === 'hit' || r.outcome === 'override';
  const lang = getCurrentLang();
  const a = r.answer || {};
  const primary = lang === 'vi' ? (a.vi || a.en) : (a.en || a.vi);
  const secondary = lang === 'vi' ? a.en : a.vi;
  const showBoth = secondary && secondary !== primary;
  const answerLine = a.en || a.vi
    ? `<p class="cf-reveal-answer">${escapeHtml(t('catfishing.play.answerWas'))} <strong>${escapeHtml(primary || '')}</strong>${showBoth ? ` <span class="cf-reveal-alt">(${escapeHtml(secondary)})</span>` : ''}</p>`
    : '';
  const markClass = credited ? 'hit' : 'miss';
  const markGlyph = credited ? '✓' : '✗';
  const markLabel = r.outcome === 'override'
    ? t('catfishing.play.markOverride')
    : credited ? t('catfishing.play.markHit') : t('catfishing.play.markMiss');
  // Honor-system override: only offered on an uncredited miss, and only once.
  const overrideBtn = r.outcome === 'miss'
    ? `<button type="button" class="btn btn-sm cf-override-btn" id="cf-override-btn">${escapeHtml(t('catfishing.play.overrideButton'))}</button>`
    : '';
  const isLast = state.current >= totalQuestions() - 1;
  const nextLabel = isLast ? t('catfishing.play.seeResults') : t('catfishing.play.nextQuestion');
  el.innerHTML = `
    <div class="cf-reveal">
      <div class="cf-reveal-head">
        <span class="cf-reveal-mark ${markClass}" aria-hidden="true">${markGlyph}</span>
        <span class="cf-reveal-label">${escapeHtml(markLabel)}</span>
      </div>
      ${answerLine}
      <div class="cf-reveal-actions">
        ${overrideBtn}
        <button type="button" class="btn btn-primary" id="cf-next-btn">${escapeHtml(nextLabel)}</button>
      </div>
    </div>
  `;
  const ov = document.getElementById('cf-override-btn');
  if (ov) ov.addEventListener('click', onOverride);
  document.getElementById('cf-next-btn').addEventListener('click', onNext);
}

// ============== FEEDBACK ==============

function setFeedback(message, tone = '') {
  const el = document.getElementById('feedback');
  state.feedback = message ? { message, tone } : null;
  if (!el) return;
  if (feedbackTimer) { clearTimeout(feedbackTimer); feedbackTimer = null; }
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

// ============== GUESS FLOW ==============

async function onGuess() {
  const guess = (state.guessValue || '').trim();
  if (!guess) return;
  let res;
  try {
    res = await submitCatfishingGuess(puzzleId, state.current, guess);
  } catch {
    setFeedback(t('play.error.generic'), 'hint');
    return;
  }
  if (res.status === 'hit') {
    await finalize('hit');
  } else if (res.status === 'confirm') {
    state.phase = 'confirming';
    state.confirmSuggested = res.suggested;
    persist();
    render();
  } else {
    await finalize('miss');
  }
}

async function onConfirmYes() {
  // Re-submit the suggested canonical as a normal guess so the server records it
  // as an exact hit (this is what makes it count in the aggregate correct[q]).
  let res;
  try {
    res = await submitCatfishingGuess(puzzleId, state.current, state.confirmSuggested);
  } catch {
    setFeedback(t('play.error.generic'), 'hint');
    return;
  }
  await finalize(res.status === 'hit' ? 'hit' : 'miss');
}

async function onConfirmNo() {
  await finalize('miss');
}

// Lock in one question's outcome: reveal the canonical answer, record the
// result, and move to the revealed state. Reveal is best-effort — a network
// failure still finalizes the outcome, just without the canonical text.
async function finalize(outcome) {
  let answer = null;
  try {
    const r = await revealCatfishingAnswer(puzzleId, state.current);
    answer = r.answer || null;
  } catch { /* reveal is best-effort */ }
  state.results[state.current] = { outcome, answer };
  state.phase = 'revealed';
  state.confirmSuggested = null;
  state.guessValue = '';
  persist();
  render();
}

// Honor-system override on a miss: award the point client-side (by upgrading the
// stored outcome) and record the self-declare in the SEPARATE server overrides[q]
// counter. Kept out of correct[q] on purpose, so correct% stays a true-match
// measure. Trivially inflatable by design — same trust model as the feature.
function onOverride() {
  const r = state.results[state.current];
  if (!r || r.outcome !== 'miss') return;
  r.outcome = 'override';
  persist();
  render();
  catfishingStatsOverride(puzzleId, state.current).catch(() => {});
}

function onNext() {
  if (state.current < totalQuestions() - 1) {
    state.current++;
    state.phase = 'guessing';
    state.confirmSuggested = null;
    state.guessValue = '';
    state.feedback = null;
    persist();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    state.finished = true;
    persist();
    render();
    fireComplete();
  }
}

// ============== END SCREEN ==============

// Bump completions once per device, then load aggregate stats for the summary.
function fireComplete() {
  if (!getFlag(`cf.completed.${puzzleId}`)) {
    setFlag(`cf.completed.${puzzleId}`);
    catfishingStatsComplete(puzzleId).catch(() => {});
  }
  ensureEndStats();
}

// Fetch aggregate stats once for the end screen, then re-render so the per-
// question correct% and rare-answer flags fill in. A failure leaves endStats
// null and the summary simply omits the percentages.
function ensureEndStats() {
  if (endStats !== undefined || endStatsPending) { if (endStats !== undefined) render(); return; }
  endStatsPending = true;
  getCatfishingStats(puzzleId)
    .then((s) => { endStats = s && typeof s === 'object' ? s : null; })
    .catch(() => { endStats = null; })
    .finally(() => { endStatsPending = false; if (state.finished) render(); });
}

// correct% for one question: hits / completions, clamped to [0,100]. Null when
// stats are unavailable or nobody has completed the set yet.
function correctPct(i) {
  if (!endStats) return null;
  const completions = Number.isFinite(endStats.completions) ? endStats.completions : 0;
  if (completions <= 0) return null;
  const correct = Array.isArray(endStats.correct) && Number.isFinite(endStats.correct[i]) ? endStats.correct[i] : 0;
  return Math.max(0, Math.min(100, Math.round((correct / completions) * 100)));
}

function renderEnd() {
  const main = mainSlot();
  const total = totalQuestions();
  const sc = score();
  const lang = getCurrentLang();

  const rows = [];
  for (let i = 0; i < total; i++) {
    const r = state.results[i] || { outcome: 'miss', answer: null };
    const credited = r.outcome === 'hit' || r.outcome === 'override';
    const a = r.answer || {};
    const primary = lang === 'vi' ? (a.vi || a.en) : (a.en || a.vi);
    const markClass = credited ? 'hit' : 'miss';
    const markGlyph = r.outcome === 'override' ? '🟰' : credited ? '✓' : '✗';
    const pct = correctPct(i);
    const pctText = pct == null ? '' : t('catfishing.play.correctPct', { pct });
    const rare = pct != null && pct < RARE_ANSWER_PCT
      ? `<span class="cf-rare-flag" title="${escapeHtml(t('catfishing.play.rareAnswerHint'))}">${escapeHtml(t('catfishing.play.rareAnswer'))}</span>`
      : '';
    rows.push(`
      <div class="cf-summary-row">
        <span class="cf-summary-mark ${markClass}" aria-hidden="true">${markGlyph}</span>
        <span class="cf-summary-q">${escapeHtml(t('catfishing.play.qShort', { n: i + 1 }))}</span>
        <span class="cf-summary-answer">${escapeHtml(primary || '—')}</span>
        <span class="cf-summary-stat">${escapeHtml(pctText)} ${rare}</span>
      </div>
    `);
  }

  const completions = endStats && Number.isFinite(endStats.completions) ? endStats.completions : null;
  const completedLine = completions
    ? `<p class="cf-end-completions">${escapeHtml(t('catfishing.play.completedCount', { n: completions }))}</p>`
    : '';

  main.innerHTML = `
    <div class="play-header">
      <h1>${escapeHtml(titleText())}</h1>
    </div>
    <div class="play-result cf-end">
      <h2>${escapeHtml(t('catfishing.play.endTitle'))}</h2>
      <p class="cf-end-score">${escapeHtml(t('catfishing.play.endScore', { score: sc, total }))}</p>
      ${completedLine}
      <div class="cf-summary">${rows.join('')}</div>
      <div class="play-result-actions">
        <button type="button" class="btn btn-primary" id="cf-share-btn">${escapeHtml(t('play.result.share'))}</button>
        <button type="button" class="btn" id="cf-reset-btn">${escapeHtml(t('play.result.reset'))}</button>
        <a href="/" class="btn">${escapeHtml(t('play.result.playAnother'))}</a>
      </div>
    </div>
  `;
  document.getElementById('cf-share-btn').addEventListener('click', onShare);
  document.getElementById('cf-reset-btn').addEventListener('click', onReset);
}

async function onShare() {
  // Short link (/cf/:id) — _redirects maps it to the hash-based play page.
  const url = `${window.location.origin}/cf/${puzzleId}`;
  const outcomes = [];
  for (let i = 0; i < totalQuestions(); i++) outcomes.push((state.results[i] || {}).outcome || 'miss');
  const text = buildShareText({ title: titleText(), outcomes, score: score(), total: totalQuestions(), url });
  const btn = document.getElementById('cf-share-btn');
  await copyWithFeedback(btn, text, t('play.result.shareCopied'), {
    onFallback: () => window.prompt(t('play.result.share'), text),
  });
}

function onReset() {
  clearProgress('catfishing', puzzleId);
  state = {
    current: 0,
    results: [],
    phase: 'guessing',
    confirmSuggested: null,
    finished: false,
    guessValue: '',
    feedback: null,
  };
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============== PERSISTENCE ==============

function persist() {
  setProgress('catfishing', puzzleId, {
    current: state.current,
    results: state.results,
    phase: state.phase,
    confirmSuggested: state.confirmSuggested,
    finished: state.finished,
  });
}

// ============== BOOT ==============

initChrome({ games: ['catfishing'] });
main();

// Re-render on language flip: clues re-sort into the new language and every
// label refreshes. Stash the in-progress guess so typing survives the flip.
window.addEventListener('lang-changed', () => {
  if (!state) return;
  const input = document.getElementById('cf-guess-input');
  if (input) state.guessValue = input.value;
  render();
});
