// scripts/build-dicts.mjs
//
// Step 3 of the Catfishing content pipeline. Convert the hand-edited
// translation CSVs into the JSON the author-time resolver consumes:
//
//   data/csv/dict_terms.csv      -> data/dict_terms.json
//   data/csv/dict_templates.csv  -> data/dict_templates.json
//
// The resolver (worker/src/lib/dict-resolver.js, not yet built) turns a raw
// EN Fandom category into its VI display string:
//   1. direct hit on a term (en or an alias_en) -> that term's vi
//   2. template match -> extract the {X} slot, resolve the slot as a term,
//      substitute into pattern_vi
// So the JSON is shaped for lookup: terms are keyed by NORMALIZED en, aliases
// point back to their canonical key, and templates keep authoring order.
//
// Validation (warn-and-continue unless noted):
//   - dict_terms: skip rows with empty vi (a term with no translation is
//     useless to the resolver); warn on duplicate en (case-insensitive,
//     first row wins); warn on alias collisions.
//   - dict_templates: pattern_en/pattern_vi must both be present and each must
//     contain exactly one {X} slot, else the row is skipped with a warning;
//     case-insensitive duplicate patterns collapse to the first.
//   - `notes` and `needs_review` columns are IGNORED by design (human triage
//     aids only, per build plan §5 / confirmed with Linh). needs_review=TRUE
//     rows are still emitted.
//
// Deterministic and idempotent: same CSVs in -> same JSON out. Pages-only
// change (no Worker), so no deploy-order concern.
//
// Run: npm run cf:dicts

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TERMS_CSV = resolve(REPO_ROOT, 'data', 'csv', 'dict_terms.csv');
const TEMPLATES_CSV = resolve(REPO_ROOT, 'data', 'csv', 'dict_templates.csv');
const TERMS_JSON = resolve(REPO_ROOT, 'data', 'dict_terms.json');
const TEMPLATES_JSON = resolve(REPO_ROOT, 'data', 'dict_templates.json');

const ALIAS_SEP = ';'; // inner separator for aliases_en (comma is the CSV delimiter)

// --- CSV helpers (same shape as append-dict-terms.mjs, kept in sync) ---------

// Minimal RFC-4180-ish row parser. Handles quoted fields, embedded commas, and
// escaped double-quotes (""). No embedded newlines inside quoted fields in
// these files.
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

// Split a CSV file into header + data rows. Strips a UTF-8 BOM, tolerates
// CRLF, and drops fully-blank lines.
function readCsv(text) {
  const stripped = text.replace(/^﻿/, '');
  const lines = stripped.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = parseCsvRow(lines[0]);
  const rows = lines.slice(1).map(parseCsvRow);
  return { header, rows };
}

// Normalization used ONLY as the lookup key: trim + lowercase. Diacritic /
// unidecode normalization is the resolver+matcher's job at runtime; the
// dictionary keys stay faithful to the EN source so nothing is silently
// merged here.
function normKey(s) {
  return String(s ?? '').trim().toLowerCase();
}

function colIndex(header, name, { required = true } = {}) {
  const i = header.indexOf(name);
  if (i === -1 && required) {
    throw new Error(`expected column "${name}" in header: ${header.join(',')}`);
  }
  return i;
}

// --- terms -------------------------------------------------------------------

function buildTerms(text) {
  const { header, rows } = readCsv(text);
  const enIdx = colIndex(header, 'en');
  const viIdx = colIndex(header, 'vi');
  const aliasIdx = colIndex(header, 'aliases_en', { required: false });

  const terms = {};   // normKey(en) -> { en, vi, aliases_en: [...] }
  const aliases = {};  // normKey(alias) -> canonical normKey(en)
  const warnings = [];
  let emptyVi = 0;
  let dupEn = 0;
  let aliasCount = 0;
  let aliasCollisions = 0;

  for (let r = 0; r < rows.length; r++) {
    const cols = rows[r];
    const lineNo = r + 2; // 1-based, +1 for header
    const en = (cols[enIdx] ?? '').trim();
    const vi = (cols[viIdx] ?? '').trim();
    if (!en) continue; // structurally blank row

    if (!vi) {
      emptyVi++;
      warnings.push(`line ${lineNo}: empty vi for "${en}" — row skipped`);
      continue;
    }

    const key = normKey(en);
    if (terms[key]) {
      dupEn++;
      warnings.push(`line ${lineNo}: duplicate en "${en}" — keeping first ("${terms[key].vi}"), ignoring "${vi}"`);
      continue;
    }

    const aliasList = aliasIdx === -1
      ? []
      : String(cols[aliasIdx] ?? '')
          .split(ALIAS_SEP)
          .map((a) => a.trim())
          .filter(Boolean);

    terms[key] = { en, vi, aliases_en: aliasList };
  }

  // Second pass for aliases so a term's canonical key always wins over an
  // alias that happens to collide with it.
  for (const key of Object.keys(terms)) {
    for (const alias of terms[key].aliases_en) {
      const ak = normKey(alias);
      if (terms[ak]) {
        aliasCollisions++;
        warnings.push(`alias "${alias}" (of "${terms[key].en}") collides with canonical term — canonical kept`);
        continue;
      }
      if (aliases[ak] && aliases[ak] !== key) {
        aliasCollisions++;
        warnings.push(`alias "${alias}" maps to both "${terms[aliases[ak]].en}" and "${terms[key].en}" — keeping first`);
        continue;
      }
      aliases[ak] = key;
      aliasCount++;
    }
  }

  return {
    payload: {
      meta: {
        generated_by: 'scripts/build-dicts.mjs',
        source: 'data/csv/dict_terms.csv',
        term_count: Object.keys(terms).length,
        alias_count: aliasCount,
      },
      terms,
      aliases,
    },
    stats: { total: rows.length, kept: Object.keys(terms).length, emptyVi, dupEn, aliasCount, aliasCollisions },
    warnings,
  };
}

