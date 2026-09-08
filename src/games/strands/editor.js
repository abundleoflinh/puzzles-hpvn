// Strands editor. Mount into [data-slot="main"] after the parent editor
// shell has verified the password. Flow:
//   1. Choose grid size (rows × cols) → grid appears filled with blanks.
//   2. Enter title, theme clue, spangram, and 3–15 theme words.
//   3. Type letters into every grid cell (arrow keys navigate).
//   4. For each word (spangram + theme words), click "Draw path" and click
//      cells in order — letters must match. Path length must equal word length.
//   5. Submit. Server re-validates. Result card with short URL.
//
// The parent shell (src/editor.js) still owns the password gate; this module
// reads the cached password from sessionStorage.

import { t, applyTranslations } from '../../lib/i18n.js';
import { fetchPuzzle, createPuzzle, updatePuzzle, listCollections, createCollection } from '../../lib/api.js';
import { escapeHtml, parseShortLink, copyWithFeedback } from '../../lib/util.js';
import { renderEditorTabs } from '../../lib/editor-tabs.js';
import {
  ROW_MIN, ROW_MAX, COL_MIN, COL_MAX, ROW_DEFAULT, COL_DEFAULT,
  SPANGRAM_MIN, SPANGRAM_MAX, WORD_MIN_LEN, WORD_MIN_COUNT, WORD_MAX_COUNT,
} from './constants.js';
import { normalizeLetters, validatePuzzle, areAdjacent, touchesOppositeEdges } from './model.js';

const PASSWORD_KEY = 'hpvn.editor.password';
const NEW_COLLECTION_VALUE = '__new__';

function getPassword() {
  try { return sessionStorage.getItem(PASSWORD_KEY) || ''; } catch { return ''; }
}

// ============== STATE ==============

const state = {
  editingId: null,
  editingCreatedAt: null,
  title: '',
  theme: '',
  collectionId: '',
  rows: ROW_DEFAULT,
  cols: COL_DEFAULT,
  grid: Array(ROW_DEFAULT * COL_DEFAULT).fill(''),   // per-cell letter, uppercase A–Z or ''
  spangramWord: '',
  spangramPath: null,   // null | [cellIdx, ...]
  words: [],            // [{ word, path: [cellIdx,...] | null }]
  drawing: null,        // null | { target: 'spangram' | number, buf: [cellIdx,...] }
  defaultTheme: '',
  defaultLang: '',
};
let collectionsCache = [];

// ============== MOUNT ==============

