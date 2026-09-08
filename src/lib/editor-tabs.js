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

// Renders the strip into a caller-provided container. Optional `onSwitch`
// callback is invoked after the selection is persisted — pass the parent
// dispatcher here so the tab switch swaps in-place instead of reloading.
export function renderEditorTabs(container, onSwitch) {
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
      if (typeof onSwitch === 'function') onSwitch(next);
      else window.location.reload();
    });
  });
}
