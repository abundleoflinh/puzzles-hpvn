// Shared page chrome: wordmark + nav (About, Create, theme toggle, lang toggle),
// footer credit, info modal. Each page calls initChrome() after DOM is ready.

import { initTheme, cycleTheme, getActiveTheme } from './theme.js';
import { initI18n, switchLang, getCurrentLang, t, applyTranslations } from './i18n.js';

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

function renderFooter() {
  const el = document.querySelector('[data-slot="footer"]');
  if (!el) return;
  el.innerHTML = `
    <p class="footer-credit">
      <span data-i18n="footer.credit"></span>
      <span class="credit-name">thu_nguyen_209</span>
    </p>
  `;
}

function renderInfoModal() {
  if (document.getElementById('info-modal')) return;
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
        <section>
          <h3 data-i18n="info.connections.heading"></h3>
          <div data-i18n-html="info.connections.body"></div>
        </section>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-action="close-info"]')) closeInfo();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hasAttribute('hidden')) closeInfo();
  });
}

function openInfo() {
  const modal = document.getElementById('info-modal');
  if (!modal) return;
  modal.removeAttribute('hidden');
  modal.querySelector('.icon-btn[data-action="close-info"]').focus();
}
function closeInfo() {
  const modal = document.getElementById('info-modal');
  if (!modal) return;
  modal.setAttribute('hidden', '');
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
      updateThemeButton();
      updateLangButton();
    } else if (action === 'info') {
      e.preventDefault();
      openInfo();
    }
  });
}

export function initChrome({ puzzleDefaultTheme } = {}) {
  initTheme(puzzleDefaultTheme);
  initI18n();
  renderHeader();
  renderFooter();
  renderInfoModal();
  applyTranslations(document);
  wireActions();
}