// `onSwitch` is passed by the parent shell (src/editor.js) so tab clicks can
// swap editors without reloading the page.
export async function mountStrandsEditor(onSwitch) {
  const main = document.querySelector('[data-slot="main"]');
  main.innerHTML = `
    <div id="editor-tabs-slot"></div>
    <div class="editor-header">
      <h1>${escapeHtml(t('strands.editor.title'))}</h1>
      <p>${escapeHtml(t('strands.editor.lede'))}</p>
    </div>

    <div class="load-existing">
      <span class="load-existing-label">${escapeHtml(t('editor.load.label'))}</span>
      <input type="text" id="strands-load-id" placeholder="${escapeHtml(t('editor.load.placeholder'))}" autocomplete="off" spellcheck="false" maxlength="30" />
      <button type="button" class="btn btn-sm" id="strands-load-btn">${escapeHtml(t('editor.load.button'))}</button>
    </div>

    <form id="strands-form">
      <div class="editor-section">
        <div class="editor-section-title">${escapeHtml(t('editor.meta.heading'))}</div>
        <div class="meta-row">
          <div>
            <label class="field-label" for="strands-title">${escapeHtml(t('editor.meta.title.label'))}</label>
            <input type="text" class="input-block" id="strands-title" maxlength="80" />
          </div>
          <div>
            <label class="field-label" for="strands-collection">${escapeHtml(t('editor.meta.collection.label'))}</label>
            <select class="input-block" id="strands-collection"></select>
          </div>
        </div>
        <div class="new-collection-row" id="strands-new-collection-row" hidden>
          <input type="text" class="input-block" id="strands-new-collection-name" placeholder="${escapeHtml(t('editor.meta.collection.namePlaceholder'))}" autocomplete="off" maxlength="60" />
          <button type="button" class="btn btn-sm btn-primary" id="strands-new-collection-create">${escapeHtml(t('editor.meta.collection.createBtn'))}</button>
          <button type="button" class="btn btn-sm" id="strands-new-collection-cancel">${escapeHtml(t('editor.meta.collection.cancelBtn'))}</button>
        </div>
      </div>

      <div class="editor-section">
        <div class="editor-section-title">${escapeHtml(t('strands.editor.words.heading'))}</div>
        <div class="meta-row">
          <div>
            <label class="field-label" for="strands-theme">${escapeHtml(t('strands.editor.theme.label'))}</label>
            <input type="text" class="input-block" id="strands-theme" maxlength="200" placeholder="${escapeHtml(t('strands.editor.theme.placeholder'))}" />
          </div>
          <div class="strands-size-row">
            <label class="field-label" for="strands-rows">${escapeHtml(t('strands.editor.size.label'))}</label>
            <span>
              <select id="strands-rows"></select>
              ×
              <select id="strands-cols"></select>
            </span>
          </div>
        </div>
        <div class="meta-row">
          <div>
            <label class="field-label" for="strands-spangram">${escapeHtml(t('strands.editor.spangram.label'))}</label>
            <input type="text" class="input-block" id="strands-spangram" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(t('strands.editor.spangram.placeholder'))}" />
          </div>
        </div>
        <div>
          <div class="field-label">${escapeHtml(t('strands.editor.themeWords.label'))}</div>
          <div id="strands-words-list"></div>
          <button type="button" class="btn btn-sm" id="strands-add-word">${escapeHtml(t('strands.editor.themeWords.add'))}</button>
        </div>
        <p class="field-help" id="strands-letter-count"></p>
      </div>

      <div class="editor-section strands-editor-columns">
        <div class="strands-editor-col-grid">
          <div class="editor-section-title">${escapeHtml(t('strands.editor.grid.heading'))}</div>
          <p class="field-help">${escapeHtml(t('strands.editor.grid.help'))}</p>
          <div class="strands-editor-board">
            <div class="strands-grid" id="strands-editor-grid"></div>
          </div>
        </div>
        <div class="strands-editor-col-paths">
          <div class="editor-section-title">${escapeHtml(t('strands.editor.paths.heading'))}</div>
          <p class="field-help" id="strands-drawing-help">${escapeHtml(t('strands.editor.paths.help'))}</p>
          <div id="strands-paths-list"></div>
        </div>
      </div>

      <div class="options-row">
        <div>
          <label class="field-label" for="strands-default-theme">${escapeHtml(t('editor.options.defaultTheme.label'))}</label>
          <select class="input-block" id="strands-default-theme">
            <option value="">${escapeHtml(t('editor.options.defaultTheme.none'))}</option>
            <option value="light">${escapeHtml(t('theme.light'))}</option>
            <option value="dark">${escapeHtml(t('theme.dark'))}</option>
            <option value="hpvn">${escapeHtml(t('theme.hpvn'))}</option>
          </select>
        </div>
        <div>
          <label class="field-label" for="strands-default-lang">${escapeHtml(t('editor.options.defaultLang.label'))}</label>
          <select class="input-block" id="strands-default-lang">
            <option value="">${escapeHtml(t('editor.options.defaultLang.none'))}</option>
            <option value="en">${escapeHtml(t('lang.en'))}</option>
            <option value="vi">${escapeHtml(t('lang.vi'))}</option>
          </select>
        </div>
      </div>

      <p id="strands-error" class="notice-error" hidden></p>

      <div class="form-actions">
        <button type="button" class="btn" id="strands-reset-btn">${escapeHtml(t('editor.actions.reset'))}</button>
        <button type="submit" class="btn btn-primary" id="strands-submit-btn">${escapeHtml(t('editor.actions.create'))}</button>
      </div>
    </form>

    <div id="strands-result-slot"></div>
  `;
  renderEditorTabs(document.getElementById('editor-tabs-slot'), onSwitch);

  fillSizeSelects();
  // Seed the word list on the first mount only. Language-flip re-mounts keep
  // the existing state so the author doesn't lose work.
  if (!state.words.length) { addWordRow(); addWordRow(); addWordRow(); }
  renderWordList();
  hydrateInputs();
  renderGrid();
  renderPathsList();
  renderLetterCount();
  wireEvents();
  applyTranslations(main);
  loadCollections(state.collectionId || undefined);
  lastOnSwitch = onSwitch;
}

