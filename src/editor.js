// Connections editor. Flow:
//   1. Password gate (cached in sessionStorage after first successful submit).
//   2. Optional: paste an existing puzzle ID to load & edit.
//   3. 4 rows (group name + 4 words). Order = difficulty (row 1 = yellow, row 4 = red).
//   4. Mistake mode + default theme.
//   5. Submit → result card with short URL + copy + Play Now.

import './styles/base.css';
import { initChrome } from './lib/chrome.js';
import { t, applyTranslations } from './lib/i18n.js';
import { fetchPuzzle, createPuzzle, updatePuzzle, listCollections, createCollection, verifyPassword } from './lib/api.js';
import { escapeHtml } from './lib/util.js';

const PASSWORD_KEY = 'hpvn.editor.password';
const DIFFICULTIES = ['yellow', 'green', 'blue', 'red'];
const NEW_COLLECTION_VALUE = '__new__'; // sentinel option in the collection dropdown

let editingId = null; // null = creating new; string = editing existing puzzle id
let editingCreatedAt = null; // preserved so updates don't reset home-page ordering

// Cached collection list so we can rebuild the dropdown after inline creation
// without a refetch. Refreshed on editor render.
let collectionsCache = []; // [{ id, name, ... }]

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

async function onGateSubmit(e) {
  e.preventDefault();
  const pw = document.getElementById('gate-password').value;
  if (!pw) return;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const input = document.getElementById('gate-password');
  const errEl = document.getElementById('gate-error');
  errEl.hidden = true;
  // Disable the form while the check is in flight so a mash of Enter doesn't
  // stack up requests or race the redirect.
  submitBtn.disabled = true;
  input.disabled = true;
  try {
    const ok = await verifyPassword(pw);
    if (!ok) {
      errEl.textContent = t('editor.error.wrongPassword');
      errEl.hidden = false;
      // Do NOT cache — a wrong password must never grant access to the editor.
      input.value = '';
      input.focus();
      return;
    }
    cachePassword(pw);
    renderEditor();
  } catch (err) {
    // Network / 5xx: keep the user on the gate rather than showing an editor
    // we can't verify auth against.
    errEl.textContent = err.message || t('editor.error.generic');
    errEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
    input.disabled = false;
  }
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
        <div class="editor-section-title" data-i18n="editor.meta.heading"></div>
        <div class="meta-row">
          <div>
            <label class="field-label" for="puzzle-title" data-i18n="editor.meta.title.label"></label>
            <input type="text" class="input-block" id="puzzle-title" data-i18n-attr="placeholder:editor.meta.title.placeholder" autocomplete="off" maxlength="80" />
          </div>
          <div>
            <label class="field-label" for="puzzle-collection" data-i18n="editor.meta.collection.label"></label>
            <select class="input-block" id="puzzle-collection"></select>
          </div>
        </div>
        <div class="new-collection-row" id="new-collection-row" hidden>
          <input type="text" class="input-block" id="new-collection-name" data-i18n-attr="placeholder:editor.meta.collection.namePlaceholder" autocomplete="off" maxlength="60" />
          <button type="button" class="btn btn-sm btn-primary" id="new-collection-create" data-i18n="editor.meta.collection.createBtn"></button>
          <button type="button" class="btn btn-sm" id="new-collection-cancel" data-i18n="editor.meta.collection.cancelBtn"></button>
        </div>
        <p class="meta-help" data-i18n="editor.meta.collection.help"></p>
      </div>

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
  // Fetch collections in the background so the dropdown fills in without
  // blocking the editor from rendering. Failures are silent — the editor
  // still works, just with an empty collection list.
  loadCollections();
}

// ============== COLLECTIONS ==============

async function loadCollections(selectedId) {
  try {
    const res = await listCollections();
    collectionsCache = Array.isArray(res?.collections) ? res.collections : [];
  } catch {
    collectionsCache = [];
  }
  renderCollectionOptions(selectedId);
}

