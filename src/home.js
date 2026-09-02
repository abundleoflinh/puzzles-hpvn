import './styles/base.css';
import { initChrome } from './lib/chrome.js';
import { t } from './lib/i18n.js';

// Accept: 5-char short id, "/c/abc12", "/s/abc12", "#c/abc12", or a full URL.
function parseInput(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  if (/^[A-Za-z0-9]{5}$/.test(s)) return { type: 'connections', id: s };
  const match = s.match(/[/#](c|s)\/([A-Za-z0-9]{5})(?:[/?#&]|$)/);
  if (match) return { type: match[1] === 'c' ? 'connections' : 'strands', id: match[2] };
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
  window.location.href = `/play.html#${parsed.type === 'connections' ? 'c' : 's'}/${parsed.id}`;
}

initChrome();
document.getElementById('play-form').addEventListener('submit', onSubmit);
