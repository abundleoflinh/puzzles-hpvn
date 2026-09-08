// scripts/build-catalog.mjs
//
// Post-process data/scrape-raw.json → data/catalog.json.
// Deterministic and idempotent — safe to rerun on the same raw dump.
//
// Per entity, computes:
//   entity_type            — character | spell | item | location | creature | event
//                            (refined from the scraper's seed tag; see refineEntityType)
//   prominence_score       — 0..1 blend of category count, page length, alias count
//                            (weights 0.5 / 0.4 / 0.1), normalized against per-type p99
//   suggested_difficulty   — easy | medium | hard, from score cutoffs (defaults
//                            easy>=0.65 medium>=0.35, override with --easy=N --medium=N)
//
// The editor pre-fills the difficulty dropdown from suggested_difficulty; editor
// override wins at author time. This file is committed and read by the editor build,
// NOT loaded from KV at runtime.
//
// CLI flags:
//   --easy=N              easy-score cutoff (default 0.65)
//   --medium=N            medium-score cutoff (default 0.35)
//   --min-char=N          min categories for character type (default 8)
//   --min-nonchar=N       min categories for non-character types (default 2)
//   --include-spinoff     bypass exclude_spinoff.txt (auditing only)

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RAW_PATH = resolve(REPO_ROOT, 'data', 'scrape-raw.json');
const OUT_PATH = resolve(REPO_ROOT, 'data', 'catalog.json');
const EXCLUDE_PATH = resolve(REPO_ROOT, 'data', 'exclude_spinoff.txt');

// Type markers used to refine the seed tag. Kept narrow to categories that
// appear on true species / spell / object / location PAGES, not on named
// individuals. Anything that also lands on named individuals (Goblins,
// Werewolves, Ghosts, etc.) is intentionally excluded — NAMED_INDIVIDUAL_MARKERS
// keeps those people typed as character. Order matters: first matching type wins.
const TYPE_MARKER_CATEGORIES = [
  { type: 'spell',    markers: ['Charms', 'Curses', 'Jinxes', 'Hexes', 'Transfiguration spells', 'Counter-spells', 'Healing spells', 'Cleaning spells', 'Opening spells', 'Mental spells', 'Spells with a light', 'Spells of known incantation'] },
  { type: 'event',    markers: ['Skirmishes', 'Battles', 'Wars', 'Tournaments', 'Prophecies', 'Events', 'Attacks'] },
  { type: 'creature', markers: ['Beasts'] }, // species-page-only umbrella; race subcats are on individuals too, so excluded
  { type: 'item',     markers: ['Sentient objects', 'Wands', 'Broomsticks', 'Potions', 'Dark Magic artefacts', 'Protective objects', 'Portkeys', 'Deathly Hallows', 'Books', 'Chocolate Frog Cards'] },
  { type: 'location', markers: ['Buildings', 'Countries', 'Regions', 'Cities and towns', 'Rooms', 'Wizarding locations', 'Ministries of Magic', 'Hogwarts locations'] },
];

// Pottermore-only content markers — matched as case-insensitive substrings
// against every category on the entity. Kill on any hit. Complements the
// scraper's subcat-traversal block by catching entities that reach the pipeline
// through a different seed (e.g. an Ilvermorny student who's in Individuals
// too). Beauxbatons and Durmstrang are NOT here — they're in Goblet of Fire.
const POTTERMORE_MARKERS = [
  'ilvermorny',
  'uagadou',
  'mahoutokoro',
  'castelobruxo',
  'koldovstoretz',
  'no-maj',                       // Pottermore/FB-era term for Muggle in NA
  'statute of secrecy task force', // Hogwarts Mystery-era category
  'brilliant event',              // Hogwarts Mystery limited-time event pages
];

