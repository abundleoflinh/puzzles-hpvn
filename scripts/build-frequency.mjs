// scripts/build-frequency.mjs
//
// Read data/scrape-raw.json → count every unique category string across all entities
// → write data/frequency.csv sorted by descending count. Used to seed
// data/csv/dict_terms.csv (top ~200 rows go in for the initial VI translation pass).
//
// Also emits a companion `frequency_templates.csv` — same list filtered/formatted to
// surface likely template-shaped categories (e.g. "* participants", "Members of *").
// Editor uses these to seed dict_templates.csv patterns.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RAW_PATH = resolve(REPO_ROOT, 'data', 'scrape-raw.json');
const FREQ_PATH = resolve(REPO_ROOT, 'data', 'frequency.csv');
const TEMPLATE_HINTS_PATH = resolve(REPO_ROOT, 'data', 'frequency_templates.csv');

// Heuristics for spotting likely template shapes. Not exhaustive — just enough to
// give the editor a starting list of common patterns.
const TEMPLATE_PATTERNS = [
  /^Members of (.+)$/i,
  /^(.+) members$/i,
  /^(.+) participants$/i,
  /^People affected by (.+)$/i,
  /^(.+) students$/i,
  /^(.+) staff$/i,
  /^(.+) residents$/i,
  /^Individuals (?:with|who) (.+)$/i,
];

// Minimal CSV escape — quote fields that contain quotes, commas, or newlines.
function csvField(s) {
  const str = String(s ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

async function main() {
  const raw = JSON.parse(await readFile(RAW_PATH, 'utf8'));
  const counts = new Map(); // category -> count

  for (const title of Object.keys(raw)) {
    const cats = raw[title]?.categories || [];
    for (const c of cats) counts.set(c, (counts.get(c) || 0) + 1);
  }

  // Sort by count desc, then category asc for stable output.
  const rows = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

  // frequency.csv: all categories, seed for dict_terms.csv
  const freqLines = ['count,category'];
  for (const [cat, n] of rows) freqLines.push(`${n},${csvField(cat)}`);
  await writeFile(FREQ_PATH, freqLines.join('\n') + '\n', 'utf8');

  // frequency_templates.csv: filter to likely template shapes, echo the matched
  // template with the slot substituted for the raw category name.
  const templateLines = ['count,category,likely_pattern,slot_value'];
  for (const [cat, n] of rows) {
    for (const pattern of TEMPLATE_PATTERNS) {
      const m = cat.match(pattern);
      if (!m) continue;
      // Build a display pattern by re-substituting {X} for the captured group.
      const displayPattern = cat.replace(m[1], '{X}');
      templateLines.push(`${n},${csvField(cat)},${csvField(displayPattern)},${csvField(m[1])}`);
      break; // first pattern wins
    }
  }
  await writeFile(TEMPLATE_HINTS_PATH, templateLines.join('\n') + '\n', 'utf8');

  console.log(`wrote ${rows.length} unique categories → ${FREQ_PATH}`);
  console.log(`wrote ${templateLines.length - 1} template hints → ${TEMPLATE_HINTS_PATH}`);
  console.log(`\ntop 10 categories:`);
  for (const [cat, n] of rows.slice(0, 10)) console.log(`  ${String(n).padStart(4)}  ${cat}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
