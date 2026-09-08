// scripts/scrape-fandom.mjs
//
// One-time scraper for Harry Potter Fandom Wiki. Runs locally (Node 20+, native fetch),
// NOT in the Worker. Output: data/scrape-raw.json — full per-entity dump used by
// build-catalog.mjs and build-frequency.mjs downstream.
//
// Strategy:
//   1. Seed from five Fandom categories, each mapped to an entity_type.
//   2. Recursively traverse subcategories, collecting page titles. Dedup.
//   3. For every collected title, fetch categories, redirects, and page length.
//   4. Filter categories through a blocklist (meta / maintenance tags).
//   5. Write to data/scrape-raw.json.
//
// Design notes:
//   - Respectful of Fandom's shared infra: 1 req/sec, descriptive User-Agent.
//     No hard rate limit is published; convention is ~1 rps. Aggressive scraping
//     gets IP-blocked. Batching 50 titles per prop query keeps calls low.
//   - Resumable: intermediate state written to data/scrape-progress.json after each
//     batch. Re-running skips titles already fetched. Delete that file for a clean run.
//   - No external deps — sticks to native fetch. Node 20+ required.
//
// Usage:
//   node scripts/scrape-fandom.mjs                  # full run
//   node scripts/scrape-fandom.mjs --seeds-only     # just enumerate titles, no per-page fetch
//   node scripts/scrape-fandom.mjs --limit=50       # cap total titles (dev/testing)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(REPO_ROOT, 'data');
const RAW_PATH = resolve(DATA_DIR, 'scrape-raw.json');
const PROGRESS_PATH = resolve(DATA_DIR, 'scrape-progress.json');

const API = 'https://harrypotter.fandom.com/api.php';
// Descriptive UA per Wikimedia/Fandom convention. Change the contact if you fork.
const USER_AGENT = 'puzzles-hpvn/0.1 (https://github.com/abundleoflinh/puzzles-hpvn; personal fan project)';
const REQ_DELAY_MS = 1000;         // ~1 req/sec
const TITLE_BATCH = 50;            // MediaWiki `titles` param cap
const CATEGORY_MEMBER_LIMIT = 500; // per cm page
const MAX_SUBCAT_DEPTH = 4;        // guardrail; HP Wiki cat tree is not deep

// Seed categories → entity_type. entity_type is set by the FIRST seed to surface
// a title (deterministic per traversal order). Order chosen so specific
// non-character seeds run before Category:Individuals, which otherwise sweeps
// up species pages (Basilisk, Phoenix, Dementor, House-elf) as "character".
//
// Category:Magical creatures was removed — empty on the HP Wiki. Beasts (beasts
// proper) and Beings (sentient magical humanoids) are the actual seeds.
// Category:Ministries of Magic added — Ministry of Magic and national ministries
// are not reachable from Category:Locations at practical traversal depth.
const SEEDS = [
  { category: 'Category:Spells',              entity_type: 'spell' },
  { category: 'Category:Beasts',              entity_type: 'creature' },
  { category: 'Category:Beings',              entity_type: 'creature' },
  { category: 'Category:Magical objects',     entity_type: 'item' },
  { category: 'Category:Ministries of Magic', entity_type: 'location' },
  { category: 'Category:Wizarding locations', entity_type: 'location' },
  { category: 'Category:Locations',           entity_type: 'location' },
  // Category:Magic is a broad umbrella containing magical techniques,
  // transportation, sub-branches of magic, and concept pages (Apparition,
  // Occlumency, Legilimency, Muggle, Animagus) that no narrower seed reaches.
  // Placed after specific-type seeds so anything already claimed keeps its
  // proper type; only novel entries land here. Default type 'spell' because
  // most magic concepts are technique-adjacent — build-catalog can refine.
  { category: 'Category:Magic',               entity_type: 'spell' },
  { category: 'Category:Individuals',         entity_type: 'character' },
];

// Category blocklist — dropped from every entity's raw_categories.
// Prefix/substring matches, all case-insensitive.
const CATEGORY_BLOCK_SUBSTRINGS = [
  'articles with',
  'pages using',
  'stubs',
  'images of',
  'file:',
  'category:',           // shouldn't appear as a listed cat, but be defensive
  'featured articles',
  'featured article',
  'disambiguation',
  'redirects',
  'candidates for deletion',
  'articles needing',
  'broken redirects',
  'wikipedia',           // meta wiki refs
  'browse',
];

// Year-of-birth cats ("1979 births") are KEPT per plan §7.1 — valid hard clues.

