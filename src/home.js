import './styles/base.css';
import { initChrome } from './lib/chrome.js';
import { t } from './lib/i18n.js';

// Accept: 5-char short id, "/c/abc12", "/s/abc12", or a full URL containing either.
// Returns { type, id } or null.
function parseInput(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  // Direct short id — assume connections (only game shipped in v1)
  if (/^[A-Za-z0-9]{5}$/.test(s)) return { type: 'connections', id: s };
  // URL or path — look for /c/xxxxx or /s/xxxxx
  const match = s.match(/\/(c|s)\/([A-Za-z0-9]{5})(?:[/?#]|$)/);
  if (match) {
    const type = match[1] === 'c' ? 'connections' : 'strands';
    return { type, id: match[2] };
  }
  return null;
}

function onSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('puzzle-input');
  const err = document.getElementById('puzzle-error');
  const parsed = parseInput(input.value);
  if (!parsed) {
    err.textContent = t('home.input.invalid');
    err.hidden = false;
    return;
  }
  err.hidden = true;
  const prefix = parsed.type === 'connections' ? '/c/' : '/s/';
  window.location.href = `${prefix}${parsed.id}`;
}

initChrome();
document.getElementById('play-form').addEventListener('submit', onSubmit);
