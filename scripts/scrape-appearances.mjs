// scripts/scrape-appearances.mjs
//
// Second-pass scraper: for every title already in data/scrape-raw.json, fetch
// the article's raw wikitext, extract its "==Appearances==" section, and record
// which of the 7 core novels the entity APPEARS in vs is only MENTIONED in.
// Output: data/appearances.json ({ novels_appeared, novels_mentioned } per
// title). The keep/drop policy over those lists lives in build-catalog.mjs.
//
// Why this exists (see also build-catalog.mjs canonicity notes): the HP Wiki
// category system does not distinguish book-canon from spin-off-only content,
// and — critically — its hidden "Articles with information from X" categories
// mark "mentioned OR appears", so they cannot express "actually appears in a
// novel". The Appearances section is the only source that does. Karkaroff, for
// example, is tagged with book categories for OotP/HBP/DH but the Appearances
// list shows he only APPEARS in Goblet of Fire; the rest are "(Mentioned only)".
//
// Runs locally (Node 20+, native fetch), NOT in the Worker.
//
// Strategy:
//   1. Read titles from data/scrape-raw.json (no re-enumeration of categories).
//   2. Batch 50 titles per request via action=query&prop=revisions&rvprop=content
//      — raw wikitext for 50 pages per call, so ~160 calls for ~7.8k titles
//      (a few minutes), not one call per page.
//   3. Slice the ==Appearances== section out of each page's wikitext and parse
//      its list items for the 7 novel templates, splitting appearances from
//      mentioned-only citations.
//   4. Write data/appearances.json (+ a resumable checkpoint).
//
// Usage:
//   node scripts/scrape-appearances.mjs                 # full run (resumable)
//   node scripts/scrape-appearances.mjs --limit=200     # cap titles (dev)
//   node scripts/scrape-appearances.mjs --report-tokens # print template-name
//                                                        # tally and exit (audit)
//
// Delete data/appearances-progress.json for a clean re-run.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(REPO_ROOT, 'data');
const RAW_PATH = resolve(DATA_DIR, 'scrape-raw.json');
const OUT_PATH = resolve(DATA_DIR, 'appearances.json');
const PROGRESS_PATH = resolve(DATA_DIR, 'appearances-progress.json');

const API = 'https://harrypotter.fandom.com/api.php';
// Keep the descriptive UA in sync with scrape-fandom.mjs; change contact if you fork.
const USER_AGENT = 'puzzles-hpvn/0.1 (https://github.com/abundleoflinh/puzzles-hpvn; personal fan project)';
const REQ_DELAY_MS = 1000; // ~1 req/sec, matching scrape-fandom.mjs
const TITLE_BATCH = 50;    // MediaWiki `titles` param cap

// In raw wikitext the 7 core novels are cited on appearance lines by
// abbreviation TEMPLATES (e.g. `*{{GOF}} {{1st}}`), not by wikilinks — the link
// form on the rendered page is what {{GOF}} expands to. Map each novel's
// template abbreviation to its canonical title. Film/game adaptations use
// distinct templates ({{GOFF}}, {{GOFG}}, …) that are not in this map, so only
// the novels match. (Vocabulary confirmed against the live corpus via
// --report-tokens: {{ps}}/{{cos}}/{{poa}}/{{gof}}/{{ootp}}/{{hbp}}/{{dh}}.)
const NOVEL_TEMPLATES = new Map([
  ['ps',   "Harry Potter and the Philosopher's Stone"],
  ['cos',  'Harry Potter and the Chamber of Secrets'],
  ['poa',  'Harry Potter and the Prisoner of Azkaban'],
  ['gof',  'Harry Potter and the Goblet of Fire'],
  ['ootp', 'Harry Potter and the Order of the Phoenix'],
  ['hbp',  'Harry Potter and the Half-Blood Prince'],
  ['dh',   'Harry Potter and the Deathly Hallows'],
]);