// Subcategory blocklist for BFS traversal. Skip entire branches that don't yield
// HP-native entities (Biblical/real-world/mythological figures referenced in HP
// but not HP characters themselves), plus media-only branches. Case-insensitive
// substring match on the subcategory title (with or without "Category:" prefix).
const SUBCAT_TRAVERSAL_BLOCK = [
  'biblical figures',
  'real-world',
  'historical figures',
  'mythological figures',
  'legendary figures',
  'images of',
  'files of',
  'unidentified',
  'unknown',      // Unknown individuals / spells / etc. — no name means no puzzle
  'stubs',        // Spell stubs, Location stubs, Character stubs — wiki-flagged short pages
  // Pottermore-only international schools (not in the 7 books). MACUSA is not
  // listed — it's in the Fantastic Beasts films, already handled by FB exclude.
  'ilvermorny',
  'uagadou',
  'mahoutokoro',
  'castelobruxo',
  'koldovstoretz',
];

function isBlockedSubcat(title) {
  const t = title.toLowerCase().replace(/^category:/, '');
  return SUBCAT_TRAVERSAL_BLOCK.some((sub) => t.includes(sub));
}

// --------------------------------------------------------------------------
// tiny helpers
// --------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
}

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function isBlockedCategory(name) {
  const lower = name.toLowerCase();
  return CATEGORY_BLOCK_SUBSTRINGS.some((sub) => lower.includes(sub));
}

// Parse "--flag=value" and "--flag" from argv.
function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const [k, v] = arg.slice(2).split('=');
    out[k] = v === undefined ? true : v;
  }
  return out;
}

// --------------------------------------------------------------------------
// Fandom API client
// --------------------------------------------------------------------------

let lastReqAt = 0;

