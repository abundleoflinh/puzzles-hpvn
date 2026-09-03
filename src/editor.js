// Connections editor. Flow:
//   1. Password gate (cached in sessionStorage after first successful submit).
//   2. Optional: paste an existing puzzle ID to load & edit.
//   3. 4 rows (group name + 4 words). Order = difficulty (row 1 = yellow, row 4 = red).
//   4. Mistake mode + default theme.
//   5. Submit → result card with short URL + copy + Play Now.

import './styles/base.css';
import { initChrome } from './lib/chrome.js';
import { t, applyTranslations } from './lib/i18n.js';
import { fetchPuzzle, createPuzzle, updatePuzzle } from './lib/api.js';

const PASSWORD_KEY = 'hpvn.editor.password';
const DIFFICULTIES = ['yellow', 'green', 'blue', 'red'];

let editingId = null; // null = creating new; string = editing existing puzzle id

// ============== PASSWORD GATE ==============

function getCachedPassword() {
  try { return sessionStorage.getItem(PASSWORD_KEY) || ''; } catch { return ''; }
}
function cachePassword(pw) {
  try { sessionStorage.setItem(PASSWORD_KEY, pw); } catch {}
}
function clearCachedPassword() {
  try { sessionStorage.removeItem(PASSWORD_KEY); } catch {}
}

function renderGate() {
  const main = document.querySelector('[data-slot="main"]');
  main.innerHTML = `
    <div class="gate">
      <h1 data-i18n="editor.gate.title"></h1>
      <p data-i18n="editor.gate.lede"></p>
      <form id="gate-form">
        <div class="field">
          <input type="password" id="gate-password" data-i18n-attr="placeholder:editor.gate.placeholder" autocomplete="current-password" required />
          <button type="submit" class="btn btn-primary" data-i18n="editor.gate.submit"></button>
        </div>
        <p id="gate-error" class="notice-error" hidden></p>
      </form>
    </div>
  `;
  applyTranslations(main);
  document.getElementById('gate-form').addEventListener('submit', onGateSubmit);
  document.getElementById('gate-password').focus();
}

function onGateSubmit(e) {
  e.preventDefault();
  const pw = document.getElementById('gate-password').value;
  if (!pw) return;
  // No pre-validation endpoint — we cache and show the form.
  // Real validation happens on submit. If wrong, we bounce back here.
  cachePassword(pw);
  renderEditor();
}

// ============== EDITOR FORM ==============

function renderEditor() {
  const main = document.querySelector('[data-slot="main"]');
  main.innerHTML = `
    <div class="editor-header">
      <h1 data-i18n="editor.title"></h1>
      <p data-i18n="editor.lede"></p>
    </div>

    <div class="load-existing">
      <span class="load-existing-label" data-i18n="editor.load.label"></span>
      <input type="text" id="load-id" data-i18n-attr="placeholder:editor.load.placeholder" autocomplete="off" spellcheck="false" maxlength="30" />
      <button type="button" class="btn btn-sm" id="load-btn" data-i18n="editor.load.button"></button>
    </div>

    <form id="editor-form">
      <div class="editor-section">
        <div class="editor-section-title" data-i18n="editor.groups.heading"></div>
        <div id="groups-container"></div>
      </div>

      <div class="options-row">
        <div>
          <label class="field-label" for="mistake-mode" data-i18n="editor.options.mistakeMode.label"></label>
          <select class="input-block" id="mistake-mode">
            <option value="four" data-i18n="editor.options.mistakeMode.four"></option>
            <option value="endless" data-i18n="editor.options.mistakeMode.endless"></option>
          </select>
        </div>
        <div>
          <label class="field-label" for="default-theme" data-i18n="editor.options.defaultTheme.label"></label>
          <select class="input-block" id="default-theme">
            <option value="" data-i18n="editor.options.defaultTheme.none"></option>
            <option value="light" data-i18n="theme.light"></option>
            <option value="dark" data-i18n="theme.dark"></option>
            <option value="hpvn" data-i18n="theme.hpvn"></option>
          </select>
        </div>
        <div>
          <label class="field-label" for="default-lang" data-i18n="editor.options.defaultLang.label"></label>
          <select class="input-block" id="default-lang">
            <option value="" data-i18n="editor.options.defaultLang.none"></option>
            <option value="en" data-i18n="lang.en"></option>
            <option value="vi" data-i18n="lang.vi"></option>
          </select>
        </div>
      </div>

      <p id="editor-error" class="notice-error" hidden></p>

      <div class="form-actions">
        <button type="button" class="btn" id="reset-btn" data-i18n="editor.actions.reset"></button>
        <button type="submit" class="btn btn-primary" id="submit-btn" data-i18n="editor.actions.create"></button>
      </div>
    </form>

    <div id="result-slot"></div>
  `;
  renderGroupRows();
  applyTranslations(main);
  wireEditorEvents();
}