// Push current state values back into the form inputs. Called on mount and
// after language flips so the form isn't wiped when the DOM rebuilds.
function hydrateInputs() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
  set('strands-title', state.title);
  set('strands-theme', state.theme);
  set('strands-spangram', state.spangramWord);
  set('strands-rows', String(state.rows));
  set('strands-cols', String(state.cols));
  set('strands-default-theme', state.defaultTheme);
  set('strands-default-lang', state.defaultLang);
  const submitBtn = document.getElementById('strands-submit-btn');
  if (submitBtn) submitBtn.textContent = t(state.editingId ? 'editor.actions.update' : 'editor.actions.create');
}

let lastOnSwitch = null;
// Language flip: re-render the whole editor DOM using the current state so
// every label refreshes. Preserves state (module-level) so nothing is lost.
window.addEventListener('lang-changed', () => {
  // Only re-render if a Strands editor is currently mounted; otherwise this
  // listener has been registered but Connections is on screen.
  if (!document.getElementById('strands-form')) return;
  mountStrandsEditor(lastOnSwitch);
});

function fillSizeSelects() {
  const rows = document.getElementById('strands-rows');
  const cols = document.getElementById('strands-cols');
  for (let n = ROW_MIN; n <= ROW_MAX; n++) rows.append(new Option(String(n), String(n)));
  for (let n = COL_MIN; n <= COL_MAX; n++) cols.append(new Option(String(n), String(n)));
  rows.value = String(state.rows);
  cols.value = String(state.cols);
}

// ============== WORD LIST ==============

function addWordRow(existingValue = '', existingPath = null) {
  if (state.words.length >= WORD_MAX_COUNT) return;
  state.words.push({ word: normalizeLetters(existingValue), path: existingPath });
  renderWordList();
}

function removeWordRow(i) {
  state.words.splice(i, 1);
  renderWordList();
  renderPathsList();
  renderLetterCount();
}

function renderWordList() {
  const list = document.getElementById('strands-words-list');
  if (!list) return;
  list.innerHTML = state.words.map((w, i) => `
    <div class="strands-word-row" data-i="${i}">
      <input type="text" class="input-block strands-word-input" data-i="${i}" value="${escapeHtml(w.word)}" placeholder="${escapeHtml(t('strands.editor.themeWords.placeholder'))}" autocomplete="off" spellcheck="false" />
      <button type="button" class="btn btn-sm strands-word-remove" data-i="${i}" aria-label="${escapeHtml(t('strands.editor.themeWords.remove'))}">✕</button>
    </div>
  `).join('');
  list.querySelectorAll('.strands-word-input').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const i = parseInt(e.target.dataset.i, 10);
      const next = normalizeLetters(e.target.value);
      if (state.words[i].word !== next) {
        state.words[i].word = next;
        state.words[i].path = null; // typing invalidates a previously drawn path
        renderPathsList();
        renderLetterCount();
      }
    });
  });
  list.querySelectorAll('.strands-word-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => removeWordRow(parseInt(e.currentTarget.dataset.i, 10)));
  });
}

