// Dict-based i18n. Every UI string comes through t(key).
// Language dicts live in src/i18n/{en,vi}.json.
//
// Interpolation: t('foo', { name: 'Linh' }) replaces {name} in the string.
// Missing keys fall back to the key itself in dev, so problems are visible.

import en from '../i18n/en.json';
import vi from '../i18n/vi.json';
import { getLang, setLang } from './storage.js';

const DICTS = { en, vi };
const DEFAULT_LANG = 'en';
const SUPPORTED = ['en', 'vi'];

let currentLang = null;

function detectInitialLang() {
  const stored = getLang();
  if (stored && SUPPORTED.includes(stored)) return stored;
  // Browser hint: if user's browser is Vietnamese, default to VI
  const nav = (navigator.language || '').toLowerCase();
  if (nav.startsWith('vi')) return 'vi';
  return DEFAULT_LANG;
}

export function initI18n() {
  currentLang = detectInitialLang();
  document.documentElement.setAttribute('lang', currentLang);
}

export function getCurrentLang() {
  return currentLang || DEFAULT_LANG;
}

export function switchLang(lang) {
  if (!SUPPORTED.includes(lang)) return;
  currentLang = lang;
  setLang(lang);
  document.documentElement.setAttribute('lang', lang);
  applyTranslations(document);
}

export function t(key, vars) {
  const dict = DICTS[currentLang] || DICTS[DEFAULT_LANG];
  let value = dict[key];
  if (value == null) value = DICTS[DEFAULT_LANG][key];
  if (value == null) return key; // visible fallback
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      value = value.replaceAll(`{${k}}`, v);
    }
  }
  return value;
}

// Walks the DOM and applies data-i18n attributes:
//   data-i18n="key"           → sets textContent
//   data-i18n-html="key"      → sets innerHTML (use only for trusted keys with markup)
//   data-i18n-attr="attr:key" → sets attr to translated value (e.g. "aria-label:home.title")
export function applyTranslations(root) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const spec = el.dataset.i18nAttr;
    // Support multiple: "aria-label:a.b, title:c.d"
    spec.split(',').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
  // Also update <title> if the root is document
  if (root === document) {
    const titleEl = document.querySelector('title[data-i18n]');
    if (titleEl) document.title = t(titleEl.dataset.i18n);
  }
}