// --- templates ---------------------------------------------------------------

const SLOT_RE = /\{X\}/g;

function countSlots(s) {
  const m = String(s).match(SLOT_RE);
  return m ? m.length : 0;
}

function buildTemplates(text) {
  const { header, rows } = readCsv(text);
  const enIdx = colIndex(header, 'pattern_en');
  const viIdx = colIndex(header, 'pattern_vi');

  const templates = [];
  const seen = new Set(); // normKey(pattern_en) -> collapse case-variant dupes
  const warnings = [];
  let badSlots = 0;
  let dup = 0;

  for (let r = 0; r < rows.length; r++) {
    const cols = rows[r];
    const lineNo = r + 2;
    const patternEn = (cols[enIdx] ?? '').trim();
    const patternVi = (cols[viIdx] ?? '').trim();
    if (!patternEn && !patternVi) continue;

    if (!patternEn || !patternVi) {
      badSlots++;
      warnings.push(`line ${lineNo}: template missing ${!patternEn ? 'pattern_en' : 'pattern_vi'} — row skipped`);
      continue;
    }
    // Exactly one {X} on each side keeps slot substitution unambiguous.
    if (countSlots(patternEn) !== 1 || countSlots(patternVi) !== 1) {
      badSlots++;
      warnings.push(`line ${lineNo}: "${patternEn}" -> "${patternVi}" must have exactly one {X} on each side — row skipped`);
      continue;
    }

    const key = normKey(patternEn);
    if (seen.has(key)) {
      dup++;
      warnings.push(`line ${lineNo}: duplicate pattern "${patternEn}" (case-insensitive) — keeping first`);
      continue;
    }
    seen.add(key);
    templates.push({ pattern_en: patternEn, pattern_vi: patternVi });
  }

  return {
    payload: {
      meta: {
        generated_by: 'scripts/build-dicts.mjs',
        source: 'data/csv/dict_templates.csv',
        template_count: templates.length,
      },
      templates,
    },
    stats: { total: rows.length, kept: templates.length, badSlots, dup },
    warnings,
  };
}

// --- main --------------------------------------------------------------------

function printWarnings(label, warnings, limit = 40) {
  if (!warnings.length) return;
  console.log(`\n${label} warnings (${warnings.length}):`);
  for (const w of warnings.slice(0, limit)) console.log(`  - ${w}`);
  if (warnings.length > limit) console.log(`  ...and ${warnings.length - limit} more`);
}

async function main() {
  const termsText = await readFile(TERMS_CSV, 'utf8');
  const templatesText = await readFile(TEMPLATES_CSV, 'utf8');

  const termsOut = buildTerms(termsText);
  const templatesOut = buildTemplates(templatesText);

  // Stable, pretty JSON so diffs stay readable in git.
  await writeFile(TERMS_JSON, JSON.stringify(termsOut.payload, null, 2) + '\n', 'utf8');
  await writeFile(TEMPLATES_JSON, JSON.stringify(templatesOut.payload, null, 2) + '\n', 'utf8');

  const t = termsOut.stats;
  const p = templatesOut.stats;
  console.log('dict_terms.csv:');
  console.log(`  ${t.total} data rows -> ${t.kept} terms, ${t.aliasCount} aliases`);
  console.log(`  skipped (empty vi): ${t.emptyVi}, duplicate en: ${t.dupEn}, alias collisions: ${t.aliasCollisions}`);
  console.log(`  -> ${TERMS_JSON}`);
  console.log('dict_templates.csv:');
  console.log(`  ${p.total} data rows -> ${p.kept} templates`);
  console.log(`  skipped (bad/empty slot): ${p.badSlots}, case-insensitive dupes collapsed: ${p.dup}`);
  console.log(`  -> ${TEMPLATES_JSON}`);

  printWarnings('dict_terms', termsOut.warnings);
  printWarnings('dict_templates', templatesOut.warnings);
}

main().catch((err) => { console.error(err); process.exit(1); });
