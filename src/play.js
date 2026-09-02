import './styles/base.css';
import { initChrome } from './lib/chrome.js';

// v1 stub — Phase 3 replaces this with the real game.
// Reads #c/:id or #s/:id from URL hash so we know what to load.
function parseUrl() {
  const m = window.location.hash.match(/^#(c|s)\/([A-Za-z0-9]{5})$/);
  if (!m) return null;
  return { type: m[1] === 'c' ? 'connections' : 'strands', id: m[2] };
}

const parsed = parseUrl();
initChrome();

const el = document.getElementById('play-slot');
if (parsed) {
  el.textContent = `[Phase 3 will render the ${parsed.type} game for id: ${parsed.id}]`;
} else {
  el.textContent = 'Invalid puzzle URL.';
}
