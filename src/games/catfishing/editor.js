// Catfishing editor. Mounted into [data-slot="main"] as a third tab of
// editor.html after the parent shell (src/editor.js) has verified the password.
// Flow (Build Plan §8):
//   1. Meta: title + collection (shared chrome with the other editors).
//   2. Five question accordions (Q1 open). Each:
//      - Entity picker: searchable autocomplete over data/catalog.json (~7.8k
//        HP entities). Selecting prefills the EN answer, EN aliases, the
//        suggested difficulty, and the category → VI resolution table.
//      - Answer EN/VI + alias lists, an internal difficulty tag (never shown to
//        players), and the bilingual clue table (EN read-through, VI editable,
//        colour-coded by resolver status).
//   3. Translation helper: "Copy prompt" gathers the still-untranslated EN
//      strings into a Claude-ready prompt; "Paste translations" fills VI back
//      in from the returned JSON.
//   4. Preview + Publish → POST /api/puzzle (type: catfishing) → /cf/{id}.
//
// State lives at module scope so a language flip can re-mount the whole DOM
// without losing the author's work (same approach as the Strands editor).

import { t, applyTranslations } from '../../lib/i18n.js';
import { fetchPuzzle, createPuzzle, updatePuzzle, listCollections, createCollection } from '../../lib/api.js';
import { escapeHtml, parseShortLink, copyWithFeedback } from '../../lib/util.js';
import { renderEditorTabs } from '../../lib/editor-tabs.js';
import { resolveCategory, resolveCategories } from './dict-resolver.js';
import catalog from '../../../data/catalog.json';
import { getCurrentLang } from '../../lib/i18n.js';

const PASSWORD_KEY = 'hpvn.editor.password';
const NEW_COLLECTION_VALUE = '__new__';

const QUESTION_COUNT = 5;
const DIFFICULTIES = ['easy', 'medium', 'hard'];
// Default 2:2:1 (easy:easy:medium:medium:hard) per Build Plan §2.
const DEFAULT_DIFFICULTY_RATIO = ['easy', 'easy', 'medium', 'medium', 'hard'];
const MAX_ENTITY_RESULTS = 20; // autocomplete list cap

function getPassword() {
  try { return sessionStorage.getItem(PASSWORD_KEY) || ''; } catch { return ''; }
}

// ============== SEARCH INDEX ==============
// Built once from catalog.json: a flat, prominence-sorted array the entity
// picker filters over. catalog.json is keyed by slug → entity record.
let searchIndex = null;
function getSearchIndex() {
  if (searchIndex) return searchIndex;
  searchIndex = Object.entries(catalog).map(([key, e]) => ({
    key,
    name: e.canonical_en || key,
    aliases: Array.isArray(e.aliases_en) ? e.aliases_en : [],
    categories: Array.isArray(e.raw_categories) ? e.raw_categories : [],
    entityType: e.entity_type || '',
    difficulty: DIFFICULTIES.includes(e.suggested_difficulty) ? e.suggested_difficulty : 'medium',
    prominence: typeof e.prominence_score === 'number' ? e.prominence_score : 0,
  }));
  // Prominence descending so the most recognisable entities surface first.
  searchIndex.sort((a, b) => b.prominence - a.prominence);
  return searchIndex;
}

function searchEntities(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const item of getSearchIndex()) {
    const inName = item.name.toLowerCase().includes(q);
    const inAlias = !inName && item.aliases.some((a) => a.toLowerCase().includes(q));
    if (inName || inAlias) {
      out.push(item);
      if (out.length >= MAX_ENTITY_RESULTS) break; // already prominence-sorted
    }
  }
  return out;
}

// ============== STATE ==============

function blankQuestion(difficulty) {
  return {
    entityKey: null,
    answerEn: '',
    answerVi: '',
    aliasesEn: '',   // comma-separated in the UI
    aliasesVi: '',
    difficulty: difficulty || 'medium',
    clues: [],       // [{ en, vi, status }]
  };
}

const state = {
  editingId: null,
  editingCreatedAt: null,
  title: '',
  collectionId: '',
  expanded: 0,       // index of the open accordion
  questions: DEFAULT_DIFFICULTY_RATIO.map((d) => blankQuestion(d)),
};
let collectionsCache = [];
let lastOnSwitch = null;

// ============== MOUNT ==============