function renderLetterCount() {
  const el = document.getElementById('strands-letter-count');
  if (!el) return;
  let n = state.spangramWord.length;
  for (const w of state.words) n += w.word.length;
  const need = state.rows * state.cols;
  const diff = need - n;
  let msg;
  if (diff === 0) msg = t('strands.editor.letterCount.exact', { n });
  else if (diff > 0) msg = t('strands.editor.letterCount.need', { n, more: diff });
  else msg = t('strands.editor.letterCount.over', { n, over: -diff });
  el.textContent = msg;
  // Colour-cue: green when exact match, red when off in either direction.
  el.dataset.tone = diff === 0 ? 'good' : 'bad';
}

// ============== GRID ==============

function resizeGrid(newRows, newCols) {
  const oldGrid = state.grid;
  const oldCols = state.cols;
  const next = Array(newRows * newCols).fill('');
  // Preserve overlapping cells so the author doesn't lose typed letters on a
  // small resize (best-effort — cells outside the new grid are dropped).
  for (let r = 0; r < Math.min(state.rows, newRows); r++) {
    for (let c = 0; c < Math.min(oldCols, newCols); c++) {
      next[r * newCols + c] = oldGrid[r * oldCols + c] || '';
    }
  }
  state.rows = newRows;
  state.cols = newCols;
  state.grid = next;
  // Any previously drawn paths are meaningless on a different grid → clear.
  state.spangramPath = null;
  for (const w of state.words) w.path = null;
  state.drawing = null;
  renderGrid();
  renderPathsList();
  renderLetterCount();
}

function renderGrid() {
  const grid = document.getElementById('strands-editor-grid');
  if (!grid) return;
  grid.style.setProperty('--rows', String(state.rows));
  grid.style.setProperty('--cols', String(state.cols));
  const drawing = state.drawing;
  const drawingBuf = drawing ? new Set(drawing.buf) : new Set();
  const drawingLast = drawing && drawing.buf.length ? drawing.buf[drawing.buf.length - 1] : null;
  const claimed = claimedCellSet();
  grid.innerHTML = '';
  for (let i = 0; i < state.grid.length; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'strands-editor-cell';
    if (claimed.has(i)) wrap.classList.add('claimed');
    if (drawingBuf.has(i)) wrap.classList.add('drawing');
    if (drawingLast === i) wrap.classList.add('drawing-last');
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 1;
    input.value = state.grid[i] || '';
    input.dataset.i = String(i);
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', onCellInput);
    input.addEventListener('keydown', onCellKeydown);
    input.addEventListener('click', onCellClick);
    wrap.appendChild(input);
    grid.appendChild(wrap);
  }
}

// Cells that already belong to a committed path (spangram or theme word).
function claimedCellSet() {
  const s = new Set();
  if (state.spangramPath) for (const c of state.spangramPath) s.add(c);
  for (const w of state.words) if (w.path) for (const c of w.path) s.add(c);
  return s;
}

function onCellInput(e) {
  const i = parseInt(e.target.dataset.i, 10);
  const raw = normalizeLetters(e.target.value).slice(0, 1);
  state.grid[i] = raw;
  e.target.value = raw;
  // If a cell in a committed path changes letter, invalidate that path.
  invalidatePathsUsingCell(i);
}

function onCellKeydown(e) {
  const i = parseInt(e.target.dataset.i, 10);
  const cols = state.cols;
  let target = null;
  if (e.key === 'ArrowRight') target = i + 1;
  else if (e.key === 'ArrowLeft') target = i - 1;
  else if (e.key === 'ArrowUp') target = i - cols;
  else if (e.key === 'ArrowDown') target = i + cols;
  else if (e.key === 'Backspace' && !e.target.value) target = i - 1;
  if (target != null && target >= 0 && target < state.grid.length) {
    e.preventDefault();
    const next = document.querySelector(`.strands-editor-cell input[data-i="${target}"]`);
    if (next) { next.focus(); next.select(); }
  }
}

function onCellClick(e) {
  // Only relevant while drawing. Prevents the text-input default from
  // stealing focus in a way that blocks the click event.
  if (!state.drawing) return;
  e.preventDefault();
  const i = parseInt(e.target.dataset.i, 10);
  extendDrawing(i);
}