// A novel entry is a MENTION (not an appearance) when its line carries a
// mentioned-only marker. Confirmed against the live corpus via --report-tokens:
// {{mention}} is the dominant marker (14k+ uses); {{Mo}} does not exist here.
// {{1st}} / {{1st id}} / {{1st described}} are appearances and contain no
// "mention". A line is treated as a mention when a template name contains
// "mention" (covers {{mention}}, {{1st mention}}, {{... mention}}, {{mentioned
// on a poster}}), is {{1stm}} or {{indirect}} (subject not physically present),
// or is a {{c|…}} comment whose text contains "mention".
function isMentionMarker({ name, arg }) {
  return /mention/.test(name) || name === '1stm' || name === 'indirect'
    || (name === 'c' && /mention/i.test(arg));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// Normalise a title/link target for comparison: decode a couple of common wiki
// escapes, collapse whitespace (underscores are spaces in wikilinks), and
// unify the two apostrophe glyphs so "Philosopher's" matches either form.
function normTitle(s) {
  return String(s ?? '')
    .replace(/_/g, ' ')
    .replace(/’/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
// Full novel titles as normalised wikilink targets → canonical title, for the
// rare page that hardcodes `[[Harry Potter and the Goblet of Fire]]` in its
// Appearances list instead of using the {{GOF}} template.
const NOVEL_LINKS = new Map([...NOVEL_TEMPLATES.values()].map((t) => [normTitle(t), t]));

// --------------------------------------------------------------------------
// Fandom API client (mirrors scrape-fandom.mjs: 1 rps, retries/backoff)
// --------------------------------------------------------------------------

let lastReqAt = 0;
async function apiCall(params) {
  const wait = Math.max(0, REQ_DELAY_MS - (Date.now() - lastReqAt));
  if (wait) await sleep(wait);
  lastReqAt = Date.now();

  const url = new URL(API);
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Fandom API ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Fandom API error: ${body.error.info || body.error.code}`);
  return body;
}

// Fetch raw wikitext for up to TITLE_BATCH titles. Returns Map<requestedTitle,
// wikitext|null>. `redirects=1` resolves redirect pages; we map the resolved
// content back onto the title we asked for so keys line up with scrape-raw.json.
async function fetchWikitextBatch(titles) {
  const out = new Map(); // requestedTitle -> wikitext | null
  for (const t of titles) out.set(t, null);

  // Map API-normalised / redirected titles back to what we requested.
  const aliasToRequested = new Map();
  for (const t of titles) aliasToRequested.set(t, t);

  let continueParams = null;
  let safety = 10;
  do {
    const params = {
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      titles: titles.join('|'),
      redirects: '1',
    };
    if (continueParams) Object.assign(params, continueParams);

    let body, lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { body = await apiCall(params); break; }
      catch (err) { lastErr = err; await sleep(1000 * (attempt + 1) * (attempt + 1)); }
    }
    if (!body) throw lastErr || new Error('fetchWikitextBatch exhausted retries');

    // Record normalisation + redirect hops so page.title maps to a requested key.
    for (const n of body?.query?.normalized || []) {
      if (aliasToRequested.has(n.from)) aliasToRequested.set(n.to, aliasToRequested.get(n.from));
    }
    for (const r of body?.query?.redirects || []) {
      if (aliasToRequested.has(r.from)) aliasToRequested.set(r.to, aliasToRequested.get(r.from));
    }

    for (const p of body?.query?.pages || []) {
      const requested = aliasToRequested.get(p.title) || p.title;
      const content = p?.revisions?.[0]?.slots?.main?.content;
      if (typeof content === 'string' && out.has(requested)) out.set(requested, content);
    }

    continueParams = body?.continue || null;
    if (continueParams && --safety <= 0) break;
  } while (continueParams);

  return out;
}

// --------------------------------------------------------------------------
// Appearances parsing
// --------------------------------------------------------------------------

// Extract the text of the ==Appearances== section (level-2), from the heading
// up to the next level-2 heading (=== subheadings do not terminate it). Returns
// null when the article has no Appearances section at all.
function extractAppearancesSection(wikitext) {
  if (!wikitext) return null;
  const re = /^==\s*Appearances\s*==\s*$/im;
  const m = re.exec(wikitext);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = wikitext.slice(start);
  // Next line that is a level-2 heading (==X==) but not level-3+ (===X===).
  const next = /^==(?!=)[^\n]*==\s*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

// Pull every template on a line as { name, arg }: name lowercased (the part
// before the first `|`), arg = the raw text after it (or ''). The `[^}]` arg
// stops at the first `}`, so a comment template with a nested template inside
// its argument won't parse its arg fully — negligible for appearance lines,
// whose {{c|…}} comments are plain text ("Seen on newspaper", etc.).
function lineTemplates(line) {
  const out = [];
  const re = /\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g;
  let m;
  while ((m = re.exec(line))) out.push({ name: m[1].trim().toLowerCase(), arg: (m[2] || '').slice(1) });
  return out;
}

// Pull wikilink targets ([[Target]] or [[Target|label]]) from a line, each
// normalised and stripped of any #anchor. Fallback for the rare page that lists
// a novel as a hardcoded link instead of the {{GOF}}-style template.
function linkTargets(line) {
  const out = [];
  const re = /\[\[\s*([^\]|#]+?)\s*(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(line))) out.push(normTitle(m[1]));
  return out;
}

// Classify one appearance list line: which novel (if any) it cites, and whether
// that citation is a mention rather than an appearance. Returns null when the
// line references none of the 7 novels.
function classifyNovelLine(templates, line) {
  let novel = null;
  for (const t of templates) {
    if (NOVEL_TEMPLATES.has(t.name)) { novel = NOVEL_TEMPLATES.get(t.name); break; }
  }
  if (!novel) {
    for (const target of linkTargets(line)) {
      if (NOVEL_LINKS.has(target)) { novel = NOVEL_LINKS.get(target); break; }
    }
  }
  if (!novel) return null;
  return { novel, mentioned: templates.some(isMentionMarker) };
}

// Parse one Appearances section. Returns:
//   { parsed:true, novels_appeared:[], novels_mentioned:[] }  (mentioned excludes
//   any novel also in appeared) or { parsed:false } when there is no section.
// The keep/drop policy (appears-only vs appears-or-mentioned) lives in
// build-catalog.mjs, so both lists are recorded here regardless.
// `tokenTally` (optional Map) accumulates template-name counts for --report-tokens.
function parseAppearances(wikitext, tokenTally) {
  const section = extractAppearancesSection(wikitext);
  if (section == null) return { parsed: false };

  const appeared = new Set();
  const mentioned = new Set();

  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('*')) continue; // only list items are appearance entries

    const templates = lineTemplates(line);
    if (tokenTally) for (const t of templates) tokenTally.set(t.name, (tokenTally.get(t.name) || 0) + 1);

    const hit = classifyNovelLine(templates, line);
    if (!hit) continue;
    (hit.mentioned ? mentioned : appeared).add(hit.novel);
  }

  // A novel counted as an appearance is not also reported as merely mentioned.
  for (const n of appeared) mentioned.delete(n);

  return { parsed: true, novels_appeared: [...appeared], novels_mentioned: [...mentioned] };
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const limit = args.limit ? parseInt(args.limit, 10) : null;

  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  const raw = await readJson(RAW_PATH, null);
  if (!raw) { console.error(`missing ${RAW_PATH} — run cf:scrape first`); process.exit(1); }

  let titles = Object.keys(raw);
  if (limit) titles = titles.slice(0, limit);
  console.log(`titles to process: ${titles.length}`);

  // --report-tokens: tally template names across appearance lines and exit, so
  // the novel + mentioned-only vocabulary can be verified against the live corpus
  // before trusting the classification. Annotates each token with how it's read.
  if (args['report-tokens']) {
    const tally = new Map();
    let seen = 0;
    for (let i = 0; i < titles.length; i += TITLE_BATCH) {
      const batch = titles.slice(i, i + TITLE_BATCH);
      const data = await fetchWikitextBatch(batch);
      for (const wt of data.values()) { parseAppearances(wt, tally); seen++; }
      process.stdout.write(`\r  scanned ${Math.min(i + TITLE_BATCH, titles.length)}/${titles.length}`);
    }
    console.log(`\ntemplate names across appearance lines (n=${seen} pages):`);
    for (const [tok, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      const flag = NOVEL_TEMPLATES.has(tok) ? '  [NOVEL]'
        : isMentionMarker({ name: tok, arg: '' }) ? '  [mention]' : '';
      console.log(`  ${String(n).padStart(6)}  {{${tok}}}${flag}`);
    }
    return;
  }

  const progress = await readJson(PROGRESS_PATH, {});
  const done = new Set(Object.keys(progress));
  const remaining = titles.filter((t) => !done.has(t));
  console.log(`resuming: ${done.size} done, ${remaining.length} remaining`);

  for (let i = 0; i < remaining.length; i += TITLE_BATCH) {
    const batch = remaining.slice(i, i + TITLE_BATCH);
    process.stdout.write(`  batch ${Math.floor(i / TITLE_BATCH) + 1}/${Math.ceil(remaining.length / TITLE_BATCH)}... `);
    let data;
    try {
      data = await fetchWikitextBatch(batch);
    } catch (err) {
      console.warn(`\n  batch failed: ${err.message} — retrying once after 5s`);
      await sleep(5000);
      try { data = await fetchWikitextBatch(batch); }
      catch (err2) { console.warn(`  batch failed again: ${err2.message} — skipping`); continue; }
    }
    for (const title of batch) {
      const wt = data.get(title);
      progress[title] = parseAppearances(wt); // {parsed:false} when no section / no content
    }
    await writeJson(PROGRESS_PATH, progress); // checkpoint each batch
    console.log('ok');
  }

  // Final output: strip nothing, keep the full record per title for auditing.
  await writeJson(OUT_PATH, progress);

  // Summary: A = appears in a novel, M = only mentioned in a novel (appears in
  // none), N = no novel presence at all. cf:catalog drops N by default (and also
  // M under --books-appear-only); pages with no Appearances section fall back to
  // category heuristics.
  const vals = Object.values(progress);
  const parsed = vals.filter((v) => v.parsed);
  const a = parsed.filter((v) => v.novels_appeared.length > 0).length;
  const m = parsed.filter((v) => v.novels_appeared.length === 0 && v.novels_mentioned.length > 0).length;
  const n = parsed.length - a - m;
  console.log(`\nwrote ${vals.length} records → ${OUT_PATH}`);
  console.log(`  with Appearances section    : ${parsed.length}`);
  console.log(`  A — appears in a novel      : ${a}`);
  console.log(`  M — only mentioned in novel : ${m}  (kept by default; dropped under --books-appear-only)`);
  console.log(`  N — no novel presence       : ${n}  (dropped by cf:catalog)`);
  console.log(`  no Appearances section      : ${vals.length - parsed.length}  (fall back to category heuristics)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