export async function mountCatfishingEditor(onSwitch) {
  lastOnSwitch = onSwitch;
  const main = document.querySelector('[data-slot="main"]');
  main.innerHTML = `
    <div id="editor-tabs-slot"></div>
    <div class="editor-header">
      <h1>${escapeHtml(t('catfishing.editor.title'))}</h1>
      <p>${escapeHtml(t('catfishing.editor.lede'))}</p>
    </div>

    <div class="load-existing">
      <span class="load-existing-label">${escapeHtml(t('editor.load.label'))}</span>
      <input type="text" id="cf-load-id" placeholder="${escapeHtml(t('editor.load.placeholder'))}" autocomplete="off" spellcheck="false" maxlength="40" />
      <button type="button" class="btn btn-sm" id="cf-load-btn">${escapeHtml(t('editor.load.button'))}</button>
    </div>

    <form id="cf-form">
      <div class="editor-section">
        <div class="editor-section-title">${escapeHtml(t('editor.meta.heading'))}</div>
        <div class="meta-row">
          <div>
            <label class="field-label" for="cf-title">${escapeHtml(t('editor.meta.title.label'))}</label>
            <input type="text" class="input-block" id="cf-title" placeholder="${escapeHtml(t('editor.meta.title.placeholder'))}" autocomplete="off" maxlength="80" />
          </div>
          <div>
            <label class="field-label" for="cf-collection">${escapeHtml(t('editor.meta.collection.label'))}</label>
            <select class="input-block" id="cf-collection"></select>
          </div>
        </div>
        <div class="new-collection-row" id="cf-new-collection-row" hidden>
          <input type="text" class="input-block" id="cf-new-collection-name" placeholder="${escapeHtml(t('editor.meta.collection.namePlaceholder'))}" autocomplete="off" maxlength="60" />
          <button type="button" class="btn btn-sm btn-primary" id="cf-new-collection-create">${escapeHtml(t('editor.meta.collection.createBtn'))}</button>
          <button type="button" class="btn btn-sm" id="cf-new-collection-cancel">${escapeHtml(t('editor.meta.collection.cancelBtn'))}</button>
        </div>
        <p class="meta-help">${escapeHtml(t('editor.meta.collection.help'))}</p>
      </div>

      <div class="editor-section">
        <div class="editor-section-title">${escapeHtml(t('catfishing.editor.questions.heading'))}</div>
        <p class="field-help">${escapeHtml(t('catfishing.editor.questions.help'))}</p>
        <div id="cf-questions"></div>
      </div>

      <div class="editor-section">
        <div class="editor-section-title">${escapeHtml(t('catfishing.editor.translate.heading'))}</div>
        <p class="field-help">${escapeHtml(t('catfishing.editor.translate.help'))}</p>
        <div class="cf-translate-actions">
          <button type="button" class="btn btn-sm" id="cf-copy-prompt">${escapeHtml(t('catfishing.editor.translate.copyPrompt'))}</button>
          <span class="cf-translate-note" id="cf-copy-note"></span>
        </div>
        <label class="field-label" for="cf-paste">${escapeHtml(t('catfishing.editor.translate.pasteLabel'))}</label>
        <textarea class="input-block cf-paste" id="cf-paste" rows="4" placeholder="${escapeHtml(t('catfishing.editor.translate.pastePlaceholder'))}"></textarea>
        <div class="cf-translate-actions">
          <button type="button" class="btn btn-sm" id="cf-paste-apply">${escapeHtml(t('catfishing.editor.translate.pasteApply'))}</button>
          <span class="cf-translate-note" id="cf-paste-note"></span>
        </div>
      </div>

      <p id="cf-error" class="notice-error" hidden></p>

      <div class="form-actions">
        <button type="button" class="btn" id="cf-reset-btn">${escapeHtml(t('editor.actions.reset'))}</button>
        <button type="button" class="btn" id="cf-preview-btn">${escapeHtml(t('catfishing.editor.preview.button'))}</button>
        <button type="submit" class="btn btn-primary" id="cf-submit-btn">${escapeHtml(t('editor.actions.create'))}</button>
      </div>
    </form>

    <div id="cf-preview-slot"></div>
    <div id="cf-result-slot"></div>
  `;
  renderEditorTabs(document.getElementById('editor-tabs-slot'), onSwitch);
  hydrateMeta();
  renderQuestions();
  wireEvents();
  applyTranslations(main);
  loadCollections(state.collectionId || undefined);
}

// Re-mount on language flip so every label refreshes; module state is kept.
window.addEventListener('lang-changed', () => {
  if (!document.getElementById('cf-form')) return;
  mountCatfishingEditor(lastOnSwitch);
});

function hydrateMeta() {
  const title = document.getElementById('cf-title');
  if (title) title.value = state.title;
  const submit = document.getElementById('cf-submit-btn');
  if (submit) submit.textContent = t(state.editingId ? 'editor.actions.update' : 'editor.actions.create');
}

// ============== QUESTIONS ==============

function renderQuestions() {
  const wrap = document.getElementById('cf-questions');
  if (!wrap) return;
  wrap.innerHTML = state.questions.map((q, i) => questionHtml(q, i)).join('');
  applyTranslations(wrap);
  // Wire per-question controls.
  state.questions.forEach((_, i) => wireQuestion(i));
}