// Named-individual markers. If any of these appear on an entity, it's a
// specific person and stays typed 'character' regardless of what the seed
// tagged it or what type markers might match. Fixes the Category:Beings →
// Humans → Wizards sweep that mis-typed every named human wizard as creature.
const NAMED_INDIVIDUAL_MARKERS = new Set([
  'Males', 'Females', 'Individuals of unknown gender',
  'Half-bloods', 'Pure-bloods', 'Muggle-borns', 'Blood traitors', 'Squibs',
  'Impersonated individuals', 'Orphans', 'Adoptees',
]);

function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')  // strip diacritics
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

// Event-shaped titles. Wiki naming convention: "Skirmish at X", "Attack on Y",
// "Battle of Z". Catches events whose category tags don't include the plural
// forms that TYPE_MARKER_CATEGORIES relies on.
const EVENT_TITLE_PREFIXES = [
  'skirmish ',    // "Skirmish at the Cave", "Skirmish in the Chamber of Secrets"
  'attack ',      // "Attack in Little Whinging", "Attack on the Burrow"
  'attack on ',
  'attack at ',
  'attack in ',
  'battle ',
  'battle of ',
  'siege ',
  'siege of ',
  'duel ',
  'duel of ',
  'raid on ',
  'reappearance of ',
  'escape from ',
  'trial of ',
  "voldemort's last stand",
];

// Strong location signals — categories that reliably mark a physical place
// even when the entity ALSO has some other marker (e.g. Hogwarts School has
// "Foundables" which used to bounce it to item). Checked before other type
// markers so location wins these ties.
const STRONG_LOCATION_MARKERS = new Set([
  'Magical schools', 'Hogwarts locations', 'Wizarding schools', 'Wizarding locations',
  'Ministries of Magic', 'Buildings', 'Cities and towns',
  // Hogwarts itself is a category; the main-school page has it plus school-family cats
  'Hogwarts', 'Triwizard schools', 'Potions Championship schools',
]);

// Substring markers for the item type — matched against categories, useful
// for "any kind of book" (History books, Biographies, Books by <author>).
const ITEM_SUBSTRING_MARKERS = ['books', 'biograph'];

function refineEntityType(seedType, title, categories, allCategoryNames) {
  const catSet = new Set(categories);
  const titleLower = (title || '').toLowerCase();

  // 1. Named individuals ALWAYS win.
  for (const marker of NAMED_INDIVIDUAL_MARKERS) {
    if (catSet.has(marker)) return 'character';
  }
  // 2. Event-shaped titles — most reliable event signal.
  for (const prefix of EVENT_TITLE_PREFIXES) {
    if (titleLower.startsWith(prefix)) return 'event';
  }
  // 3. Strong location markers — override other type markers.
  for (const m of STRONG_LOCATION_MARKERS) {
    if (catSet.has(m)) return 'location';
  }
  // 3b. Item substring markers — catches "History books", "Biographies", etc.
  //     without needing to enumerate every book-category variant.
  for (const cRaw of categories) {
    const c = cRaw.toLowerCase();
    for (const sub of ITEM_SUBSTRING_MARKERS) {
      if (c.includes(sub)) return 'item';
    }
  }
  // 4. Explicit type markers (spell, event by cat, creature, item, location).
  for (const { type, markers } of TYPE_MARKER_CATEGORIES) {
    if (markers.some((m) => catSet.has(m))) return type;
  }
  // 5. Species-page rule. If the singular title has a plural that IS a
  //    category name, and no marker/individual signal fired above, it's
  //    almost certainly a species page (Ghost ↔ Ghosts, Dementor ↔ Dementors,
  //    Basilisk ↔ Basilisks, Boggart ↔ Boggarts). Default to creature.
  if (allCategoryNames && title && !title.endsWith('s')) {
    const plural = title + 's';
    const plural_ies = title.endsWith('y') ? title.slice(0, -1) + 'ies' : null;
    if (allCategoryNames.has(plural) || (plural_ies && allCategoryNames.has(plural_ies))) {
      return 'creature';
    }
  }
  return seedType;
}