function renderGroupRows(prefill) {
  const container = document.getElementById('groups-container');
  container.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const diffIndex = i + 1;
    const row = document.createElement('div');
    row.className = 'group-row';
    row.setAttribute('data-difficulty', diffIndex);
    row.innerHTML = `
      <div class="group-row-head">
        <span class="group-row-label">${t('editor.group.label', { n: diffIndex })}</span>
        <span class="group-row-difficulty">${t(`editor.group.diff.${diffIndex}`)}</span>
      </div>
      <input type="text" class="input-block group-name" data-i18n-attr="placeholder:editor.group.namePlaceholder" autocomplete="off" maxlength="80" />
      <input type="text" class="input-block group-words" data-i18n-attr="placeholder:editor.group.wordsPlaceholder" autocomplete="off" maxlength="200" />
      <p class="group-row-help" data-i18n="editor.group.wordsHelp"></p>
    `;
    container.appendChild(row);
  }
  if (prefill && Array.isArray(prefill.groups)) {
    const rows = container.querySelectorAll('.group-row');
    prefill.groups.forEach((g, i) => {
      if (!rows[i]) return;
      rows[i].querySelector('.group-name').value = g.name || '';
      rows[i].querySelector('.group-words').value = (g.words || []).join(', ');
    });
  }
  applyTranslations(container);
}

function wireEditorEvents() {
  document.getElementById('load-btn').addEventListener('click', onLoadExisting);
  document.getElementById('reset-btn').addEventListener('click', onReset);
  document.getElementById('editor-form').addEventListener('submit', onEditorSubmit);
  document.getElementById('load-id').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onLoadExisting(); }
  });
}

// ============== LOAD EXISTING ==============