function questionHtml(q, i) {
  const open = state.expanded === i;
  const answered = q.answerEn ? escapeHtml(q.answerEn) : `<span class="cf-q-unset">${escapeHtml(t('catfishing.editor.question.unset'))}</span>`;
  const diffLabel = t(`catfishing.editor.difficulty.${q.difficulty}`);
  return `
    <div class="cf-question ${open ? 'open' : ''}" data-i="${i}">
      <button type="button" class="cf-q-head" data-i="${i}" aria-expanded="${open}">
        <span class="cf-q-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span>
        <span class="cf-q-title">${escapeHtml(t('catfishing.editor.question.label', { n: i + 1 }))}</span>
        <span class="cf-q-answer">${answered}</span>
        <span class="cf-q-diff diff-${q.difficulty}">${escapeHtml(diffLabel)}</span>
      </button>
      <div class="cf-q-body" ${open ? '' : 'hidden'}>
        ${open ? questionBodyHtml(q, i) : ''}
      </div>
    </div>
  `;
}

function questionBodyHtml(q, i) {
  const diffOptions = DIFFICULTIES.map(
    (d) => `<option value="${d}" ${q.difficulty === d ? 'selected' : ''}>${escapeHtml(t(`catfishing.editor.difficulty.${d}`))}</option>`
  ).join('');
  return `
    <div class="cf-field">
      <label class="field-label" for="cf-entity-${i}">${escapeHtml(t('catfishing.editor.entityPicker.label'))}</label>
      <div class="cf-entity-picker">
        <input type="text" class="input-block cf-entity-input" id="cf-entity-${i}" data-i="${i}" placeholder="${escapeHtml(t('catfishing.editor.entityPicker.placeholder'))}" autocomplete="off" spellcheck="false" />
        <div class="cf-entity-results" id="cf-entity-results-${i}" hidden></div>
      </div>
      <p class="field-help">${escapeHtml(t('catfishing.editor.entityPicker.help'))}</p>
    </div>

    <div class="meta-row">
      <div>
        <label class="field-label" for="cf-answer-en-${i}">${escapeHtml(t('catfishing.editor.answer.enLabel'))}</label>
        <input type="text" class="input-block cf-answer-en" id="cf-answer-en-${i}" data-i="${i}" value="${escapeHtml(q.answerEn)}" autocomplete="off" maxlength="120" />
      </div>
      <div>
        <label class="field-label" for="cf-answer-vi-${i}">${escapeHtml(t('catfishing.editor.answer.viLabel'))}</label>
        <input type="text" class="input-block cf-answer-vi" id="cf-answer-vi-${i}" data-i="${i}" value="${escapeHtml(q.answerVi)}" autocomplete="off" maxlength="120" />
      </div>
    </div>

    <div class="meta-row">
      <div>
        <label class="field-label" for="cf-aliases-en-${i}">${escapeHtml(t('catfishing.editor.answer.aliasesEnLabel'))}</label>
        <input type="text" class="input-block cf-aliases-en" id="cf-aliases-en-${i}" data-i="${i}" value="${escapeHtml(q.aliasesEn)}" autocomplete="off" maxlength="240" />
      </div>
      <div>
        <label class="field-label" for="cf-aliases-vi-${i}">${escapeHtml(t('catfishing.editor.answer.aliasesViLabel'))}</label>
        <input type="text" class="input-block cf-aliases-vi" id="cf-aliases-vi-${i}" data-i="${i}" value="${escapeHtml(q.aliasesVi)}" autocomplete="off" maxlength="240" />
      </div>
    </div>
    <p class="field-help">${escapeHtml(t('catfishing.editor.answer.aliasesHelp'))}</p>

    <div class="cf-field">
      <label class="field-label" for="cf-difficulty-${i}">${escapeHtml(t('catfishing.editor.difficulty.label'))}</label>
      <select class="input-block cf-difficulty" id="cf-difficulty-${i}" data-i="${i}">${diffOptions}</select>
      <p class="field-help">${escapeHtml(t('catfishing.editor.difficulty.help'))}</p>
    </div>

    <div class="cf-field">
      <div class="field-label">${escapeHtml(t('catfishing.editor.clues.heading'))}</div>
      <div class="cf-clue-legend">
        <span class="cf-badge cf-badge-direct">${escapeHtml(t('catfishing.editor.status.direct'))}</span>
        <span class="cf-badge cf-badge-template">${escapeHtml(t('catfishing.editor.status.template'))}</span>
        <span class="cf-badge cf-badge-template_unresolved">${escapeHtml(t('catfishing.editor.status.template_unresolved'))}</span>
        <span class="cf-badge cf-badge-unresolved">${escapeHtml(t('catfishing.editor.status.unresolved'))}</span>
      </div>
      <div class="cf-clues" id="cf-clues-${i}">${cluesTableHtml(q, i)}</div>
      <button type="button" class="btn btn-sm cf-add-clue" data-i="${i}">${escapeHtml(t('catfishing.editor.clues.addRow'))}</button>
    </div>
  `;
}