// Alias list = redirect titles that aren't just the canonical with punctuation.
// Keep every redirect verbatim; scoring uses alias COUNT, editor UI shows them all.
function aliasesFromRedirects(canonical, redirects) {
  const seen = new Set();
  const out = [];
  for (const r of redirects) {
    if (!r || r === canonical) continue;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

// Normalize against a fixed ceiling with clamp — anything at or above the
// ceiling maps to 1.0. Using an upper-tail percentile (p99) as the ceiling
// keeps outliers like Harry Potter from compressing everyone else near zero,
// which is what min-max normalization did in the first pass.
function normalizeCapped(value, ceiling) {
  if (ceiling <= 0) return 0;
  return Math.min(1, value / ceiling);
}

// Percentile helper for computing ceilings from the actual distribution.
function percentile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * q));
  return sortedAsc[idx];
}

// Cutoffs closure — CLI can override easyCut/mediumCut at call time.
function makeDifficultyFn(easyCut, mediumCut) {
  return function difficultyFor(score) {
    if (score >= easyCut)   return 'easy';
    if (score >= mediumCut) return 'medium';
    return 'hard';
  };
}

// Load the hand-curated spinoff exclusion list into a lowercase Set.
// HP Wiki has no category signal for Cursed Child / Hogwarts Legacy appearance
// (per probe results), so this list is the filter mechanism. Additive: any name
// or alias whose lowercased form matches gets dropped.
async function loadExcludeList() {
  if (!existsSync(EXCLUDE_PATH)) return new Set();
  const text = await readFile(EXCLUDE_PATH, 'utf8');
  const out = new Set();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (trimmed) out.add(trimmed.toLowerCase());
  }
  return out;
}

