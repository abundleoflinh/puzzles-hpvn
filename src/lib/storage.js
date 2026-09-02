// localStorage wrappers. Everything is namespaced under `hpvn.` so we never
// collide with anything else the browser might store on this origin.

const PREFIX = 'hpvn.';

function safeGet(key) {
  try { return localStorage.getItem(PREFIX + key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(PREFIX + key, value); } catch {}
}
function safeRemove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch {}
}

// --- Preferences (theme + language) ---

export function getTheme() {
  return safeGet('theme'); // 'light' | 'dark' | 'hpvn' | null (= auto/default)
}
export function setTheme(theme) {
  if (theme) safeSet('theme', theme); else safeRemove('theme');
}

export function getLang() {
  return safeGet('lang'); // 'en' | 'vi' | null
}
export function setLang(lang) {
  if (lang) safeSet('lang', lang); else safeRemove('lang');
}

// --- Per-puzzle progress ---
// Progress is stored as a JSON blob per puzzle id. Shape is game-specific;
// this lib just persists whatever the game module hands it.

export function getProgress(type, id) {
  const raw = safeGet(`progress.${type}.${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export function setProgress(type, id, state) {
  safeSet(`progress.${type}.${id}`, JSON.stringify(state));
}
export function clearProgress(type, id) {
  safeRemove(`progress.${type}.${id}`);
}