function cluesTableHtml(q, i) {
  if (!q.clues.length) {
    return `<p class="cf-clues-empty">${escapeHtml(t('catfishing.editor.clues.empty'))}</p>`;
  }
  const rows = q.clues.map((c, ci) => `
    <div class="cf-clue-row" data-i="${i}" data-ci="${ci}">
      <span class="cf-badge cf-badge-${c.status || 'unresolved'}" title="${escapeHtml(t(`catfishing.editor.status.${c.status || 'unresolved'}`))}"></span>
      <input type="text" class="input-block cf-clue-en" data-i="${i}" data-ci="${ci}" value="${escapeHtml(c.en)}" placeholder="${escapeHtml(t('catfishing.editor.clues.enPlaceholder'))}" autocomplete="off" />
      <input type="text" class="input-block cf-clue-vi" data-i="${i}" data-ci="${ci}" value="${escapeHtml(c.vi)}" placeholder="${escapeHtml(t('catfishing.editor.clues.viPlaceholder'))}" autocomplete="off" />
      <button type="button" class="btn btn-sm cf-remove-clue" data-i="${i}" data-ci="${ci}" aria-label="${escapeHtml(t('catfishing.editor.clues.removeRow'))}">✕</button>
    </div>
  `).join('');
  return `
    <div class="cf-clue-head">
      <span></span>
      <span class="field-label">${escapeHtml(t('catfishing.editor.clues.enHeader'))}</span>
      <span class="field-label">${escapeHtml(t('catfishing.editor.clues.viHeader'))}</span>
      <span></span>
    </div>
    ${rows}
  `;
}

// Redraw one question's collapsed head (answer + difficulty chips) without
// tearing down its open body (so focus/caret in an input is preserved).
function refreshQuestionHead(i) {
  const el = document.querySelector(`.cf-question[data-i="${i}"] .cf-q-answer`);
  if (el) {
    el.innerHTML = state.questions[i].answerEn
      ? escapeHtml(state.questions[i].answerEn)
      : `<span class="cf-q-unset">${escapeHtml(t('catfishing.editor.question.unset'))}</span>`;
  }
  const diff = document.querySelector(`.cf-question[data-i="${i}"] .cf-q-diff`);
  if (diff) {
    diff.className = `cf-q-diff diff-${state.questions[i].difficulty}`;
    diff.textContent = t(`catfishing.editor.difficulty.${state.questions[i].difficulty}`);
  }
}

function redrawCluesTable(i) {
  const container = document.getElementById(`cf-clues-${i}`);
  if (!container) return;
  container.innerHTML = cluesTableHtml(state.questions[i], i);
  wireClues(i);
}

// ============== PER-QUESTION WIRING ==============

function wireQuestion(i) {
  const head = document.querySelector(`.cf-q-head[data-i="${i}"]`);
  if (head) head.addEventListener('click', () => toggleQuestion(i));
  if (state.expanded !== i) return; // body isn't rendered when collapsed

  const entityInput = document.getElementById(`cf-entity-${i}`);
  if (entityInput) {
    entityInput.addEventListener('input', (e) => onEntitySearch(i, e.target.value));
    // Hide the results shortly after blur so a click on a result still fires.
    entityInput.addEventListener('blur', () => setTimeout(() => hideEntityResults(i), 150));
  }

  bindInput(`cf-answer-en-${i}`, (v) => { state.questions[i].answerEn = v; refreshQuestionHead(i); });
  bindInput(`cf-answer-vi-${i}`, (v) => { state.questions[i].answerVi = v; });
  bindInput(`cf-aliases-en-${i}`, (v) => { state.questions[i].aliasesEn = v; });
  bindInput(`cf-aliases-vi-${i}`, (v) => { state.questions[i].aliasesVi = v; });

  const diff = document.getElementById(`cf-difficulty-${i}`);
  if (diff) diff.addEventListener('change', (e) => {
    state.questions[i].difficulty = DIFFICULTIES.includes(e.target.value) ? e.target.value : 'medium';
    refreshQuestionHead(i);
  });

  const addClue = document.querySelector(`.cf-add-clue[data-i="${i}"]`);
  if (addClue) addClue.addEventListener('click', () => {
    state.questions[i].clues.push({ en: '', vi: '', status: 'unresolved' });
    redrawCluesTable(i);
  });

  wireClues(i);
}

function bindInput(id, onValue) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', (e) => onValue(e.target.value));
}

