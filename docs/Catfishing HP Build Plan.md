# Catfishing HP — Build Plan (Rev. 3)

Handoff document for the Catfishing guessing game on the `puzzles-hpvn` site.
Supersedes Rev. 2. Incorporates Steps 1–4 **as actually built** (scrape pipeline,
dictionary CSVs, dictionary build script, and the full Worker layer), plus the
player-override feature added during Step 4.

Read this end-to-end before proposing changes. Architectural decisions are
locked; open items are called out in §14.

**Status at this revision:** Steps 1–4 BUILT and locally verified. Next up is
Step 5 (editor UI) → Step 6 (player UI) → Step 7 (already partly built server-side).

---

## 1. Context

`puzzles-hpvn` is a personal Cloudflare-hosted puzzle site (Vite MPA + Workers
+ KV) themed around a Harry Potter / Vietnamese fan community. It hosts
Connections and Strands. This build adds a third game modelled on
**catfishing.net** — guess a Harry Potter entity from the list of Fandom Wiki
categories it belongs to.

### Project constraints (do not violate)

Read `Project Instructions.md` for the full ruleset. Non-negotiables:

- **Stack:** Vite MPA + vanilla JS + Cloudflare Pages + Workers + KV. No frameworks.
- **Security:** Puzzle answers never returned to unauthenticated clients.
  Editor auth = single `EDITOR_PASSWORD` Worker secret, `X-Editor-Password`
  header, timing-safe compare. All guess validation server-side.
- **Bilinguality:** All UI chrome via `src/i18n/*.json` (EN + VI). New features
  ship both languages in the same patch.
- **Theming:** Three themes (light, dark, HPVN) via CSS variables. HPVN
  first-class from day one.
- **Persistence:** localStorage only. No accounts, no server-side player state
  (aggregate stats are the deliberate exception — see §11).
- **Deploy order:** `wrangler deploy` (Worker) **before** pushing to `main`
  (Pages).

### Working conventions

- Files land **directly in the repo**, not as zip patches.
- Confirm plan before patching. Ship incrementally, per §13 phase.
- Validate JS with `node --check`, JSON with a parse check.
- When something asked-for is inaccessible, stop and report — don't work around
  it silently.

---

## 2. Product spec

### Game mechanic

