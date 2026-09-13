// Shared page chrome: wordmark + nav (About, Create, theme toggle, lang toggle),
// footer credit, info modal. Each page calls initChrome() after DOM is ready.

import { initTheme, cycleTheme, getActiveTheme } from './theme.js';
import { initI18n, switchLang, getCurrentLang, t, applyTranslations } from './i18n.js';
import { escapeHtml } from './util.js';

function themeLabel(theme) {
  return t(`theme.${theme}`);
}

// Icon per theme — small text glyphs rather than emoji, feels less "AI defaults"
function themeIcon(theme) {
  if (theme === 'light') return '☀';
  if (theme === 'dark') return '☾';
  return '✦'; // hpvn
}

function renderHeader() {
  const el = document.querySelector('[data-slot="header"]');
  if (!el) return;
  el.innerHTML = `
    <div class="header-inner">
      <a href="/" class="brand">Puzzles</a>
      <nav class="header-actions" aria-label="Primary">
        <a href="#" class="nav-link" data-action="info" data-i18n="nav.about"></a>
        <a href="/editor.html" class="nav-cta" data-i18n="nav.create"></a>
        <button type="button" class="icon-btn" data-action="theme"></button>
        <button type="button" class="icon-btn lang-btn" data-action="lang"></button>
      </nav>
    </div>
  `;
  updateThemeButton();
  updateLangButton();
}

// Footer credit is game-aware. Each game contributes its own credit lines;
// a page tells us which game(s) it is via initChrome({ games }). Play pages
// pass a single game; home/editor pass none, so we credit all known games.
// Only Connections and Strands descend from NYT; Catfishing is inspired by
// catfishing.net and draws its clue categories from the Harry Potter Wiki.
// Vietnamese instructions (by thu_nguyen_209) exist only for Connections and
// Strands, so that line is suppressed on Catfishing.
const FOOTER_CREDITS = {
  connections: {
    inspired: { url: 'https://www.nytimes.com/games/connections', linkKey: 'footer.credit.link.connections' },
    viInstructions: true,
  },
  strands: {
    inspired: { url: 'https://www.nytimes.com/games/strands', linkKey: 'footer.credit.link.strands' },
    viInstructions: true,
  },
  catfishing: {
    inspired: { url: 'https://catfishing.net', linkKey: 'footer.credit.link.catfishing' },
    wiki: true,
  },
};

// Generic NYT link used when more than one NYT game is in scope (home/editor),
// so we don't stack two near-identical "inspired by" lines.
const GENERIC_NYT = { url: 'https://www.nytimes.com/games', linkKey: 'footer.credit.link.nyt' };
const WIKI_URL = 'https://harrypotter.fandom.com';

// Resolve the games in scope: the page's list, or all known games as a fallback
// for pages (home, editor) that don't name one.
function footerScope(games) {
  return Array.isArray(games) && games.length
    ? games.filter((g) => FOOTER_CREDITS[g])
    : Object.keys(FOOTER_CREDITS);
}

// The credit lines interpolate a link into the translated string, so they can't
// use plain data-i18n. Rebuild from scratch on first render and on language flip.
function renderFooter(games) {
  const el = document.querySelector('[data-slot="footer"]');
  if (!el) return;
  const scope = footerScope(games);
  const lines = [];

  // "Inspired by" lines. NYT games collapse to one generic link when several
  // are in scope; a single NYT game links to its own page.
  const nytGames = scope.filter((g) => g !== 'catfishing');
  if (nytGames.length === 1) {
    const c = FOOTER_CREDITS[nytGames[0]].inspired;
    lines.push(creditLine('footer.credit.inspired', c.url, c.linkKey));
  } else if (nytGames.length > 1) {
    lines.push(creditLine('footer.credit.inspired', GENERIC_NYT.url, GENERIC_NYT.linkKey));
  }
  if (scope.includes('catfishing')) {
    const c = FOOTER_CREDITS.catfishing.inspired;
    lines.push(creditLine('footer.credit.inspired', c.url, c.linkKey));
  }

  // Harry Potter Wiki data-source credit (Catfishing only).
  if (scope.some((g) => FOOTER_CREDITS[g].wiki)) {
    lines.push(creditLine('footer.credit.wiki', WIKI_URL, 'footer.credit.link.wiki'));
  }

  // Vietnamese-instructions credit (Connections + Strands only).
  if (scope.some((g) => FOOTER_CREDITS[g].viInstructions)) {
    lines.push(instructionsLine());
  }

  el.innerHTML = lines.map((html) => `<p class="footer-credit">${html}</p>`).join('');
}

// Interpolate a link into a translated {link} template, escaping the surrounding
// translation text (and the URL) so the result is always safe.
function creditLine(templateKey, url, linkKey) {
  const linkText = escapeHtml(t(linkKey));
  const link = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
  return t(templateKey).split('{link}').map(escapeHtml).join(link);
}