function wireClues(i) {
  document.querySelectorAll(`#cf-clues-${i} .cf-clue-en`).forEach((el) => {
    el.addEventListener('input', (e) => {
      const ci = Number(e.target.dataset.ci);
      state.questions[i].clues[ci].en = e.target.value;
    });
    // Re-resolve status + suggest VI when the author finishes editing an EN cell.
    el.addEventListener('blur', (e) => {
      const ci = Number(e.target.dataset.ci);
      const clue = state.questions[i].clues[ci];
      const r = resolveCategory(clue.en);
      clue.status = r.status;
      if (!clue.vi && (r.status === 'direct' || r.status === 'template')) clue.vi = r.vi;
      redrawCluesTable(i);
    });
  });
  document.querySelectorAll(`#cf-clues-${i} .cf-clue-vi`).forEach((el) => {
    el.addEventListener('input', (e) => {
      const ci = Number(e.target.dataset.ci);
      state.questions[i].clues[ci].vi = e.target.value;
    });
  });
  document.querySelectorAll(`#cf-clues-${i} .cf-remove-clue`).forEach((el) => {
    el.addEventListener('click', (e) => {
      const ci = Number(e.currentTarget.dataset.ci);
      state.questions[i].clues.splice(ci, 1);
      redrawCluesTable(i);
    });
  });
}

function toggleQuestion(i) {
  state.expanded = state.expanded === i ? -1 : i;
  renderQuestions();
}

// ============== ENTITY PICKER ==============

function onEntitySearch(i, query) {
  const box = document.getElementById(`cf-entity-results-${i}`);
  if (!box) return;
  const results = searchEntities(query);
  if (!results.length) {
    box.innerHTML = query.trim()
      ? `<div class="cf-entity-none">${escapeHtml(t('catfishing.editor.entityPicker.noResults'))}</div>`
      : '';
    box.hidden = !query.trim();
    return;
  }
  box.innerHTML = results.map((r) => `
    <button type="button" class="cf-entity-result" data-i="${i}" data-key="${escapeHtml(r.key)}">
      <span class="cf-entity-name">${escapeHtml(r.name)}</span>
      <span class="cf-entity-meta">${escapeHtml(r.entityType)} · ${r.categories.length} ${escapeHtml(t('catfishing.editor.entityPicker.categoriesWord'))}</span>
    </button>
  `).join('');
  box.hidden = false;
  box.querySelectorAll('.cf-entity-result').forEach((btn) => {
    btn.addEventListener('click', () => selectEntity(i, btn.dataset.key));
  });
}

function hideEntityResults(i) {
  const box = document.getElementById(`cf-entity-results-${i}`);
  if (box) { box.hidden = true; box.innerHTML = ''; }
}

function selectEntity(i, key) {
  const item = getSearchIndex().find((e) => e.key === key);
  if (!item) return;
  const q = state.questions[i];
  q.entityKey = key;
  q.answerEn = item.name;
  q.aliasesEn = item.aliases.join(', ');
  q.difficulty = item.difficulty; // auto-suggested prominence tag
  // Resolve every raw category to a VI clue with a colour-coded status.
  q.clues = resolveCategories(item.categories).map((c) => ({ en: c.en, vi: c.vi, status: c.status }));
  hideEntityResults(i);
  // Full re-render of this question body so all prefilled fields + clue table show.
  renderQuestions();
}

// ============== TRANSLATION HELPER ==============

// Gather every EN string that still needs a VI translation: answers with an
// empty VI, and clues that are unresolved / template-unresolved OR simply have
// no VI yet. Deduplicated, order-preserving.
function collectUntranslated() {
  const seen = new Set();
  const list = [];
  const add = (en) => {
    const key = en.trim();
    if (!key || seen.has(key.toLowerCase())) return;
    seen.add(key.toLowerCase());
    list.push(key);
  };
  state.questions.forEach((q) => {
    if (q.answerEn && !q.answerVi.trim()) add(q.answerEn);
    q.clues.forEach((c) => {
      if (c.en && !c.vi.trim()) add(c.en);
    });
  });
  return list;
}

function buildTranslationPrompt(list) {
  // Author-facing tooling: this text is instructions to Claude in a separate
  // chat, not player UI, so it's fixed English. The Lý Lan note anchors the
  // canonical Vietnamese HP style used across the site.
  const items = list.map((s) => `- ${s}`).join('\n');
  return [
    'Translate these Harry Potter Fandom category names and character/entity names',
    'from English to Vietnamese. Use the canonical Lý Lan Vietnamese translation of',
    'Harry Potter for all names, houses, spells, and terms (e.g. "Muggle-borns" →',
    '"Phù thuỷ gốc Muggle"). Keep each translation concise — it is a game clue.',
    '',
    'Return ONLY a JSON object mapping each English string to its Vietnamese',
    'translation, with no commentary. Example: {"Gryffindors": "Nhà Gryffindor"}.',
    '',
    'Strings to translate:',
    items,
  ].join('\n');
}