// CLI flag parsing. --include-spinoff bypasses the exclusion list (auditing).
function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v === undefined ? true : v;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const raw = JSON.parse(await readFile(RAW_PATH, 'utf8'));
  const titles = Object.keys(raw);
  console.log(`loaded ${titles.length} raw entities`);

  const excludeList = args['include-spinoff'] ? new Set() : await loadExcludeList();
  if (excludeList.size) console.log(`spinoff exclude list: ${excludeList.size} entries`);
  else if (args['include-spinoff']) console.log('--include-spinoff: skipping exclusion filter');

  // Per-type minimum-categories floor. Characters need many categories because
  // their median is 5 and stub Muggle bystanders proliferate. Non-characters
  // (spells, items, locations, creatures) have far fewer categories by nature
  // — medians of 2-4 — so applying the character threshold wipes them out.
  // Overrides: --min-char=N and --min-nonchar=N.
  const minChar = args['min-char'] != null ? parseInt(args['min-char'], 10)
                : args['min-categories'] != null ? parseInt(args['min-categories'], 10)
                : 8;
  const minNonChar = args['min-nonchar'] != null ? parseInt(args['min-nonchar'], 10) : 2;
  const minByType = { character: minChar, spell: minNonChar, item: minNonChar, location: minNonChar, creature: minNonChar, other: minNonChar };
  console.log(`min-categories: character=${minChar} non-character=${minNonChar}`);

  // Difficulty cutoffs. Defaults widened to broaden the easy pool.
  const easyCut   = args.easy   != null ? parseFloat(args.easy)   : 0.65;
  const mediumCut = args.medium != null ? parseFloat(args.medium) : 0.35;
  const difficultyFor = makeDifficultyFn(easyCut, mediumCut);
  console.log(`cutoffs: easy>=${easyCut}  medium>=${mediumCut}`);

  // Compute allCategoryNames up front — needed by refineEntityType's species
  // rule, which checks whether an entity's title plural is a category name.
  const allCategoryNames = new Set();
  for (const t of titles) {
    for (const c of (raw[t].categories || [])) allCategoryNames.add(c);
  }

  // Pass 1: for every entity, compute its refined type first, then bucket its
  // (cats, length, aliases) into per-type distributions. Per-type p99 ceilings
  // make a spell's 6 cats compare against spells' distribution, not characters'
  // 14-cat p99 — otherwise every non-character scores near zero on cats.
  const perTypeDist = {}; // type -> { cats:[], lens:[], aliases:[] }
  const refinedTypeCache = new Map(); // title -> refined type (avoid recompute in pass 2)
  for (const title of titles) {
    const e = raw[title];
    const seedType = e.entity_type || 'other';
    const refined = refineEntityType(seedType, title, e.categories || [], allCategoryNames);
    refinedTypeCache.set(title, refined);
    if (!perTypeDist[refined]) perTypeDist[refined] = { cats: [], lens: [], aliases: [] };
    perTypeDist[refined].cats.push((e.categories || []).length);
    perTypeDist[refined].lens.push(e.length || 0);
    perTypeDist[refined].aliases.push((e.redirects || []).length);
  }
  const ceilingsByType = {};
  console.log('ceilings (p99) per type:');
  for (const t of Object.keys(perTypeDist)) {
    const d = perTypeDist[t];
    const sc = [...d.cats].sort((a, b) => a - b);
    const sl = [...d.lens].sort((a, b) => a - b);
    const sa = [...d.aliases].sort((a, b) => a - b);
    ceilingsByType[t] = {
      cat:   Math.max(1, percentile(sc, 0.99)),
      len:   Math.max(1, percentile(sl, 0.99)),
      alias: Math.max(1, percentile(sa, 0.99)),
    };
    console.log(`  ${t.padEnd(10)}  n=${String(d.cats.length).padStart(5)}  cat=${ceilingsByType[t].cat}  len=${ceilingsByType[t].len}  alias=${ceilingsByType[t].alias}`);
  }

  // Pass 2: build catalog with prominence + suggested_difficulty + refined type.
  // allCategoryNames (built above) is reused by the concept-page filter below.
  const catalog = {};
  const excluded = [];
  let stubCount = 0;
  let conceptCount = 0;
  const slugCollisions = new Map(); // slug -> count, for dedupe suffix
  for (const title of titles) {
    const e = raw[title];
    const categories = e.categories || [];
    const redirects = e.redirects || [];
    const entity_type = refinedTypeCache.get(title) || 'other';
    const aliases_en = aliasesFromRedirects(title, redirects);

    // Concept/class-page filter: if the page title is itself a category, it's
    // a class page (Death Eaters, Wizards, Muggle-borns), not a puzzle answer.
    if (allCategoryNames.has(title)) { conceptCount++; continue; }

    // Title-pattern drops. These are wiki pages that exist but aren't puzzle-
    // worthy entities:
    //   - "Unidentified <foo>" — placeholder pages for named-but-unnamed
    //     characters/creatures/spells (~600 in the raw data).
    //   - "Head of <X>" / "Headmaster of <X>" / "Headmistress of <X>" —
    //     role/office pages, not the person or place.
    const t = title.toLowerCase();
    if (t.startsWith('unidentified ') ||
        t.startsWith('head of ') ||
        t.startsWith('headmaster of ') ||
        t.startsWith('headmistress of ') ||
        t.startsWith('minister for magic of ')) {
      conceptCount++; continue;
    }

    // Pottermore-content filter: drop entities whose categories mention any
    // Pottermore-source school or NA-wizarding-history marker (Ilvermorny,
    // Uagadou, etc.). Substring match to catch category variants.
    let hasPottermore = false;
    for (const cRaw of categories) {
      const c = cRaw.toLowerCase();
      for (const m of POTTERMORE_MARKERS) {
        if (c.includes(m)) { hasPottermore = true; break; }
      }
      if (hasPottermore) break;
    }
    if (hasPottermore) { excluded.push(title); continue; }

    // Stub filter: per-type minimum. See minByType construction above.
    const floor = minByType[entity_type] ?? minNonChar;
    if (categories.length < floor) { stubCount++; continue; }

    // Spinoff exclusion: canonical or any alias match (case-insensitive).
    if (excludeList.size) {
      const candidates = [title, ...aliases_en].map((s) => s.toLowerCase());
      if (candidates.some((c) => excludeList.has(c))) {
        excluded.push(title);
        continue;
      }
    }

    const ceilings = ceilingsByType[entity_type] || ceilingsByType.other || { cat: 1, len: 1, alias: 1 };
    const catNorm   = normalizeCapped(categories.length, ceilings.cat);
    const lenNorm   = normalizeCapped(e.length || 0,     ceilings.len);
    const aliasNorm = normalizeCapped(redirects.length,  ceilings.alias);

    // Weights: category count is the strongest identity signal (0.5), page
    // length is the primary signal for non-characters where cats are sparse
    // (0.4), aliases are noisy so kept small (0.1). No discrete core-bonus
    // tier — per-type ceilings do that work now.
    const prominence_score = +(0.5 * catNorm + 0.4 * lenNorm + 0.1 * aliasNorm).toFixed(3);
    const suggested_difficulty = difficultyFor(prominence_score);

    // Deterministic slug with collision suffix to keep keys unique.
    let key = slugify(title);
    if (!key) key = `entity_${Object.keys(catalog).length}`;
    if (catalog[key]) {
      const n = (slugCollisions.get(key) || 1) + 1;
      slugCollisions.set(key, n);
      key = `${key}_${n}`;
    }

    catalog[key] = {
      canonical_en: title,
      aliases_en,
      raw_categories: categories,
      entity_type,
      fandom_url: `https://harrypotter.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      prominence_score,
      suggested_difficulty,
    };
  }

  await writeFile(OUT_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

  // Report distribution and calibration snapshot.
  const byDiff = { easy: 0, medium: 0, hard: 0 };
  for (const k of Object.keys(catalog)) byDiff[catalog[k].suggested_difficulty]++;
  console.log(`\nwrote ${Object.keys(catalog).length} entities → ${OUT_PATH}`);
  console.log(`stubs skipped (per-type floor char=${minChar} nonchar=${minNonChar}): ${stubCount}`);
  console.log(`concept pages skipped (title matches a category): ${conceptCount}`);
  if (excluded.length) console.log(`spinoff excluded: ${excluded.length}`);
  const total = Object.keys(catalog).length || 1;
  const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
  console.log(`\ndifficulty mix (overall):`);
  console.log(`  easy    ${String(byDiff.easy).padStart(5)}  (${pct(byDiff.easy)})`);
  console.log(`  medium  ${String(byDiff.medium).padStart(5)}  (${pct(byDiff.medium)})`);
  console.log(`  hard    ${String(byDiff.hard).padStart(5)}  (${pct(byDiff.hard)})`);

  // Per-type breakdown so we can see if any type is starved of easy/medium.
  const perTypeDiff = {};
  for (const e of Object.values(catalog)) {
    if (!perTypeDiff[e.entity_type]) perTypeDiff[e.entity_type] = { easy: 0, medium: 0, hard: 0 };
    perTypeDiff[e.entity_type][e.suggested_difficulty]++;
  }
  console.log(`\ndifficulty mix by type:`);
  console.log(`  ${'type'.padEnd(10)}   easy medium   hard   total`);
  for (const t of Object.keys(perTypeDiff).sort()) {
    const d = perTypeDiff[t];
    const tot = d.easy + d.medium + d.hard;
    console.log(`  ${t.padEnd(10)}  ${String(d.easy).padStart(5)}  ${String(d.medium).padStart(5)}  ${String(d.hard).padStart(5)}   ${String(tot).padStart(5)}`);
  }

  // Top 20 by prominence — sanity check for calibration.
  const ranked = Object.values(catalog)
    .sort((a, b) => b.prominence_score - a.prominence_score)
    .slice(0, 20);
  console.log(`\ntop 20 by prominence:`);
  for (const e of ranked) {
    console.log(`  ${e.prominence_score.toFixed(2)}  ${e.suggested_difficulty.padEnd(7)}  ${e.canonical_en}  (${e.raw_categories.length} cats)`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