async function apiCall(params) {
  // enforce ~1 req/sec globally
  const now = Date.now();
  const wait = Math.max(0, REQ_DELAY_MS - (now - lastReqAt));
  if (wait) await sleep(wait);
  lastReqAt = Date.now();

  const url = new URL(API);
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Fandom API ${res.status} for ${url}`);
  const body = await res.json();
  if (body.error) throw new Error(`Fandom API error: ${body.error.info || body.error.code}`);
  return body;
}

// List all page titles + subcategory titles in a category, walking cmcontinue
// pages. Retries transient failures with exponential backoff — one flaky
// request can otherwise silently drop an entire branch (Category:Europe,
// Category:Puffskeins, etc. failed on the prior run).
async function listCategoryMembers(categoryTitle) {
  const pages = [];
  const subcats = [];
  let cmcontinue;
  do {
    const params = {
      action: 'query',
      list: 'categorymembers',
      cmtitle: categoryTitle,
      cmlimit: String(CATEGORY_MEMBER_LIMIT),
      cmtype: 'page|subcat',
    };
    if (cmcontinue) params.cmcontinue = cmcontinue;
    let body;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { body = await apiCall(params); break; }
      catch (err) {
        lastErr = err;
        const backoff = 1000 * (attempt + 1) * (attempt + 1); // 1s, 4s
        await sleep(backoff);
      }
    }
    if (!body) throw lastErr || new Error('listCategoryMembers exhausted retries');
    const members = body?.query?.categorymembers || [];
    for (const m of members) {
      if (m.ns === 14) subcats.push(m.title);       // subcategory
      else if (m.ns === 0) pages.push(m.title);     // main-namespace article
    }
    cmcontinue = body?.continue?.cmcontinue;
  } while (cmcontinue);
  return { pages, subcats };
}

// Batch prop=categories|redirects|info for up to TITLE_BATCH titles at once.
// Returns per-title { categories[], redirects[], length }.
// Handles `continue` when categories/redirects overflow — retries with same batch.
async function fetchTitleBatch(titles) {
  const out = new Map(); // title -> { categories, redirects, length }
  for (const t of titles) out.set(t, { categories: [], redirects: [], length: 0 });

  let continueParams = null;
  let safety = 20; // hard cap on continuation rounds
  do {
    const params = {
      action: 'query',
      prop: 'categories|redirects|info',
      titles: titles.join('|'),
      cllimit: '500',
      clshow: '!hidden',
      rdlimit: '50',
      redirects: '1', // resolve incoming redirect titles to canonical
    };
    if (continueParams) Object.assign(params, continueParams);
    const body = await apiCall(params);

    const pages = body?.query?.pages || [];
    for (const p of pages) {
      // formatversion=2 gives us .title, .categories[].title, .redirects[].title, .length
      const entry = out.get(p.title);
      if (!entry) {
        // may be a redirect-resolved canonical title we didn't seed with;
        // create it so we still capture its data
        out.set(p.title, { categories: [], redirects: [], length: p.length || 0 });
      }
      const e = out.get(p.title);
      if (Array.isArray(p.categories)) {
        for (const c of p.categories) {
          // strip leading "Category:" prefix if present
          const name = String(c.title || '').replace(/^Category:/, '');
          if (!name || isBlockedCategory(name)) continue;
          if (!e.categories.includes(name)) e.categories.push(name);
        }
      }
      if (Array.isArray(p.redirects)) {
        for (const r of p.redirects) {
          const t = String(r.title || '');
          if (t && !e.redirects.includes(t)) e.redirects.push(t);
        }
      }
      if (typeof p.length === 'number' && p.length > e.length) e.length = p.length;
    }

    continueParams = body?.continue || null;
    if (continueParams && --safety <= 0) {
      console.warn('  continuation safety cap hit; moving on');
      break;
    }
  } while (continueParams);

  return out;
}

// --------------------------------------------------------------------------
// main pipeline
// --------------------------------------------------------------------------

async function enumerateSeeds(limit) {
  // Deterministic order: iterate SEEDS as declared. First seed to surface a
  // title owns its entity_type — matches confirmed design choice (option a).
  const titleType = new Map(); // title -> entity_type

  for (const seed of SEEDS) {
    console.log(`[seed] ${seed.category} → ${seed.entity_type}`);
    const visited = new Set();
    const queue = [{ cat: seed.category, depth: 0 }];
    while (queue.length) {
      const { cat, depth } = queue.shift();
      if (visited.has(cat)) continue;
      visited.add(cat);
      let pages, subcats;
      try {
        ({ pages, subcats } = await listCategoryMembers(cat));
      } catch (err) {
        console.warn(`  skip ${cat}: ${err.message}`);
        continue;
      }
      for (const p of pages) {
        if (!titleType.has(p)) titleType.set(p, seed.entity_type);
        if (limit && titleType.size >= limit) return titleType;
      }
      if (depth < MAX_SUBCAT_DEPTH) {
        for (const s of subcats) {
          if (isBlockedSubcat(s)) {
            console.log(`  skip subcat: ${s}`);
            continue;
          }
          queue.push({ cat: s, depth: depth + 1 });
        }
      }
    }
    console.log(`  running total: ${titleType.size} titles`);
  }
  return titleType;
}

async function main() {
  const args = parseArgs(process.argv);
  const limit = args.limit ? parseInt(args.limit, 10) : null;
  const seedsOnly = !!args['seeds-only'];

  await ensureDataDir();

  console.log('=== phase 1: enumerate seed titles ===');
  const titleType = await enumerateSeeds(limit);
  console.log(`\nenumerated ${titleType.size} unique titles across ${SEEDS.length} seeds`);

  // Load existing progress. Key: title → { entity_type, categories, redirects, length }.
  const progress = await readJson(PROGRESS_PATH, {});
  const done = new Set(Object.keys(progress));
  console.log(`resuming: ${done.size} titles already fetched, ${titleType.size - done.size} remaining\n`);

  if (seedsOnly) {
    console.log('--seeds-only: skipping per-title fetch');
    await writeJson(RAW_PATH, Object.fromEntries(
      [...titleType.entries()].map(([t, et]) => [t, { entity_type: et, categories: [], redirects: [], length: 0 }])
    ));
    return;
  }

  console.log('=== phase 2: fetch categories/redirects/info per title ===');
  const remaining = [...titleType.keys()].filter((t) => !done.has(t));
  for (let i = 0; i < remaining.length; i += TITLE_BATCH) {
    const batch = remaining.slice(i, i + TITLE_BATCH);
    process.stdout.write(`  batch ${Math.floor(i / TITLE_BATCH) + 1}/${Math.ceil(remaining.length / TITLE_BATCH)} (${batch.length} titles)... `);
    let data;
    try {
      data = await fetchTitleBatch(batch);
    } catch (err) {
      console.warn(`\n  batch failed: ${err.message} — retrying once after 5s`);
      await sleep(5000);
      try { data = await fetchTitleBatch(batch); }
      catch (err2) { console.warn(`  batch failed again: ${err2.message} — skipping`); continue; }
    }
    for (const [title, info] of data.entries()) {
      progress[title] = {
        entity_type: titleType.get(title) || 'other',
        categories: info.categories,
        redirects: info.redirects,
        length: info.length,
      };
    }
    await writeJson(PROGRESS_PATH, progress); // checkpoint after each batch
    console.log('ok');
  }

  console.log(`\n=== done: ${Object.keys(progress).length} titles → ${RAW_PATH} ===`);
  await writeJson(RAW_PATH, progress);
}

main().catch((err) => { console.error(err); process.exit(1); });
