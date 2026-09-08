// scripts/audit-catalog.mjs
//
// Diagnostic queries over data/catalog.json. Not part of the build; used to
// sanity-check difficulty calibration and min-categories filter tuning.
//
// Usage:
//   node scripts/audit-catalog.mjs                # default: 5 sample mixes + 20 hard samples
//   node scripts/audit-catalog.mjs --mixes=10 --hard=30
//   node scripts/audit-catalog.mjs --seed=42     # deterministic sampling
//
// To compare different --min-categories floors, rerun `npm run cf:catalog --
// --min-categories=N` first, then rerun this script.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CATALOG_PATH = resolve(REPO_ROOT, 'data', 'catalog.json');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v === undefined ? true : v;
  }
  return out;
}

// Deterministic PRNG (mulberry32) — reproducible sampling when --seed is set.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleN(arr, n, rng) {
  if (n >= arr.length) return [...arr];
  const idxs = new Set();
  while (idxs.size < n) idxs.add(Math.floor(rng() * arr.length));
  return [...idxs].map((i) => arr[i]);
}

async function main() {
  const args = parseArgs(process.argv);
  const mixCount = args.mixes ? parseInt(args.mixes, 10) : 5;
  const hardCount = args.hard ? parseInt(args.hard, 10) : 20;
  const seed = args.seed ? parseInt(args.seed, 10) : Date.now() & 0xffffffff;
  const rng = mulberry32(seed);

  const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));
  const entries = Object.values(catalog);
  const buckets = { easy: [], medium: [], hard: [] };
  for (const e of entries) buckets[e.suggested_difficulty].push(e);

  console.log(`catalog: ${entries.length} entities`);
  console.log(`  easy=${buckets.easy.length}  medium=${buckets.medium.length}  hard=${buckets.hard.length}`);
  console.log(`seed: ${seed}\n`);

  // 2:2:1 sample mixes
  console.log(`=== ${mixCount} sample 2:2:1 mixes (2 easy + 2 medium + 1 hard) ===`);
  for (let i = 0; i < mixCount; i++) {
    const e = sampleN(buckets.easy, 2, rng);
    const m = sampleN(buckets.medium, 2, rng);
    const h = sampleN(buckets.hard, 1, rng);
    console.log(`\n  mix ${i + 1}:`);
    for (const x of e) console.log(`    E  ${x.canonical_en.padEnd(35)} (${x.raw_categories.length} cats, p=${x.prominence_score})`);
    for (const x of m) console.log(`    M  ${x.canonical_en.padEnd(35)} (${x.raw_categories.length} cats, p=${x.prominence_score})`);
    for (const x of h) console.log(`    H  ${x.canonical_en.padEnd(35)} (${x.raw_categories.length} cats, p=${x.prominence_score})`);
  }

  // Hard-tier samples for min-categories tuning
  console.log(`\n\n=== ${hardCount} random samples from HARD bucket ===`);
  const hardSamples = sampleN(buckets.hard, hardCount, rng);
  // Sort by category count ascending so the puzzle-worthiness stratifies visually
  hardSamples.sort((a, b) => a.raw_categories.length - b.raw_categories.length);
  for (const x of hardSamples) {
    console.log(`  ${String(x.raw_categories.length).padStart(3)} cats  ${x.canonical_en.padEnd(40)}  [${x.entity_type}]`);
  }

  // Cutoff sensitivity — what would the mix look like at different easy/medium thresholds?
  console.log(`\n=== cutoff sensitivity (how many easy/medium at each threshold) ===`);
  const scores = entries.map((e) => e.prominence_score).sort((a, b) => b - a);
  const cutoffs = [0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60, 0.55, 0.50, 0.45, 0.40];
  console.log('  cutoff  count  max-puzzles(=count/2)');
  for (const c of cutoffs) {
    const n = scores.filter((s) => s >= c).length;
    console.log(`  ${c.toFixed(2)}    ${String(n).padStart(5)}  ${Math.floor(n / 2)}`);
  }

  // Category-count histogram inside hard bucket — decides whether stub floor is well placed
  console.log(`\n=== category-count histogram (hard bucket only) ===`);
  const hist = new Map();
  for (const x of buckets.hard) {
    const n = x.raw_categories.length;
    hist.set(n, (hist.get(n) || 0) + 1);
  }
  const sortedKeys = [...hist.keys()].sort((a, b) => a - b);
  for (const k of sortedKeys.slice(0, 20)) {
    const bar = '█'.repeat(Math.min(50, Math.round(hist.get(k) / 20)));
    console.log(`  ${String(k).padStart(3)} cats  ${String(hist.get(k)).padStart(5)}  ${bar}`);
  }
  if (sortedKeys.length > 20) console.log(`  ... (${sortedKeys.length - 20} more buckets above)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
