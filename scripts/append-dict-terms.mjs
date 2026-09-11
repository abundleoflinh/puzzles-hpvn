// scripts/append-dict-terms.mjs
//
// Append top-N canonical categories from data/frequency.csv into
// data/csv/dict_terms.csv, WITHOUT touching any existing row.
//
// Motivation: dict_terms.csv was originally seeded from the top 500 of
// frequency.csv. After a catalog rebuild (Fantastic Beasts / theme-park /
// companion-book entities now flagged non-canon via source_bucket), the
// canon-filtered frequency reshuffles — some genuinely book-canon tags
// bubble into the top 500 that weren't there before. This script surfaces
// them for Linh to translate, without disturbing the hand-typed VI already
// in the file.
//
// Guarantees:
//   - Every existing row is preserved byte-for-byte (append-only).
//   - A new candidate is skipped if its `en` matches (case-insensitive) any
//     existing row's `en` or any of its `aliases_en` (split on `;`).
//   - New rows are marked needs_review=TRUE with a notes marker so they're
//     easy to find and triage.
//
// CLI flags:
//   --top=N       how many rows from frequency.csv to consider (default 500)
//   --dry-run     print what would be added without modifying the file
//
// Run order (after a catalog cleanup):
//   npm run cf:catalog
//   npm run cf:frequency
//   npm run cf:dict-append

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FREQ_PATH = resolve(REPO_ROOT, 'data', 'frequency.csv');
const DICT_PATH = resolve(REPO_ROOT, 'data', 'csv', 'dict_terms.csv');

const NOTES_MARKER = 'AUTO-APPENDED: post-canon-cleanup top-500 refresh';

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v === undefined ? true : v;
  }
  return out;
}

// Minimal RFC-4180-ish CSV row parser. Handles quoted fields, embedded
// commas, and escaped double-quotes (""). Sufficient for our files — no
// embedded newlines inside quoted fields in dict_terms.csv or frequency.csv.
function parseCsvRow(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"' && cur === '') { inQ = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

// Quote a field for CSV output only if it contains a comma, quote, or newline.
function csvField(s) {
  const str = String(s ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

async function main() {
  const args = parseArgs(process.argv);
  const topN = args.top != null ? parseInt(args.top, 10) : 500;
  const dryRun = !!args['dry-run'];

  // Read raw dict text so we can preserve trailing newline / row ordering.
  const dictText = await readFile(DICT_PATH, 'utf8');
  const dictLines = dictText.split(/\r?\n/);
  // Trim a trailing empty line so we append cleanly (re-added at write).
  const trailingBlank = dictLines[dictLines.length - 1] === '';
  const effectiveLines = trailingBlank ? dictLines.slice(0, -1) : dictLines;
  const header = effectiveLines[0];
  const headerCols = parseCsvRow(header);
  // Current schema: en,vi,aliases_en,notes,needs_review. Header-driven so
  // adding/dropping optional columns later doesn't break this script.
  const enIdx = headerCols.indexOf('en');
  const aliasEnIdx = headerCols.indexOf('aliases_en');
  const notesIdx = headerCols.indexOf('notes');
  const needsReviewIdx = headerCols.indexOf('needs_review');
  if (enIdx === -1 || aliasEnIdx === -1) {
    throw new Error(`dict_terms.csv header missing 'en' or 'aliases_en' columns: ${header}`);
  }

  // Build case-insensitive lookup of every en + aliases_en term already present.
  const existing = new Set();
  const addTerm = (s) => { if (s) existing.add(s.trim().toLowerCase()); };
  for (let i = 1; i < effectiveLines.length; i++) {
    const line = effectiveLines[i];
    if (!line) continue;
    const cols = parseCsvRow(line);
    addTerm(cols[enIdx]);
    const aliases = (cols[aliasEnIdx] || '').split(';');
    for (const a of aliases) addTerm(a);
  }

  // Read frequency.csv top-N. Format: count,category — one header line.
  const freqText = await readFile(FREQ_PATH, 'utf8');
  const freqLines = freqText.split(/\r?\n/).filter(Boolean);
  // Skip header
  const dataRows = freqLines.slice(1).slice(0, topN);

  const toAppend = [];
  let alreadyPresent = 0;
  for (const line of dataRows) {
    const cols = parseCsvRow(line);
    const category = (cols[1] || '').trim();
    if (!category) continue;
    if (existing.has(category.toLowerCase())) { alreadyPresent++; continue; }
    toAppend.push(category);
  }

  console.log(`dict_terms.csv: ${effectiveLines.length - 1} existing rows`);
  console.log(`frequency.csv top-${topN}: ${dataRows.length} candidates`);
  console.log(`  already present (as en or alias): ${alreadyPresent}`);
  console.log(`  new rows to append: ${toAppend.length}`);

  if (!toAppend.length) {
    console.log('nothing to append.');
    return;
  }

  // Build appended rows in HEADER ORDER so schema changes (e.g. dropping
  // aliases_vi) don't break the writer. Fill: en, notes=marker,
  // needs_review=TRUE. Every other column blank.
  const appended = toAppend.map((cat) => {
    const row = headerCols.map(() => '');
    row[enIdx] = csvField(cat);
    if (notesIdx !== -1) row[notesIdx] = csvField(NOTES_MARKER);
    if (needsReviewIdx !== -1) row[needsReviewIdx] = 'TRUE';
    return row.join(',');
  });

  if (dryRun) {
    console.log('\n--dry-run: not writing. First 20 new rows:');
    for (const l of appended.slice(0, 20)) console.log('  ' + l);
    return;
  }

  const newContent = effectiveLines.concat(appended).join('\n') + '\n';
  await writeFile(DICT_PATH, newContent, 'utf8');
  console.log(`\nwrote ${toAppend.length} new rows → ${DICT_PATH}`);
  console.log(`marker for grep: ${NOTES_MARKER}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
