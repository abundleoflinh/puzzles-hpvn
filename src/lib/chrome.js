// Shared page chrome: theme + language toggles, info modal, footer credit.
// Each page calls initChrome() after DOM is ready.

import { initTheme, cycleTheme, getActiveTheme } from './theme.js';
import { initI18n, switchLang, getCurrentLang, t, applyTranslations } from './i18n.js';

function themeLabel(theme) {
  return t(`theme.${theme}`);
}

function renderHeader() {
  const el = document.querySelector('[data-slot="header"]');
  if (!el) return;
  el.innerHTML = `
    <div class="header-inner">
      <a href="/" class="brand" data-i18n="site.title"></a>
      <div class="header-actions">
        <button type="button" class="icon-btn" data-action="info" data-i18n-attr="aria-label:action.info, title:action.info">ⓘ</button>
        <button type="button" class="icon-btn" data-action="theme"></button>
        <button type="button" class="icon-btn lang-btn" data-action="lang"></button>
      </div>
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
  // Only inject once
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
  const icon = theme === 'light' ? '☀︎' : theme === 'dark' ? '☾' : '⚯';
  btn.textContent = icon;
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
    } else if (action === 'lang') {
      switchLang(getCurrentLang() === 'en' ? 'vi' : 'en');
      updateThemeButton(); // theme button label uses translated theme name
      updateLangButton();
    } else if (action === 'info') {
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