// Instructions credit: interpolate a styled (blue, bold) name span, no link.
function instructionsLine() {
  const name = '<span class="credit-name">thu_nguyen_209</span>';
  return t('footer.credit.instructions').split('{name}').map(escapeHtml).join(name);
}

// Focusable-element selector for the trap. Excludes disabled controls and
// elements explicitly opted out with tabindex="-1".
const FOCUSABLE_SEL = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Element to return focus to when the modal closes. Captured on open so we
// don't need to guess (usually the About link).
let lastFocusedBeforeModal = null;

// Which game sections to render inside the info modal, defaulting to both.
// Callers narrow this on game pages (e.g. play-strands passes ['strands']).
const KNOWN_GAMES = ['connections', 'strands', 'catfishing'];

function renderInfoModal(games) {
  if (document.getElementById('info-modal')) return;
  const which = Array.isArray(games) && games.length ? games : KNOWN_GAMES;
  const sections = which
    .filter((g) => KNOWN_GAMES.includes(g))
    .map((g) => `
      <section>
        <h3 data-i18n="info.${g}.heading"></h3>
        <div data-i18n-html="info.${g}.body"></div>
      </section>
    `).join('');
  const modal = document.createElement('div');
  modal.id = 'info-modal';
  modal.className = 'modal-backdrop';
  modal.setAttribute('hidden', '');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'info-modal-title');
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h2 id="info-modal-title" data-i18n="info.title"></h2>
        <button type="button" class="icon-btn" data-action="close-info" data-i18n-attr="aria-label:action.close">✕</button>
      </div>
      <div class="modal-body">
        ${sections}
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-action="close-info"]')) closeInfo();
  });
  document.addEventListener('keydown', (e) => {
    if (modal.hasAttribute('hidden')) return;
    if (e.key === 'Escape') { closeInfo(); return; }
    // Focus trap: Tab and Shift+Tab wrap within the modal.
    if (e.key === 'Tab') trapTab(modal, e);
  });
}

// Keep Tab / Shift+Tab focus movement inside the modal. Preserves natural
// keyboard behavior when there are multiple focusable elements, and clamps
// to the close button if there's only one.
function trapTab(modal, e) {
  const focusables = [...modal.querySelectorAll(FOCUSABLE_SEL)].filter(
    (el) => !el.hasAttribute('hidden') && el.offsetParent !== null
  );
  if (!focusables.length) { e.preventDefault(); return; }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !modal.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !modal.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

function openInfo() {
  const modal = document.getElementById('info-modal');
  if (!modal) return;
  lastFocusedBeforeModal = document.activeElement;
  // Hide the rest of the page from AT + pointer while the modal is up.
  // `inert` is broadly supported in modern browsers; the aria-hidden
  // fallback catches older ones. Excludes the modal itself.
  document.querySelectorAll('body > :not(#info-modal)').forEach((el) => {
    el.setAttribute('inert', '');
    el.setAttribute('aria-hidden', 'true');
  });
  modal.removeAttribute('hidden');
  modal.querySelector('.icon-btn[data-action="close-info"]').focus();
}
function closeInfo() {
  const modal = document.getElementById('info-modal');
  if (!modal) return;
  modal.setAttribute('hidden', '');
  document.querySelectorAll('body > :not(#info-modal)').forEach((el) => {
    el.removeAttribute('inert');
    el.removeAttribute('aria-hidden');
  });
  // Restore focus to whatever the user was on before the modal opened.
  if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

function updateThemeButton() {
  const btn = document.querySelector('[data-action="theme"]');
  if (!btn) return;
  const theme = getActiveTheme();
  btn.textContent = themeIcon(theme);
  const label = t('action.theme.cycle', { theme: themeLabel(theme) });
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
}

function updateLangButton() {
  const btn = document.querySelector('[data-action="lang"]');
  if (!btn) return;
  const lang = getCurrentLang();
  btn.textContent = lang === 'en' ? 'EN' : 'VI';
  const label = t('action.lang.switch');
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
}

function wireActions() {
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'theme') {
      cycleTheme();
      updateThemeButton();
      document.dispatchEvent(new CustomEvent('theme-changed'));
    } else if (action === 'lang') {
      switchLang(getCurrentLang() === 'en' ? 'vi' : 'en');
    } else if (action === 'info') {
      e.preventDefault();
      openInfo();
    }
  });
}

export function initChrome({ puzzleDefaultTheme, games } = {}) {
  initTheme(puzzleDefaultTheme);
  initI18n();
  renderHeader();
  renderFooter(games);
  renderInfoModal(games);
  applyTranslations(document);
  wireActions();

  // Keep chrome-owned dynamic content in sync when the language flips.
  window.addEventListener('lang-changed', () => {
    updateThemeButton();
    updateLangButton();
    renderFooter(games);
  });
}