// Rebuilds the <select> options. Preserves the currently selected id
// (or accepts an explicit override — used right after inline create).
function renderCollectionOptions(selectedIdOverride) {
  const sel = document.getElementById('puzzle-collection');
  if (!sel) return;
  const currentValue = selectedIdOverride ?? sel.value ?? '';
  const sorted = [...collectionsCache].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
  );
  const noneLabel = t('editor.meta.collection.none');
  const newLabel = t('editor.meta.collection.new');
  const options = [
    `<option value="">${escapeHtml(noneLabel)}</option>`,
    ...sorted.map(
      (c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`
    ),
    `<option value="${NEW_COLLECTION_VALUE}">${escapeHtml(newLabel)}</option>`,
  ];
  sel.innerHTML = options.join('');
  // Restore selection if it still exists.
  if (currentValue && sorted.some((c) => c.id === currentValue)) {
    sel.value = currentValue;
  } else {
    sel.value = '';
  }
}

// Fired when the collection dropdown changes. Picking the "+ New collection"
// sentinel reveals an inline name field; picking anything else hides it.
// The actual create happens when the user clicks the inline Create button.
function onCollectionChange(e) {
  const sel = e.target;
  if (sel.value === NEW_COLLECTION_VALUE) {
    showNewCollectionRow();
  } else {
    hideNewCollectionRow();
  }
}

function showNewCollectionRow() {
  const row = document.getElementById('new-collection-row');
  const input = document.getElementById('new-collection-name');
  if (!row || !input) return;
  row.hidden = false;
  input.value = '';
  input.focus();
}

function hideNewCollectionRow() {
  const row = document.getElementById('new-collection-row');
  if (row) row.hidden = true;
}

// User clicked Cancel on the inline "new collection" row — revert the
// dropdown to "None" and hide the row.
function onNewCollectionCancel() {
  const sel = document.getElementById('puzzle-collection');
  if (sel) sel.value = '';
  hideNewCollectionRow();
}

// User clicked Create. Validate, call the API, then swap the new collection
// into the dropdown as the current selection.
async function onNewCollectionCreate() {
  const input = document.getElementById('new-collection-name');
  const errEl = document.getElementById('editor-error');
  const name = (input?.value || '').trim();
  if (!name) {
    input?.focus();
    return;
  }

  const password = getCachedPassword();
  if (!password) {
    onNewCollectionCancel();
    renderGate();
    return;
  }

  const createBtn = document.getElementById('new-collection-create');
  const originalText = createBtn?.textContent;
  if (createBtn) {
    createBtn.disabled = true;
    createBtn.textContent = t('editor.actions.submitting');
  }
  try {
    const created = await createCollection(name, password);
    collectionsCache.push({ id: created.id, name: created.name, createdAt: created.createdAt });
    hideNewCollectionRow();
    renderCollectionOptions(created.id);
    if (errEl) errEl.hidden = true;
  } catch (err) {
    if (err.status === 401) {
      clearCachedPassword();
      if (errEl) {
        errEl.textContent = t('editor.error.wrongPassword');
        errEl.hidden = false;
      }
      setTimeout(() => renderGate(), 1200);
    } else if (errEl) {
      errEl.textContent = err.message || t('editor.error.generic');
      errEl.hidden = false;
    }
  } finally {
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.textContent = originalText;
    }
  }
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
  document.getElementById('puzzle-collection').addEventListener('change', onCollectionChange);
  document.getElementById('new-collection-create').addEventListener('click', onNewCollectionCreate);
  document.getElementById('new-collection-cancel').addEventListener('click', onNewCollectionCancel);
  // Enter in the name field creates; Escape cancels.
  document.getElementById('new-collection-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onNewCollectionCreate(); }
    else if (e.key === 'Escape') { e.preventDefault(); onNewCollectionCancel(); }
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
    editingCreatedAt = puzzle.createdAt || null;
    renderGroupRows(puzzle);
    document.getElementById('mistake-mode').value = puzzle.mistakeMode === 'endless' ? 'endless' : 'four';
    document.getElementById('default-theme').value = puzzle.defaultTheme || '';
    document.getElementById('default-lang').value = puzzle.defaultLang || '';
    document.getElementById('puzzle-title').value = puzzle.title || '';
    // Re-render options with the loaded collectionId preselected. If the
    // collection no longer exists, this quietly falls back to "no collection".
    renderCollectionOptions(puzzle.collectionId || '');
    hideNewCollectionRow();
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
  editingCreatedAt = null;
  renderGroupRows();
  document.getElementById('mistake-mode').value = 'four';
  document.getElementById('default-theme').value = '';
  document.getElementById('default-lang').value = '';
  document.getElementById('puzzle-title').value = '';
  document.getElementById('load-id').value = '';
  renderCollectionOptions('');
  hideNewCollectionRow();
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

  const rawTitle = document.getElementById('puzzle-title').value.trim();
  const rawCollection = document.getElementById('puzzle-collection').value;
  // The "__new__" sentinel means the user opened the picker but never named
  // a collection — treat that as "no collection" rather than silently sending
  // an invalid id to the Worker.
  const collectionId = rawCollection && rawCollection !== NEW_COLLECTION_VALUE
    ? rawCollection
    : null;

  const puzzle = {
    type: 'connections',
    groups: validation.groups,
    mistakeMode: document.getElementById('mistake-mode').value,
    defaultTheme: document.getElementById('default-theme').value || null,
    defaultLang: document.getElementById('default-lang').value || null,
    title: rawTitle || null,
    collectionId,
    // Preserve the original createdAt on update — the home page uses it for
    // in-collection ordering, so overwriting would shuffle history.
    createdAt: editingId && editingCreatedAt ? editingCreatedAt : new Date().toISOString(),
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
      // Short URL — Cloudflare Pages redirects /c/{id} → /play.html#c/{id}.
      url = `/c/${id}`;
      showResult({ kind: 'updated', id, url });
    } else {
      const res = await createPuzzle('connections', puzzle, password);
      id = res.id;
      url = `/c/${id}`;
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
  // Rebuild the collection dropdown so "None" / "+ New collection" get the new
  // language. Real collection names come from the API and stay untouched.
  if (document.getElementById('puzzle-collection')) renderCollectionOptions();
}

window.addEventListener('lang-changed', onLangChanged);

// ============== INIT ==============

initChrome();

// Verify any cached password against the Worker before showing the editor.
// A stale/rotated password must not slip through just because it's in
// sessionStorage from an earlier successful login.
(async () => {
  const cached = getCachedPassword();
  if (!cached) { renderGate(); return; }
  try {
    const ok = await verifyPassword(cached);
    if (ok) { renderEditor(); return; }
    clearCachedPassword();
    renderGate();
  } catch {
    // Network error verifying — fall back to the gate rather than show an
    // editor whose auth we can't confirm.
    renderGate();
  }
})();
