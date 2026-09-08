// scripts/show-easy.mjs
//
// Diagnostic. Prints all entities suggested_difficulty === 'easy', then the
// borderline pool at 0.60 <= score < 0.75 so we can see who's being kept out
// of easy and why.
//
// Usage: node scripts/show-easy.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG = resolve(__dirname, '..', 'data', 'catalog.json');

const cat = JSON.parse(await readFile(CATALOG, 'utf8'));
const all = Object.values(cat);

const easy = all
  .filter((e) => e.suggested_difficulty === 'easy')
  .sort((a, b) => (b.prominence_score - a.prominence_score)
                  || a.entity_type.localeCompare(b.entity_type)
                  || a.canonical_en.localeCompare(b.canonical_en));

console.log(`=== ${easy.length} easy entities ===`);
for (const e of easy) {
  console.log(`  ${e.prominence_score.toFixed(2)}  ${e.entity_type.padEnd(9)}  ${e.canonical_en}  (${e.raw_categories.length} cats, ${e.aliases_en.length} aliases)`);
}

const near = all
  .filter((e) => e.prominence_score >= 0.60 && e.prominence_score < 0.75)
  .sort((a, b) => b.prominence_score - a.prominence_score)
  .slice(0, 60);

console.log(`\n=== top 60 near-miss (0.60 <= score < 0.75) ===`);
for (const e of near) {
  console.log(`  ${e.prominence_score.toFixed(2)}  ${e.entity_type.padEnd(9)}  ${e.canonical_en}  (${e.raw_categories.length} cats, ${e.aliases_en.length} aliases)`);
}