- Unit = **set of 5 sequential questions**. One URL, one set.
- Each question: player sees the full category dump (20–40 clues, alphabetized
  in the player's current UI language) for one HP entity. One free-text guess.
  Server validates.
- Answer input accepts **both EN and VI** (no language toggle for guess), and
  matching is language-agnostic — the guess is checked against the EN answer,
  the VI answer, and both alias lists on every attempt, regardless of the UI
  the player is in.
- Fuzzy matcher confirms near-misses: "Did you mean **Hermione Granger**?"
  [Yes] [No]. Yes → hit. No → miss.
- **Player override (honor system):** on a miss (or a declined confirm), the
  player may self-declare correct ("I was right") and keep the full point. This
  is a deliberate backup for gaps in the matcher or the answer's alias coverage.
  Players are trusted to be honest. The self-declare is recorded server-side in
  a **separate** `overrides[q]` counter (never in `correct[q]`) — see §11.
- After each question, reveal answer and advance to next.
- Set ends with score 0–5 and per-question stats.

### Difficulty

- Per-question internal tag: `easy | medium | hard`.
- Default ratio per set: **2:2:1** (2 easy, 2 medium, 1 hard). Customisable per
  set in editor.
- Never shown to player. Used for internal balance auditing.
- Measures **how prominent or obscure the answer is** to a general HP audience —
  not clue difficulty.
- Editor tags manually per question, with auto-suggestion from prominence
  signals (see §7).

### Publication model

- Share-by-link. No daily archive.
- Homepage lists only sets added to a curated collection. Uses the same
  `collectionId` mechanism Connections/Strands already have (`collection:{id}`
  KV keys, puzzle records reference by field).

---

## 3. Naming & routing

| Concern | Value |
|---|---|
| Module directory | `src/games/catfishing/` (Step 5+) |
| Editor entrypoint | `catfishing.html` (Vite MPA input; add to `vite.config.js` in Step 5) |
| Player route | `/play.html#cf/{id}` (hash-based, matching Connections `#c/{id}`, Strands `#s/{id}`) |
| Create-response URL prefix | `/cf/{id}` (matches `/c/`, `/s/`) |
| KV namespace (puzzles) | `catfishing:{id}` |
| KV namespace (stats) | `stats:cf:{id}` |
| ID format | 5-char base58, same generator as the other games |
| Worker routes | **Reuses the generic `/api/puzzle/*` shape** — see §6. Diverges from Rev. 2's proposed `/api/catfishing/*` namespace (rationale in §6). |

Single `PUZZLES` KV binding covers `catfishing:*` and `stats:cf:*` — no new
binding.

---

## 4. File layout

### Steps 1–4 (BUILT)

```
scripts/
  scrape-fandom.mjs        Fandom MediaWiki API scraper (Step 1).
  build-catalog.mjs        Raw → catalog.json (Step 1).
  build-frequency.mjs      catalog.json → frequency.csv + frequency_templates.csv (Step 1).
  append-dict-terms.mjs    Append-only top-N refresh into dict_terms.csv (Step 2 helper).
  build-dicts.mjs          CSVs → dict_*.json with validation (Step 3). npm: cf:dicts
  audit-catalog.mjs        Diagnostic (Step 1).
  show-easy.mjs            Diagnostic (Step 1).
data/
  scrape-raw.json          Committed. Source of truth for build-catalog.
  scrape-progress.json     GITIGNORED. Per-run resume artifact.
  catalog.json             Committed. Editor reads this at build time (Step 5).
  frequency.csv            Committed. Seeds dict_terms.csv.
  frequency_templates.csv  Committed. Seeds dict_templates.csv.
  exclude_spinoff.txt      Committed. Hand-curated title-based exclusion list.
  dict_terms.json          BUILT (Step 3). 515 terms, 352 aliases.
  dict_templates.json      BUILT (Step 3). 8 templates.
data/csv/
  dict_terms.csv           Hand-edited source of truth (Step 2). VI complete.
  dict_templates.csv       Hand-edited source of truth (Step 2). VI complete.
worker/
  src/index.js             Catfishing routes + matcher + stats ADDED (Step 4).
  .dev.vars                GITIGNORED. Local EDITOR_PASSWORD for `wrangler dev`.
package.json               npm scripts incl. cf:dicts.
```

### Not yet built (Steps 5–6)

```
src/games/catfishing/
  play.js                          player runtime (Step 6)
  editor.js                        editor runtime (Step 5)
  matcher.js                       OPTIONAL client-side normalize (feedback only) — the
                                   authoritative matcher is server-side; a client copy is
                                   only for instant "did you mean" feedback if desired.
catfishing.html                    editor entrypoint (Step 5)
worker/src/lib/dict-resolver.js    author-time EN→VI resolver (Step 5) — see §7.5
```

Modified in Step 5/6:

```
public/play.html or play.html      dispatch #cf/ to catfishing module
src/i18n/en.json                   add catfishing.* keys
src/i18n/vi.json                   add catfishing.* keys (matching structure)
src/styles/base.css                catfishing CSS vars (all three themes)
vite.config.js                     add catfishing.html as a Rollup input
```

---

## 5. Data schemas

### `data/csv/dict_terms.csv` (Step 2 — as built)

Actual header (diverged from Rev. 2's spec — no `aliases_vi`, added `needs_review`):

```csv
en,vi,aliases_en,notes,needs_review
Wizards,Phù thủy,Wizard,Pháp sư,
Muggle-borns,Phù thuỷ gốc Muggle,Muggle-born,,
```

- `aliases_en` inner separator: `;` (comma reserved for CSV).
- `notes` and `needs_review` are **build-ignored** — human triage aids only.
  (Some rows carry VI alt-spellings in `notes`; these are reference, not fed to
  the resolver/matcher. Confirmed with Linh.)
- Seeded top-500 from `frequency.csv`; hand-extended and VI-complete.

### `data/csv/dict_templates.csv` (Step 2 — as built)

```csv
pattern_en,pattern_vi,notes
{X} members,Thành viên của {X},
{X} participants,Người tham gia {X},
```

Exactly one `{X}` slot on each side.

### `data/dict_terms.json` (Step 3 output)

Shaped for the author-time resolver: `terms` keyed by NORMALIZED (trim+lowercase)
EN, plus an `aliases` index (normalized alias → canonical key) so both direct
hits and template-slot lookups resolve. Aliases never overwrite a real term.

```json
{
  "meta": { "generated_by": "scripts/build-dicts.mjs", "source": "data/csv/dict_terms.csv", "term_count": 515, "alias_count": 352 },
  "terms": {
    "wizards": { "en": "Wizards", "vi": "Phù thủy", "aliases_en": ["Wizard"] }
  },
  "aliases": { "wizard": "wizards" }
}
```

### `data/dict_templates.json` (Step 3 output)

Ordered array preserving authoring order:

```json
{
  "meta": { "generated_by": "scripts/build-dicts.mjs", "source": "data/csv/dict_templates.csv", "template_count": 8 },
  "templates": [ { "pattern_en": "{X} members", "pattern_vi": "Thành viên của {X}" } ]
}
```

`build-dicts.mjs` validation: skips empty-`vi` rows, drops duplicate `en` (first
wins), requires exactly one `{X}` per template side, collapses case-variant
duplicate patterns, warns on alias collisions. `notes`/`needs_review` ignored;
`needs_review=TRUE` rows still emitted.

### KV: `catfishing:{id}` (one per published set)

```json
{
  "type": "catfishing",
  "collectionId": "abc12",
  "title": "optional",
  "questions": [
    {
      "answer": { "en": "Hermione Granger", "vi": "Hermione Granger", "aliases_en": ["Hermione"], "aliases_vi": [] },
      "clues": [ { "en": "Gryffindors", "vi": "Nhà Gryffindor" }, { "en": "Muggle-borns", "vi": "Phù thuỷ gốc Muggle" } ],
      "difficulty": "easy"
    }
  ]
}
```

- Exactly 5 questions per set. `answer.en`/`answer.vi` required; alias arrays
  optional. `clues` 1–60 entries, each with non-empty `en`+`vi`.
  `difficulty ∈ easy|medium|hard`.
- **Payload cap: 16 KB for this game.** Implemented as `MAX_BYTES_BY_TYPE`
  (`connections`/`strands`: 8 KB, `catfishing`: 16 KB; fallback 8 KB).

### KV: `stats:cf:{id}`

```json
{ "plays": 47, "completions": 31, "correct": [38,16,31,43,13], "overrides": [2,0,5,1,0] }
```

- `plays`: incremented on `/stats/start` (once per session per player, gated by
  a `cf:played:{id}` localStorage flag).
- `completions`: incremented on `/stats/complete` (once per session).
- `correct[q]`: incremented server-side inside `/guess` on `status:"hit"`.
  Never client-callable — a true-match measure.
- `overrides[q]`: incremented by the player-callable `/stats/override` route
  when a player self-declares correct. Kept **separate** from `correct[q]` on
  purpose: `correct%` stays honest, and a rising `overrides[q]` is the editor's
  cue that that answer's aliases need widening. Trivially inflatable by design
  (same trust model as the feature).
- KV eventual consistency → small undercounts under concurrent load. Acceptable.

---

## 6. Worker routes (Step 4 — BUILT, single-file `worker/src/index.js`)

**Divergence from Rev. 2 §6, flagged per §16:** rather than a native
`/api/catfishing/*` namespace, Catfishing reuses the existing type-generic
`/api/puzzle/*` machinery. `catfishing` was added to `ALLOWED_TYPES`, so
create/update/fetch work with zero new code, and game-specific routes mirror the
Strands `/api/puzzle/{type}/{id}/*` precedent. This inherits collection handling
and the fetch-masking pattern for free and keeps the API internally consistent.

**Public (unauth):**

```
POST /api/puzzle                                  create (type:catfishing)   [editor-gated by password]
PUT  /api/puzzle/catfishing/:id                   update                     [editor-gated by password]
GET  /api/puzzle/catfishing/:id                   fetch — MASKED (clues + q_index only, no answers,
                                                  no difficulty) unless valid password header
POST /api/puzzle/catfishing/:id/guess             { status:"hit"|"miss"|"confirm", suggested? }
                                                  body { q_index, guess }
POST /api/puzzle/catfishing/:id/reveal            { answer }  body { q_index }
POST /api/puzzle/catfishing/:id/stats/start       { ok:true }
POST /api/puzzle/catfishing/:id/stats/complete    { ok:true }
POST /api/puzzle/catfishing/:id/stats/override    { ok:true }  body { q_index }
GET  /api/puzzle/catfishing/:id/stats             { plays, completions, correct[], overrides[] }
```

Reused helpers: `parseJsonBody`, `validateAndSerialize`, `timingSafeEqual`,
`checkPassword`, `generateId`, `assertCollectionExists`, `puzzleMetadata`, `json`.

New pieces added to `index.js`:
- `validateCatfishing()` — shape guard (5 questions, bilingual answers, clues,
  difficulty).
- `maskCatfishing()` — the single point shaping the answer-free public body;
  fetch-masking generalized to a `MASKERS` map covering Strands + Catfishing.
- Matcher (§10) — inline, deterministic, no deps.
- Stats handlers — `correct[]` bumped only inside `/guess`; `overrides[]` via
  `/stats/override`; `plays`/`completions` via start/complete.

**Editor list / stats-summary:** deferred to Step 5 (no precedent in the current
worker; editor `get` is already free via the authenticated GET). Add
`GET /api/catfishing/editor/list` and `/stats-summary` when the editor UI defines
its exact needs.

**Important divergence from Connections:** Connections' public GET returns the
full puzzle (client validates locally). Catfishing (like Strands) strips the
solution and validates server-side via `/guess`. Per Project Instructions §3.

---

## 7. Content pipeline

### 7.1–7.3 Scraper / Catalog / Frequency (Step 1 — BUILT)

Unchanged from Rev. 2. Hit the Fandom MediaWiki API, traverse curated category
seeds, filter/refine/score into `catalog.json` (~7.8k entities), then emit
`frequency.csv` + `frequency_templates.csv`. See Rev. 2 §7.1–7.3 for the full
seed list, blocklists, entity-type refinement rules, and the prominence-scoring
formula (`0.5·cat + 0.4·length + 0.1·alias`, per-type p99, cutoffs
`easy>=0.65 / medium>=0.35`). npm: `cf:scrape`, `cf:catalog`, `cf:frequency`,
`cf:dict-append`, `cf:audit`, `cf:show-easy`.

### 7.4 Dictionary build (`scripts/build-dicts.mjs`) — BUILT (Step 3)

Reads the two CSVs, validates, emits `data/dict_terms.json` +
`data/dict_templates.json`. Deterministic and idempotent. npm: `cf:dicts`.
Last run: 515 terms / 352 aliases, 8 templates, 0 empty-VI, 0 dup-en. See §5.

### 7.5 Resolver (`worker/src/lib/dict-resolver.js`) — NOT YET BUILT (Step 5)

Runs in the **editor at author-time** (not player runtime). Resolution order per
raw EN category:
1. Direct hit in `dict_terms` (by normalized `en` or `aliases` index) → return VI.
2. Template match in `dict_templates` — extract `{X}` slot, look the slot up as a
   term, substitute → return VI.
3. Template match, unknown slot → `{ status: "template_unresolved" }` (editor
   prompts for slot translation).
4. No match → `{ status: "unresolved" }` (editor fills manually).

This is the piece that turns "Muggle-borns" into "Phù thuỷ gốc Muggle" from
`dict_terms.json`. Until it's built and wired into the editor, clue VI must be
typed by hand (as in the Step 4 smoke-test placeholders).

### 7.6 Diagnostics — BUILT

`audit-catalog.mjs`, `show-easy.mjs`. See Rev. 2 §7.6.

---

## 8. Editor UX (`/catfishing.html`) — Step 5

Password-gated, single-page vertical flow. Unchanged from Rev. 2 §8:

- Accordion of 5 questions (Q1 expanded, rest collapsed).
- Entity picker: searchable autocomplete over `catalog.json` (~7.8k entries).
  Selecting pre-fills answer EN, aliases EN (from Fandom redirects), and the
  category resolution table.
- Category resolution table: EN read-only, VI editable, colour-coded by resolver
  status (green = direct term hit, yellow = template hit with unknown slot,
  red = no match).
- Bottom section: "Copy translation prompt" (collects red/yellow EN strings →
  Claude-ready prompt with Lý Lan canonical style notes), "Paste translations"
  (JSON → fills VI), Preview, Publish (→ `POST /api/puzzle` type:catfishing →
  short ID + `/cf/{id}` link).
- List view: needs `GET /api/catfishing/editor/list` (build alongside).

Match the existing Connections/Strands editor chrome (header, theme/lang toggles,
password gate, collection control) by reading the repo — see §16.

---

## 9. Player UX (`/play.html#cf/{id}`) — Step 6

Unchanged from Rev. 2 §9 except the override affordance:

- Load: parse hash → GET puzzle (masked, no answers) → render question at
  `current_q` (resumed from localStorage) → `POST /stats/start` (gated by
  `cf:played:{id}` flag).
- Per-question: alphabetized clue list (sort by current UI language, re-sort on
  `lang-changed`), text input, single [Guess] button.
- Guess response:
  - **hit** → ✓, `POST /reveal` for canonical, [Next →].
  - **confirm** → "Did you mean X?" [Yes] [No]. **Yes → re-submit the suggested
    canonical as a normal `/guess`** (→ exact hit; this is what makes it count in
    `correct[q]`). No → miss.
  - **miss** → ✗, `POST /reveal`, [Next →].
- **Override:** on a miss (or a "No" to confirm), show an "Actually, I was right"
  control. Clicking it awards the point client-side (localStorage score) and
  fires `POST /stats/override { q_index }`. No server score state.
- End-of-set: score, per-question summary with reveal, rare-answer flag for
  questions with <30% `correct%`, `POST /stats/complete`, share button.
- Progress saved after each guess. Refresh mid-set resumes at current Q, previous
  answers locked.

`/reveal` trust model: client calls it after receiving hit/miss/confirm. Calling
it early only spoils the caller's own game. No server-side session state — by
design.

---

## 10. Matcher — BUILT (inline in `worker/src/index.js`, Step 4)

Deterministic, no external calls, no deps. Decision: kept **inline** (not
`worker/src/lib/matcher.js`) to honour the locked single-file worker convention
(§14) — the worker already inlines a ~75-line Strands validator. Extraction stays
a trivial refactor if worker unit tests are added later.

- **Normalize:** lowercase; NFD + strip combining marks; punctuation → space;
  strip leading honorific tokens (EN + VI); collapse whitespace.
  - **đ/Đ is retained**, not folded to `d`. NFD leaves it intact (it is an atomic
    letter with no combining-mark decomposition), while vowel tone-marks still
    fold (á→a, ầ→a) so an undiacriticized Vietnamese guess still matches. Per
    Linh's explicit call.
  - Honorifics stripped: `professor, prof, mr, mrs, ms, miss, dr, giao su, gs,
    thay, co, ong, ba` (post-diacritic-fold forms). Tune list before launch.
- **Exact** (post-normalization) match against `[answer.en, answer.vi,
  ...aliases_en, ...aliases_vi]` → `hit`.
- **Fuzzy:** `max(levenshteinRatio, trigramJaccard)`. `>= 0.85` → `confirm`,
  returning the best canonical suggestion. Threshold is a single constant
  (`CF_FUZZY_THRESHOLD`) — retune after playtesting.
- Never returns the answer except on exact hit or `POST /reveal`. `confirm`
  returns only the suggested canonical (which the player effectively typed).

Verified locally (Step 4): `hermione granger`→hit, `Hermione`(alias)→hit,
`Hermionee Granger`(typo)→confirm/suggested "Hermione Granger", `Ron Weasley`→miss.

---

## 11. Stats (Option A) — server-side BUILT (Step 4), player display in Step 6

Deliberate exception to "no analytics"; aggregate-only, no per-player data.

- Track `plays`, `completions`, `correct[q]`, `overrides[q]` per set (§5).
- Display to player at end-of-set: `completions` and per-Q `correct%`. `plays`
  and `overrides[]` are editor-facing.
- Inflation prevention: localStorage flags gate `stats/start` and
  `stats/complete`; `correct[q]` is server-side inside `/guess`, never
  client-callable. `overrides[q]` IS client-callable by design (honor system).

---

## 12. i18n additions — Step 5/6

Add to `src/i18n/en.json` and `src/i18n/vi.json` in the same patch. Match the
existing nested key structure (verify against Connections/Strands first).

```
catfishing: {
  editor: { title, entity_picker_placeholder, difficulty_easy, difficulty_medium,
            difficulty_hard, copy_prompt, paste_translations, preview, publish,
            save_draft, add_to_collection, translation_status_green,
            translation_status_yellow, translation_status_red },
  play:   { question_of, score, guess_placeholder, guess_button, confirm_prompt,
            yes, no, next_question, override_button, end_score, end_completed_count,
            share, rare_answer_flag }
}
```

(`override_button` is new this revision — the "I was right" affordance.)

---

## 13. Rollout order

| # | Step | Status |
|---|---|---|
| 1 | Scraper + catalog + frequency | **BUILT** |
| 2 | Dictionary CSVs (seeded + VI complete) | **BUILT** |
| 3 | Dictionary build script (`build-dicts.mjs`) | **BUILT & verified** |
| 4 | Worker routes + matcher + stats (incl. override) | **BUILT & locally verified — pending `wrangler deploy`** |
| 5 | Editor UI + dict-resolver | Not started |
| 6 | Player UI (incl. override button) | Not started |
| 7 | Stats endpoints | **Server-side done in Step 4**; player display in Step 6 |
| 8 | Author 5 sets (25 questions) | Not started |
| 9 | Full scrape rerun (optional refresh) | Not started |

---

## 14. Open decisions & confirmations

**Locked (do not renegotiate without asking):**

- ✅ Game format: 5-question sets, full clue dump, one guess each.
- ✅ Difficulty ratio: 2:2:1 default, internal tag, not shown to player.
- ✅ Content sourcing: HP Wiki scrape + hand-curated dictionary.
- ✅ Publication: share-by-link, homepage collection via `collectionId`.
- ✅ Translation workflow: Claude in separate chat, copy-prompt pattern in editor.
- ✅ Matcher: bilingual, NFD-fold **retaining đ**, honorifics stripped, fuzzy 0.85,
  "did you mean" confirm.
- ✅ **Confirm→Yes re-submits the suggested canonical as a normal guess** (so it
  counts in `correct[q]`).
- ✅ **Player override (honor system):** self-declare correct on a miss; point
  awarded client-side; recorded in a **separate** server `overrides[q]` counter,
  never in `correct[q]`.
- ✅ Stats: Option A (KV counters) — plays, completions, correct[], overrides[].
  Show only completions + correct% to player.
- ✅ Payload cap: 16 KB (via `MAX_BYTES_BY_TYPE`).
- ✅ Worker structure: single-file; matcher inline (no `lib/` split).
- ✅ **Route shape: reuse `/api/puzzle/catfishing/*` (NOT `/api/catfishing/*`).**
- ✅ Files land directly in repo (not zips).
- ✅ dict_terms.csv schema: `en,vi,aliases_en,notes,needs_review`; `notes` +
  `needs_review` build-ignored; no `aliases_vi` column.
- ✅ Scoring: `0.5·cat + 0.4·length + 0.1·alias`, per-type p99, no bonus tier.
- ✅ Difficulty cutoffs: `easy>=0.65`, `medium>=0.35`.
- ✅ Alphabetization language: sort by current UI language.

**To verify by reading the repo before writing Step 5/6 patches:**

- ⬜ Connections/Strands pattern for adding a puzzle to a homepage collection
  (editor control + `collectionId` field).
- ⬜ Vite MPA config — add `catfishing.html` as a Rollup input.
- ⬜ i18n nesting convention.
- ⬜ `play.html` / `src/*.js` hash-dispatch — how it branches on `#c/`, `#s/`.
- ⬜ Editor chrome components to reuse (header, toggles, password gate).

**Open (needs Linh's call during Step 5/6 build):**

- ⬜ Fuzzy threshold retune after playtesting (`CF_FUZZY_THRESHOLD`).
- ⬜ Honorific list additions.
- ⬜ Editor `list` + `stats-summary` route shapes (define with the editor UI).
- ⬜ Whether `Head of X` / role-page patterns should extend further.

---

## 15. Deploy sequence

Non-negotiable for any patch touching Worker code:

1. `wrangler deploy` (Worker) first.
2. Verify new API endpoints respond (curl / PowerShell `Invoke-RestMethod` /
   `wrangler dev`).
3. Push to `main` (Pages deploys).

Reverse order breaks: new frontend hits old API, players error mid-set.
Pages-only patches (no Worker changes) push to `main` directly.

**Step 4 note:** worker-only, and no frontend consumes the routes yet, so
`wrangler deploy` now is low-risk (no client/API mismatch window). The Step 5/6
frontend that consumes these routes must land after this deploy.

### Local dev auth

`wrangler dev` does NOT load production secrets. Local `EDITOR_PASSWORD` comes
from `worker/.dev.vars` (gitignored) — currently `localdev`. Enter that at the
editor password prompt when testing locally. Production `EDITOR_PASSWORD` stays
a Cloudflare secret set via `wrangler secret put`.

---

## 16. Match existing Connections/Strands patterns

For anything already existing, **read the repo and match** rather than
reimplementing from mocks. Match for: top header/nav, collection mechanism
(KV shape + editor control), theme toggle (three themes, `theme-changed` event),
language toggle (`lang-changed`), editor password gate, short-ID generation,
CSS variable naming, footer/meta chrome.

Diverge only where the game genuinely differs (accordion editor, confirm dialog,
override affordance, per-question progression). Flag divergences with rationale
(as done for the route-shape reuse in §6).

---

## 17. Reference mockups

Delivered earlier: `Catfishing HP Mockup.html` (player mid-question),
`... - Result State.html` (post-guess reveal), `... - End Screen.html`
(end-of-set score), `... - Editor.html` (editor accordion + translation helper).
Visual intent/layout only — chrome comes from the repo (§16). The end-screen and
result-state mocks predate the override affordance; add the "I was right" control
in Step 6.

---

## 18. Immediate next action

Step 5 — editor UI + `dict-resolver.js`. In a fresh chat working from this repo:

1. Read the repo (§14 verify-list) — Vite config, i18n nesting, hash dispatch,
   collection control, editor chrome.
2. Build `worker/src/lib/dict-resolver.js` reading `data/dict_*.json` (§7.5).
   Decide inline-vs-lib consistent with §14 (the resolver is author-time editor
   code, not the player-runtime worker path — a lib file is reasonable here).
3. Build `catfishing.html` + `src/games/catfishing/editor.js`: entity picker over
   `catalog.json`, category resolution table, copy-prompt / paste-translations,
   preview, publish. Add editor `list` route + define its shape.
4. Add catfishing i18n keys (EN + VI, same patch), CSS vars for all three themes.
5. Then Step 6 (player UI, incl. override button) → Step 8 (author 5 sets).

Deploy the Step 4 worker (`cd worker && npx wrangler deploy`) before any Step 5/6
frontend that calls these routes.