function invalidatePathsUsingCell(cellIdx) {
  let changed = false;
  if (state.spangramPath && state.spangramPath.includes(cellIdx)) {
    state.spangramPath = null; changed = true;
  }
  for (const w of state.words) {
    if (w.path && w.path.includes(cellIdx)) { w.path = null; changed = true; }
  }
  if (changed) renderPathsList();
}

// ============== PATHS ==============

function renderPathsList() {
  const list = document.getElementById('strands-paths-list');
  if (!list) return;
  const rows = [];
  const spangramLabel = state.spangramWord || `(${t('strands.editor.paths.noSpangram')})`;
  rows.push(pathRowHtml('spangram', t('strands.editor.paths.spangram'), state.spangramWord, state.spangramPath, spangramLabel));
  state.words.forEach((w, i) => {
    rows.push(pathRowHtml(String(i), t('strands.editor.paths.word', { n: i + 1 }), w.word, w.path));
  });
  list.innerHTML = rows.join('');
  list.querySelectorAll('.strands-path-draw').forEach((btn) => {
    btn.addEventListener('click', (e) => startDrawing(e.currentTarget.dataset.target));
  });
  list.querySelectorAll('.strands-path-clear').forEach((btn) => {
    btn.addEventListener('click', (e) => clearPath(e.currentTarget.dataset.target));
  });
  updateDrawingHelp();
}

function pathRowHtml(target, label, word, path) {
  const status = !word
    ? `<span class="tag warn">${escapeHtml(t('strands.editor.paths.enterWord'))}</span>`
    : path
    ? `<span class="tag good">${escapeHtml(t('strands.editor.paths.set'))}</span>`
    : `<span class="tag warn">${escapeHtml(t('strands.editor.paths.notSet'))}</span>`;
  const wordDisplay = word ? escapeHtml(word) : '·';
  const isDrawing = state.drawing && state.drawing.target === target;
  const drawLabel = isDrawing ? t('strands.editor.paths.cancel') : t('strands.editor.paths.draw');
  return `
    <div class="strands-path-row">
      <div class="strands-path-label">${escapeHtml(label)}: <strong>${wordDisplay}</strong></div>
      ${status}
      <button type="button" class="btn btn-sm strands-path-draw" data-target="${escapeHtml(target)}" ${word ? '' : 'disabled'}>${escapeHtml(drawLabel)}</button>
      <button type="button" class="btn btn-sm strands-path-clear" data-target="${escapeHtml(target)}" ${path ? '' : 'disabled'}>${escapeHtml(t('strands.editor.paths.clear'))}</button>
    </div>
  `;
}

function startDrawing(target) {
  if (state.drawing && state.drawing.target === target) {
    state.drawing = null;
  } else {
    state.drawing = { target, buf: [] };
  }
  renderGrid();
  renderPathsList();
}

function clearPath(target) {
  if (target === 'spangram') state.spangramPath = null;
  else state.words[parseInt(target, 10)].path = null;
  renderGrid();
  renderPathsList();
}

function extendDrawing(cellIdx) {
  const d = state.drawing;
  if (!d) return;
  const word = d.target === 'spangram' ? state.spangramWord : state.words[parseInt(d.target, 10)].word;
  if (!word) return;
  const claimed = claimedCellSet();
  // Cells belonging to OTHER committed paths are off-limits.
  const otherClaimed = new Set(claimed);
  const currentPath = d.target === 'spangram' ? state.spangramPath : state.words[parseInt(d.target, 10)].path;
  if (currentPath) for (const c of currentPath) otherClaimed.delete(c);
  if (otherClaimed.has(cellIdx)) { flashError(t('strands.editor.paths.errCellClaimed')); return; }

  // Backtrack: clicking a cell already in the buf trims to that cell.
  const pos = d.buf.indexOf(cellIdx);
  if (pos !== -1) { d.buf = d.buf.slice(0, pos + 1); renderGrid(); return; }

  // Adjacency check against last cell (if any).
  if (d.buf.length > 0 && !areAdjacent(d.buf[d.buf.length - 1], cellIdx, state.cols)) {
    flashError(t('strands.editor.paths.errNotAdjacent'));
    return;
  }
  // Letter must match the next character of the target word.
  const nextChar = word[d.buf.length];
  const cellLetter = state.grid[cellIdx] || '';
  if (!cellLetter) {
    // Auto-fill empty cell with the expected letter for convenience.
    state.grid[cellIdx] = nextChar;
    const inp = document.querySelector(`.strands-editor-cell input[data-i="${cellIdx}"]`);
    if (inp) inp.value = nextChar;
  } else if (cellLetter !== nextChar) {
    flashError(t('strands.editor.paths.errLetter', { expected: nextChar, got: cellLetter }));
    return;
  }
  d.buf.push(cellIdx);
  if (d.buf.length === word.length) {
    // Commit.
    if (d.target === 'spangram') state.spangramPath = [...d.buf];
    else state.words[parseInt(d.target, 10)].path = [...d.buf];
    state.drawing = null;
  }
  renderGrid();
  renderPathsList();
}