async function onCopyPrompt() {
  const note = document.getElementById('cf-copy-note');
  const list = collectUntranslated();
  if (!list.length) {
    if (note) note.textContent = t('catfishing.editor.translate.noneNeeded');
    return;
  }
  const prompt = buildTranslationPrompt(list);
  const btn = document.getElementById('cf-copy-prompt');
  await copyWithFeedback(btn, prompt, t('catfishing.editor.translate.copied'));
  if (note) note.textContent = t('catfishing.editor.translate.copiedCount', { n: list.length });
}

// Apply a pasted JSON map { "English": "Vietnamese", ... } back onto every
// matching answer/alias-free clue whose EN matches a key (case-insensitive).
function onPasteApply() {
  const note = document.getElementById('cf-paste-note');
  const raw = document.getElementById('cf-paste').value.trim();
  if (!raw) { if (note) note.textContent = ''; return; }
  let map;
  try {
    map = JSON.parse(raw);
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('not an object');
  } catch {
    if (note) note.textContent = t('catfishing.editor.translate.pasteError');
    return;
  }
  // Normalize keys to lowercase-trimmed for lookup.
  const lut = new Map();
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === 'string') lut.set(k.trim().toLowerCase(), v);
  }
  let filled = 0;
  state.questions.forEach((q) => {
    if (q.answerEn && !q.answerVi.trim()) {
      const hit = lut.get(q.answerEn.trim().toLowerCase());
      if (hit) { q.answerVi = hit; filled++; }
    }
    q.clues.forEach((c) => {
      if (c.en && !c.vi.trim()) {
        const hit = lut.get(c.en.trim().toLowerCase());
        // The badge reflects dictionary resolution, not manual fills, so leave
        // c.status as-is — a hand-translated clue keeps its (yellow/red) badge
        // as an honest signal that its VI didn't come from the dictionary.
        if (hit) { c.vi = hit; filled++; }
      }
    });
  });
  renderQuestions();
  if (note) note.textContent = t('catfishing.editor.translate.pasteApplied', { n: filled });
}

// ============== PREVIEW ==============

