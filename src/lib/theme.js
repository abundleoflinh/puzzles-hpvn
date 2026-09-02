// Theme system: three themes ('light', 'dark', 'hpvn'). Applied by setting
// data-theme on <html>, which flips CSS variables defined in styles/base.css.
//
// Priority for initial theme:
//   1. Puzzle-level default theme (only on /play if the puzzle sets one)
//   2. User's saved preference
//   3. System dark-mode preference
//   4. 'light'
//
// The puzzle-level default is applied on the play page, but the user's
// theme toggle overrides it and persists.

import { getTheme, setTheme } from './storage.js';

const THEMES = ['light', 'dark', 'hpvn'];

export function detectInitialTheme(puzzleDefault) {
  const stored = getTheme();
  if (stored && THEMES.includes(stored)) return stored;
  if (puzzleDefault && THEMES.includes(puzzleDefault)) return puzzleDefault;
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

export function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = 'light';
  document.documentElement.setAttribute('data-theme', theme);
}

export function initTheme(puzzleDefault) {
  applyTheme(detectInitialTheme(puzzleDefault));
}

export function switchTheme(theme) {
  if (!THEMES.includes(theme)) return;
  applyTheme(theme);
  setTheme(theme);
}

export function getActiveTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}

export function cycleTheme() {
  const current = getActiveTheme();
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  switchTheme(next);
  return next;
}