function parseIdInput(raw) {
  const s = (raw || '').trim();
  if (/^[A-Za-z0-9]{5}$/.test(s)) return s;
  const m = s.match(/[/#]c\/([A-Za-z0-9]{5})(?:[/?#&]|$)/);
  return m ? m[1] : null;
}

async function onLoadExisting() {
  const input = document.getElementById('load-id');
  const id = parseIdInput(input.value);
  const errEl = document.getElementById('editor-error');
  if (!id) {
    errEl.textContent = t('editor.load.invalid');
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  try {
    const { puzzle } = await fetchPuzzle('connections', id);
    editingId = id;
    renderGroupRows(puzzle);
    document.getElementById('mistake-mode').value = puzzle.mistakeMode === 'endless' ? 'endless' : 'four';
    document.getElementById('default-theme').value = puzzle.defaultTheme || '';
    document.getElementById('default-lang').value = puzzle.defaultLang || '';
    setSubmitMode('update');
    input.value = id;
    showResult({ kind: 'loaded', id });
  } catch (err) {
    if (err.status === 404) errEl.textContent = t('editor.load.notFound');
    else errEl.textContent = err.message || t('editor.error.generic');
    errEl.hidden = false;
  }
}

function onReset() {
  editingId = null;
  renderGroupRows();
  document.getElementById('mistake-mode').value = 'four';
  document.getElementById('default-theme').value = '';
  document.getElementById('load-id').value = '';
  setSubmitMode('create');
  document.getElementById('editor-error').hidden = true;
  document.getElementById('result-slot').innerHTML = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Set the submit button label + keep data-i18n in sync so applyTranslations()
// picks up the right key on the next language flip.
function setSubmitMode(mode) {
  const btn = document.getElementById('submit-btn');
  if (!btn) return;
  const key = mode === 'update' ? 'editor.actions.update' : 'editor.actions.create';
  btn.dataset.i18n = key;
  btn.textContent = t(key);
}

// ============== VALIDATION + SUBMIT ==============

function splitWords(raw) {
  return (raw || '').split(/[,;]/).map((w) => w.trim()).filter(Boolean);
}

// Returns { groups } if valid, or a string error message.
function validateForm() {
  const rows = document.querySelectorAll('.group-row');
  const groups = [];
  const seenNames = new Set();
  const seenWords = new Map();

  for (let i = 0; i < rows.length; i++) {
    const name = rows[i].querySelector('.group-name').value.trim();
    const words = splitWords(rows[i].querySelector('.group-words').value);

    if (!name) return t('editor.validation.groupName', { n: i + 1 });
    if (words.length !== 4) return t('editor.validation.groupWords', { n: i + 1, count: words.length });

    const nameLower = name.toLowerCase();
    if (seenNames.has(nameLower)) return t('editor.validation.duplicateName', { name });
    seenNames.add(nameLower);

    for (const w of words) {
      const wl = w.toLowerCase();
      if (seenWords.has(wl)) return t('editor.validation.duplicateWord', { word: w });
      seenWords.set(wl, i);
    }

    groups.push({ name, difficulty: DIFFICULTIES[i], words });
  }
  return { groups };
}

async function onEditorSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById('editor-error');
  const submitBtn = document.getElementById('submit-btn');

  const validation = validateForm();
  if (typeof validation === 'string') {
    errEl.textContent = validation;
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;

  const puzzle = {
    type: 'connections',
    groups: validation.groups,
    mistakeMode: document.getElementById('mistake-mode').value,
    defaultTheme: document.getElementById('default-theme').value || null,
    defaultLang: document.getElementById('default-lang').value || null,
    createdAt: new Date().toISOString(),
  };

  const password = getCachedPassword();
  if (!password) { renderGate(); return; }

  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = t('editor.actions.submitting');

  try {
    let id, url;
    if (editingId) {
      await updatePuzzle('connections', editingId, puzzle, password);
      id = editingId;
      url = `/play.html#c/${id}`;
      showResult({ kind: 'updated', id, url });
    } else {
      const res = await createPuzzle('connections', puzzle, password);
      id = res.id;
      url = `/play.html#c/${id}`;
      showResult({ kind: 'created', id, url });
    }
  } catch (err) {
    if (err.status === 401) {
      clearCachedPassword();
      errEl.textContent = t('editor.error.wrongPassword');
      errEl.hidden = false;
      setTimeout(() => renderGate(), 1200);
    } else {
      errEl.textContent = err.message || t('editor.error.generic');
      errEl.hidden = false;
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

// ============== RESULT CARD ==============

function showResult({ kind, id, url }) {
  const slot = document.getElementById('result-slot');
  if (!slot) return;

  if (kind === 'loaded') {
    slot.innerHTML = `
      <div class="result-card">
        <h2>${t('editor.result.loaded.title')}</h2>
        <p>${t('editor.result.loaded.body', { id })}</p>
      </div>
    `;
    return;
  }

  const fullUrl = `${window.location.origin}${url}`;
  const titleKey = kind === 'created' ? 'editor.result.created.title' : 'editor.result.updated.title';
  const bodyKey = kind === 'created' ? 'editor.result.created.body' : 'editor.result.updated.body';

  slot.innerHTML = `
    <div class="result-card">
      <h2>${t(titleKey)}</h2>
      <p>${t(bodyKey)}</p>
      <div class="result-url" id="result-url-text">${fullUrl}</div>
      <div class="result-actions">
        <a href="${url}" class="btn btn-primary">${t('editor.result.playNow')}</a>
        <button type="button" class="btn" id="copy-btn">${t('editor.result.copy')}</button>
        <button type="button" class="btn" id="another-btn">${t('editor.result.another')}</button>
      </div>
    </div>
  `;
  document.getElementById('copy-btn').addEventListener('click', () => copyToClipboard(fullUrl));
  document.getElementById('another-btn').addEventListener('click', onReset);
  slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function copyToClipboard(text) {
  const btn = document.getElementById('copy-btn');
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = t('editor.result.copied');
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch {
    const range = document.createRange();
    range.selectNode(document.getElementById('result-url-text'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }
}

// ============== I18N SYNC ==============

// The group-row header labels are built with runtime interpolation (t() calls
// happen at row-render time), so they can't use data-i18n. Rewrite them here
// when the language flips. Typed input values are left untouched.
function onLangChanged() {
  document.querySelectorAll('.group-row').forEach((row) => {
    const diffIndex = Number(row.getAttribute('data-difficulty'));
    if (!diffIndex) return;
    const label = row.querySelector('.group-row-label');
    const diff = row.querySelector('.group-row-difficulty');
    if (label) label.textContent = t('editor.group.label', { n: diffIndex });
    if (diff) diff.textContent = t(`editor.group.diff.${diffIndex}`);
  });
  // Submit button label — dataset.i18n was updated by setSubmitMode, but
  // applyTranslations (called from switchLang) already handled the plain text.
  // We call setSubmitMode again to be defensive if something else edited textContent.
  const btn = document.getElementById('submit-btn');
  if (btn && btn.dataset.i18n) btn.textContent = t(btn.dataset.i18n);
}

window.addEventListener('lang-changed', onLangChanged);

// ============== INIT ==============

initChrome();

if (getCachedPassword()) renderEditor();
else renderGate();