function onPreview() {
  const slot = document.getElementById('cf-preview-slot');
  if (!slot) return;
  const lang = getCurrentLang();
  const cards = state.questions.map((q, i) => {
    const clues = q.clues.map((c) => (lang === 'vi' ? (c.vi || c.en) : c.en));
    clues.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const missingVi = q.clues.filter((c) => !c.vi.trim()).length;
    const warn = (!q.answerEn || !q.answerVi.trim() || !q.clues.length || missingVi)
      ? `<p class="cf-preview-warn">${escapeHtml(t('catfishing.editor.preview.warn', { n: missingVi }))}</p>`
      : '';
    return `
      <div class="cf-preview-card">
        <div class="cf-preview-card-head">
          <strong>${escapeHtml(t('catfishing.editor.question.label', { n: i + 1 }))}</strong>
          <span class="cf-q-diff diff-${q.difficulty}">${escapeHtml(t(`catfishing.editor.difficulty.${q.difficulty}`))}</span>
        </div>
        <p class="cf-preview-answer">${escapeHtml(t('catfishing.editor.preview.answerLabel'))}: <strong>${escapeHtml(q.answerEn || '—')}</strong> / ${escapeHtml(q.answerVi || '—')}</p>
        <p class="cf-preview-count">${escapeHtml(t('catfishing.editor.preview.cluesLabel', { n: q.clues.length }))}</p>
        <div class="cf-preview-clues">${clues.map((c) => `<span class="cf-preview-clue">${escapeHtml(c)}</span>`).join('')}</div>
        ${warn}
      </div>
    `;
  }).join('');
  slot.innerHTML = `
    <div class="cf-preview">
      <div class="cf-preview-head">
        <h2>${escapeHtml(t('catfishing.editor.preview.heading'))}</h2>
        <button type="button" class="btn btn-sm" id="cf-preview-close">${escapeHtml(t('catfishing.editor.preview.close'))}</button>
      </div>
      ${cards}
    </div>
  `;
  document.getElementById('cf-preview-close').addEventListener('click', () => { slot.innerHTML = ''; });
  slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============== COLLECTIONS (shared shape with the other editors) ==============

async function loadCollections(selectedId) {
  try {
    const res = await listCollections();
    collectionsCache = Array.isArray(res?.collections) ? res.collections : [];
  } catch { collectionsCache = []; }
  renderCollectionOptions(selectedId);
}

function renderCollectionOptions(selectedIdOverride) {
  const sel = document.getElementById('cf-collection');
  if (!sel) return;
  const currentValue = selectedIdOverride ?? sel.value ?? '';
  const sorted = [...collectionsCache].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
  );
  const options = [
    `<option value="">${escapeHtml(t('editor.meta.collection.none'))}</option>`,
    ...sorted.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`),
    `<option value="${NEW_COLLECTION_VALUE}">${escapeHtml(t('editor.meta.collection.new'))}</option>`,
  ];
  sel.innerHTML = options.join('');
  if (currentValue && sorted.some((c) => c.id === currentValue)) sel.value = currentValue;
  else if (currentValue === NEW_COLLECTION_VALUE) sel.value = currentValue;
  else sel.value = '';
}

// ============== WIRING ==============

function wireEvents() {
  document.getElementById('cf-title').addEventListener('input', (e) => { state.title = e.target.value; });
  document.getElementById('cf-collection').addEventListener('change', onCollectionChange);
  document.getElementById('cf-new-collection-create').addEventListener('click', onCreateCollection);
  document.getElementById('cf-new-collection-cancel').addEventListener('click', () => {
    document.getElementById('cf-new-collection-row').hidden = true;
    document.getElementById('cf-collection').value = '';
    state.collectionId = '';
  });
  document.getElementById('cf-copy-prompt').addEventListener('click', onCopyPrompt);
  document.getElementById('cf-paste-apply').addEventListener('click', onPasteApply);
  document.getElementById('cf-preview-btn').addEventListener('click', onPreview);
  document.getElementById('cf-reset-btn').addEventListener('click', onReset);
  document.getElementById('cf-form').addEventListener('submit', onSubmit);
  document.getElementById('cf-load-btn').addEventListener('click', onLoadExisting);
  document.getElementById('cf-load-id').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onLoadExisting(); }
  });
}

function onCollectionChange(e) {
  const v = e.target.value;
  state.collectionId = v && v !== NEW_COLLECTION_VALUE ? v : '';
  document.getElementById('cf-new-collection-row').hidden = v !== NEW_COLLECTION_VALUE;
}

async function onCreateCollection() {
  const name = document.getElementById('cf-new-collection-name').value.trim();
  if (!name) return;
  try {
    const res = await createCollection(name, getPassword());
    collectionsCache.push({ id: res.id, name: res.name });
    state.collectionId = res.id;
    document.getElementById('cf-new-collection-row').hidden = true;
    renderCollectionOptions(res.id);
  } catch (err) {
    showError(err.message || t('editor.error.generic'));
  }
}

// ============== LOAD EXISTING ==============

async function onLoadExisting() {
  const raw = document.getElementById('cf-load-id').value.trim();
  const parsed = parseShortLink(raw, { defaultType: 'catfishing', types: ['cf'] });
  if (!parsed || parsed.type !== 'catfishing') { showError(t('editor.load.invalid')); return; }
  try {
    const res = await fetchPuzzle('catfishing', parsed.id, getPassword());
    const p = res?.puzzle;
    // A password-authenticated GET returns the full set (answers present). If we
    // somehow got the masked player view (no answers), refuse rather than
    // hydrate a blank form — matches the Strands editor guard.
    if (!p || !Array.isArray(p.questions) || !p.questions[0] || !p.questions[0].answer) {
      showError(t('catfishing.editor.load.masked'));
      return;
    }
    hydrateFromPuzzle(parsed.id, p);
  } catch (err) {
    if (err.status === 404) showError(t('editor.load.notFound'));
    else showError(err.message || t('editor.error.generic'));
  }
}

function hydrateFromPuzzle(id, p) {
  showError('');
  state.editingId = id;
  state.editingCreatedAt = p.createdAt || null;
  state.title = p.title || '';
  state.collectionId = p.collectionId || '';
  state.expanded = 0;
  state.questions = (p.questions || []).slice(0, QUESTION_COUNT).map((q) => {
    const a = q.answer || {};
    return {
      entityKey: null,
      answerEn: a.en || '',
      answerVi: a.vi || '',
      aliasesEn: (a.aliases_en || []).join(', '),
      aliasesVi: (a.aliases_vi || []).join(', '),
      difficulty: DIFFICULTIES.includes(q.difficulty) ? q.difficulty : 'medium',
      clues: (q.clues || []).map((c) => {
        const r = resolveCategory(c.en);
        return { en: c.en || '', vi: c.vi || '', status: r.status };
      }),
    };
  });
  // Pad to exactly 5 if a stored set is somehow short.
  while (state.questions.length < QUESTION_COUNT) {
    state.questions.push(blankQuestion(DEFAULT_DIFFICULTY_RATIO[state.questions.length] || 'medium'));
  }
  document.getElementById('cf-title').value = state.title;
  renderCollectionOptions(state.collectionId);
  renderQuestions();
  document.getElementById('cf-submit-btn').textContent = t('editor.actions.update');
  showResult({ kind: 'loaded', id, url: `/cf/${id}` });
}

// ============== VALIDATION + SUBMIT ==============

function splitAliases(raw) {
  return (raw || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

// Returns a { questions } payload fragment, or a string error message.
function buildQuestions() {
  const out = [];
  for (let i = 0; i < state.questions.length; i++) {
    const q = state.questions[i];
    const answerEn = q.answerEn.trim();
    const answerVi = q.answerVi.trim();
    if (!answerEn) return t('catfishing.editor.validation.answerEn', { n: i + 1 });
    if (!answerVi) return t('catfishing.editor.validation.answerVi', { n: i + 1 });
    const clues = q.clues
      .map((c) => ({ en: c.en.trim(), vi: c.vi.trim() }))
      .filter((c) => c.en || c.vi);
    if (!clues.length) return t('catfishing.editor.validation.cluesRequired', { n: i + 1 });
    for (const c of clues) {
      if (!c.en || !c.vi) return t('catfishing.editor.validation.clueBilingual', { n: i + 1 });
    }
    if (!DIFFICULTIES.includes(q.difficulty)) return t('catfishing.editor.validation.difficulty', { n: i + 1 });
    out.push({
      answer: {
        en: answerEn,
        vi: answerVi,
        aliases_en: splitAliases(q.aliasesEn),
        aliases_vi: splitAliases(q.aliasesVi),
      },
      clues,
      difficulty: q.difficulty,
    });
  }
  if (out.length !== QUESTION_COUNT) return t('catfishing.editor.validation.questionCount', { n: QUESTION_COUNT });
  return { questions: out };
}

async function onSubmit(e) {
  e.preventDefault();
  showError('');
  const built = buildQuestions();
  if (typeof built === 'string') { showError(built); return; }

  const rawCollection = document.getElementById('cf-collection').value;
  const collectionId = rawCollection && rawCollection !== NEW_COLLECTION_VALUE ? rawCollection : null;

  const puzzle = {
    type: 'catfishing',
    title: state.title.trim() || null,
    collectionId,
    questions: built.questions,
    createdAt: state.editingId && state.editingCreatedAt ? state.editingCreatedAt : new Date().toISOString(),
  };

  const password = getPassword();
  if (!password) { window.location.reload(); return; } // bounce to gate

  const submitBtn = document.getElementById('cf-submit-btn');
  const original = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = t('editor.actions.submitting');
  try {
    let id, url;
    if (state.editingId) {
      await updatePuzzle('catfishing', state.editingId, puzzle, password);
      id = state.editingId;
      url = `/cf/${id}`;
      showResult({ kind: 'updated', id, url });
    } else {
      const res = await createPuzzle('catfishing', puzzle, password);
      id = res.id;
      url = `/cf/${id}`;
      state.editingId = id;
      showResult({ kind: 'created', id, url });
    }
  } catch (err) {
    if (err.status === 401) {
      try { sessionStorage.removeItem(PASSWORD_KEY); } catch {}
      window.location.reload();
      return;
    }
    showError(err.message || t('editor.error.generic'));
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = state.editingId ? t('editor.actions.update') : original;
  }
}

// ============== RESULT + ERRORS ==============

function showResult({ kind, id, url }) {
  const slot = document.getElementById('cf-result-slot');
  if (!slot) return;
  const title = t(`editor.result.${kind}.title`);
  const body = kind === 'loaded' ? t('editor.result.loaded.body', { id }) : t(`editor.result.${kind}.body`);
  const full = `${window.location.origin}${url}`;
  slot.innerHTML = `
    <div class="result-card">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
      <div class="result-url" id="cf-result-url-text">${escapeHtml(full)}</div>
      <div class="result-actions">
        <button type="button" class="btn btn-primary" id="cf-copy-btn">${escapeHtml(t('editor.result.copy'))}</button>
        <a class="btn" href="${escapeHtml(url)}">${escapeHtml(t('editor.result.playNow'))}</a>
      </div>
    </div>
  `;
  document.getElementById('cf-copy-btn').addEventListener('click', (e) => {
    copyWithFeedback(e.currentTarget, full, t('editor.result.copied'));
  });
  slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showError(msg) {
  const el = document.getElementById('cf-error');
  if (!el) return;
  if (!msg) { el.textContent = ''; el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function onReset() {
  state.editingId = null;
  state.editingCreatedAt = null;
  state.title = '';
  state.collectionId = '';
  state.expanded = 0;
  state.questions = DEFAULT_DIFFICULTY_RATIO.map((d) => blankQuestion(d));
  document.getElementById('cf-title').value = '';
  document.getElementById('cf-load-id').value = '';
  document.getElementById('cf-paste').value = '';
  document.getElementById('cf-result-slot').innerHTML = '';
  document.getElementById('cf-preview-slot').innerHTML = '';
  document.getElementById('cf-submit-btn').textContent = t('editor.actions.create');
  showError('');
  renderCollectionOptions('');
  renderQuestions();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
