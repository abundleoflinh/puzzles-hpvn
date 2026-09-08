// Shared editor tab strip. Rendered at the top of both game editors so the
// user can switch game type. Persists the selection to sessionStorage so a
// reload lands on the same tab.

import { t } from './i18n.js';
import { escapeHtml } from './util.js';

const TAB_KEY = 'hpvn.editor.tab';

export function getSelectedTab() {
  try { return sessionStorage.getItem(TAB_KEY) || 'connections'; } catch { return 'connections'; }
}
export function setSelectedTab(tab) {
  try { sessionStorage.setItem(TAB_KEY, tab); } catch {}
}

// Renders the strip into a caller-provided container. On click, persist the
// choice and reload so the parent shell re-dispatches to the right editor.
export function renderEditorTabs(container) {
  if (!container) return;
  const active = getSelectedTab();
  container.innerHTML = `
    <div class="editor-tabs" role="tablist" aria-label="Game type">
      <button type="button" role="tab" data-tab="connections" aria-selected="${active === 'connections'}" class="editor-tab ${active === 'connections' ? 'active' : ''}">${escapeHtml(t('home.collections.type.connections'))}</button>
      <button type="button" role="tab" data-tab="strands" aria-selected="${active === 'strands'}" class="editor-tab ${active === 'strands' ? 'active' : ''}">${escapeHtml(t('home.collections.type.strands'))}</button>
    </div>
  `;
  container.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.tab;
      if (next === getSelectedTab()) return;
      setSelectedTab(next);
      window.location.reload();
    });
  });
}