function updateDrawingHelp() {
  const el = document.getElementById('strands-drawing-help');
  if (!el) return;
  if (!state.drawing) { el.textContent = t('strands.editor.paths.help'); return; }
  const word = state.drawing.target === 'spangram'
    ? state.spangramWord
    : state.words[parseInt(state.drawing.target, 10)].word;
  el.textContent = t('strands.editor.paths.drawing', {
    word, i: state.drawing.buf.length, of: word.length,
  });
}

// Transient error toast — used for path-drawing errors that should self-hide.
function flashError(msg) {
  const el = document.getElementById('strands-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(flashError._t);
  flashError._t = setTimeout(() => { el.hidden = true; }, 3000);
}

// Persistent error surface — for validation and API errors that should stay
// visible until the user acts. Cleared on next submit or reset. Cancels any
// pending flash timer so the two don't fight.
function showError(msg) {
  const el = document.getElementById('strands-error');
  if (!el) return;
  clearTimeout(flashError._t);
  if (!msg) { el.textContent = ''; el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
}

// ============== COLLECTIONS ==============

async function loadCollections(selectedId) {
  try {
    const res = await listCollections();
    collectionsCache = Array.isArray(res?.collections) ? res.collections : [];
  } catch { collectionsCache = []; }
  renderCollectionOptions(selectedId);
}

function renderCollectionOptions(selectedIdOverride) {
  const sel = document.getElementById('strands-collection');
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
  document.getElementById('strands-title').addEventListener('input', (e) => { state.title = e.target.value; });
  document.getElementById('strands-theme').addEventListener('input', (e) => { state.theme = e.target.value; });
  document.getElementById('strands-collection').addEventListener('change', onCollectionChange);
  document.getElementById('strands-new-collection-create').addEventListener('click', onCreateCollection);
  document.getElementById('strands-new-collection-cancel').addEventListener('click', () => {
    document.getElementById('strands-new-collection-row').hidden = true;
    document.getElementById('strands-collection').value = '';
  });

  document.getElementById('strands-rows').addEventListener('change', (e) => {
    resizeGrid(parseInt(e.target.value, 10), state.cols);
  });
  document.getElementById('strands-cols').addEventListener('change', (e) => {
    resizeGrid(state.rows, parseInt(e.target.value, 10));
  });

  document.getElementById('strands-spangram').addEventListener('input', (e) => {
    const next = normalizeLetters(e.target.value);
    e.target.value = next;
    if (next !== state.spangramWord) {
      state.spangramWord = next;
      state.spangramPath = null;
      renderPathsList();
      renderLetterCount();
    }
  });

  document.getElementById('strands-add-word').addEventListener('click', () => addWordRow());
  document.getElementById('strands-default-theme').addEventListener('change', (e) => { state.defaultTheme = e.target.value; });
  document.getElementById('strands-default-lang').addEventListener('change', (e) => { state.defaultLang = e.target.value; });

  document.getElementById('strands-reset-btn').addEventListener('click', onReset);
  document.getElementById('strands-form').addEventListener('submit', onSubmit);
  document.getElementById('strands-load-btn').addEventListener('click', onLoadExisting);
}

function onCollectionChange(e) {
  const v = e.target.value;
  state.collectionId = v && v !== NEW_COLLECTION_VALUE ? v : '';
  document.getElementById('strands-new-collection-row').hidden = v !== NEW_COLLECTION_VALUE;
}

async function onCreateCollection() {
  const name = document.getElementById('strands-new-collection-name').value.trim();
  if (!name) return;
  try {
    const res = await createCollection(name, getPassword());
    collectionsCache.push({ id: res.id, name: res.name });
    state.collectionId = res.id;
    document.getElementById('strands-new-collection-row').hidden = true;
    renderCollectionOptions(res.id);
  } catch (err) {
    flashError(err.message || t('editor.error.generic'));
  }
}

// ============== LOAD EXISTING ==============

async function onLoadExisting() {
  const raw = document.getElementById('strands-load-id').value.trim();
  const parsed = parseShortLink(raw, { defaultType: 'strands', types: ['s'] });
  if (!parsed || parsed.type !== 'strands') { flashError(t('editor.load.invalid')); return; }
  try {
    const res = await fetchPuzzle('strands', parsed.id, getPassword());
    hydrateFromPuzzle(parsed.id, res.puzzle);
  } catch (err) {
    if (err.status === 404) flashError(t('editor.load.notFound'));
    else flashError(err.message || t('editor.error.generic'));
  }
}

function hydrateFromPuzzle(id, p) {
  showError('');
  state.editingId = id;
  state.editingCreatedAt = p.createdAt || null;
  state.title = p.title || '';
  state.theme = p.theme || '';
  state.rows = p.rows;
  state.cols = p.cols;
  state.grid = [...p.grid];
  state.spangramWord = p.spangram?.word || '';
  state.spangramPath = p.spangram?.path ? [...p.spangram.path] : null;
  state.words = (p.words || []).map((w) => ({ word: w.word, path: w.path ? [...w.path] : null }));
  state.collectionId = p.collectionId || '';
  state.defaultTheme = p.defaultTheme || '';
  state.defaultLang = p.defaultLang || '';
  document.getElementById('strands-title').value = state.title;
  document.getElementById('strands-theme').value = state.theme;
  document.getElementById('strands-spangram').value = state.spangramWord;
  document.getElementById('strands-rows').value = String(state.rows);
  document.getElementById('strands-cols').value = String(state.cols);
  document.getElementById('strands-default-theme').value = state.defaultTheme;
  document.getElementById('strands-default-lang').value = state.defaultLang;
  renderWordList();
  renderGrid();
  renderPathsList();
  renderLetterCount();
  renderCollectionOptions(state.collectionId);
  document.getElementById('strands-submit-btn').textContent = t('editor.actions.update');
  // Match the Connections editor: after a successful load, show a "loaded"
  // result card so the user has a shareable link and a way to play.
  showResult({ kind: 'loaded', id, url: `/s/${id}` });
}

// ============== SUBMIT ==============

function buildPuzzle() {
  const puzzle = {
    type: 'strands',
    v: 1,
    title: state.title.trim() || undefined,
    theme: state.theme.trim(),
    lang: state.defaultLang || undefined,
    rows: state.rows,
    cols: state.cols,
    grid: state.grid.map((c) => c || ''),
    spangram: state.spangramPath ? { word: state.spangramWord, path: state.spangramPath } : null,
    words: state.words
      .filter((w) => w.word)
      .map((w) => ({ word: w.word, path: w.path })),
    collectionId: state.collectionId || undefined,
    defaultTheme: state.defaultTheme || undefined,
    defaultLang: state.defaultLang || undefined,
    createdAt: state.editingCreatedAt || new Date().toISOString(),
  };
  // Strip undefined so payload stays tight and matches Worker's shape checks.
  for (const k of Object.keys(puzzle)) if (puzzle[k] === undefined) delete puzzle[k];
  return puzzle;
}

async function onSubmit(e) {
  e.preventDefault();
  showError('');
  const puzzle = buildPuzzle();
  if (!puzzle.theme) { showError(t('strands.editor.err.themeRequired')); return; }
  if (!puzzle.spangram) { showError(t('strands.editor.err.spangramRequired')); return; }
  if (puzzle.words.length < WORD_MIN_COUNT) { showError(t('strands.editor.err.tooFewWords', { min: WORD_MIN_COUNT })); return; }
  if (puzzle.words.some((w) => !w.path)) { showError(t('strands.editor.err.wordPathMissing')); return; }
  const err = validatePuzzle(puzzle);
  if (err) { showError(err); return; }
  const submitBtn = document.getElementById('strands-submit-btn');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = t('editor.actions.submitting');
  try {
    let id, url;
    if (state.editingId) {
      await updatePuzzle('strands', state.editingId, puzzle, getPassword());
      id = state.editingId;
      url = `/s/${id}`;
      showResult({ kind: 'updated', id, url });
    } else {
      const res = await createPuzzle('strands', puzzle, getPassword());
      id = res.id;
      url = `/s/${id}`;
      state.editingId = id;
      showResult({ kind: 'created', id, url });
    }
  } catch (err) {
    // 401: cached password is stale or wrong. Match Connections editor —
    // wipe the cache and bounce to the gate.
    if (err.status === 401) {
      try { sessionStorage.removeItem(PASSWORD_KEY); } catch {}
      window.location.reload();
      return;
    }
    showError(err.message || t('editor.error.generic'));
  } finally {
    submitBtn.disabled = false;
    // Restore label on both success and failure so the button doesn't get
    // stuck reading "Saving…" after a successful submit.
    submitBtn.textContent = state.editingId ? t('editor.actions.update') : originalLabel;
  }
}

// Result card — uses the same class names as the Connections editor
// (.result-card / .result-url / .result-actions) so both games share styling.
function showResult({ kind, id, url }) {
  const slot = document.getElementById('strands-result-slot');
  if (!slot) return;
  const title = t(`editor.result.${kind}.title`);
  const body = kind === 'loaded'
    ? t('editor.result.loaded.body', { id })
    : t(`editor.result.${kind}.body`);
  const full = `${window.location.origin}${url}`;
  slot.innerHTML = `
    <div class="result-card">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
      <div class="result-url" id="strands-result-url-text">${escapeHtml(full)}</div>
      <div class="result-actions">
        <button type="button" class="btn btn-primary" id="strands-copy-btn">${escapeHtml(t('editor.result.copy'))}</button>
        <a class="btn" href="${escapeHtml(url)}">${escapeHtml(t('editor.result.playNow'))}</a>
      </div>
    </div>
  `;
  document.getElementById('strands-copy-btn').addEventListener('click', (e) => {
    copyWithFeedback(e.currentTarget, full, t('editor.result.copied'));
  });
  slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onReset() {
  Object.assign(state, {
    editingId: null, editingCreatedAt: null,
    title: '', theme: '', collectionId: '',
    rows: ROW_DEFAULT, cols: COL_DEFAULT,
    grid: Array(ROW_DEFAULT * COL_DEFAULT).fill(''),
    spangramWord: '', spangramPath: null,
    words: [], drawing: null,
    defaultTheme: '', defaultLang: '',
  });
  addWordRow(); addWordRow(); addWordRow();
  document.getElementById('strands-title').value = '';
  document.getElementById('strands-theme').value = '';
  document.getElementById('strands-spangram').value = '';
  document.getElementById('strands-rows').value = String(state.rows);
  document.getElementById('strands-cols').value = String(state.cols);
  document.getElementById('strands-default-theme').value = '';
  document.getElementById('strands-default-lang').value = '';
  document.getElementById('strands-result-slot').innerHTML = '';
  document.getElementById('strands-submit-btn').textContent = t('editor.actions.create');
  showError('');
  renderCollectionOptions('');
  renderGrid();
  renderPathsList();
  renderLetterCount();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Currently unused but kept to sanity-check module structure.
export function _isTouching(path, rows, cols) { return touchesOppositeEdges(path, rows, cols); }
