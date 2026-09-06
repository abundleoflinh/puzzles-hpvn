# Puzzles (HPVN)

A personal, editor-authored puzzle site for hosting NYT-style word games. Puzzles
are created behind a password gate and shared by link — no accounts, no sign-ups.
The site currently ships **Connections** and is scaffolded so additional game types
(e.g. Strands) can be added later without rearchitecting.

- **Live API:** `https://hpvn-puzzles-api.vophuonglinh.workers.dev`
- **Repo:** `abundleoflinh/puzzles-hpvn`
- **Hosting:** Cloudflare Pages (static frontend) + Cloudflare Worker (`/api/*`) + Cloudflare KV (storage)

This README has three parts:

1. [**How it works**](#1-how-it-works) — architecture, structure, data model, and conventions.
2. [**Replicate the site elsewhere**](#2-replicate-the-site-elsewhere-connections-only) — a rebuild guide (Connections-only) for a fresh deployment, including non-Cloudflare hosting.
3. [**Migrate the puzzles**](#3-migrate-the-puzzles) — move existing puzzles and collections to the new backend.

---

## 1. How it works

### Stack

Vanilla JavaScript with [Vite](https://vitejs.dev/) as a multi-page bundler — no framework, no runtime dependencies. The backend is a single Cloudflare Worker; storage is a single Cloudflare KV namespace. That's the whole system.

### Architecture

```
 Browser
   │
   ├── Cloudflare Pages (static)          ── serves index/editor/play + built JS/CSS
   │      index.html   → src/home.js      home: enter a code, browse collections
   │      editor.html  → src/editor.js    password-gated puzzle authoring
   │      play.html    → src/play.js      the game
   │      public/_redirects               /c/:id and /s/:id → /play.html#…
   │
   └── Cloudflare Worker  (/api/*)        ── separate deployment, own URL
          worker/src/index.js
                │
                └── Cloudflare KV  (binding: PUZZLES)   ── the only datastore
```

The frontend and the Worker are **deployed independently**. The frontend calls the Worker at the absolute URL hardcoded in `src/lib/api.js` (`API_BASE`). There is no server-side rendering and no player state on the server.

### Repository structure

| Path | Purpose |
|---|---|
| `index.html`, `editor.html`, `play.html` | The three page entrypoints. Each loads one script from `src/` and provides `data-slot` mount points that JS fills in. |
| `src/home.js` | Home page: parse a pasted code/link and redirect to play; render the collections list. |
| `src/play.js` | The Connections game: fetch → normalize → render grid → gameplay loop → win/lose + share. |
| `src/editor.js` | Authoring UI: password gate, load/edit existing, size & options, pinned-tile layout, submit. |
| `src/lib/api.js` | Thin `fetch` wrapper around the Worker. Holds `API_BASE`. |
| `src/lib/connections.js` | Connections constants (size bounds, mistakes) + `coerceDifficulty` / `inferSize`, shared by play + editor. |
| `src/lib/util.js` | Cross-page helpers: `escapeHtml`, `shuffle`, short-link parsing (`parseShortLink`, `SHORT_ID_RE`, `TYPE_PREFIX`), `copyWithFeedback`. |
| `src/lib/theme.js` | Three-theme system (`light` / `dark` / `hpvn`) via `data-theme` on `<html>`. |
| `src/lib/i18n.js` | Dictionary-based i18n (`t(key)`), language detection, DOM translation via `data-i18n*` attributes. |
| `src/lib/storage.js` | `localStorage` wrappers, namespaced under `hpvn.` — theme, language, per-puzzle progress. |
| `src/lib/chrome.js` | Shared page chrome: header/nav, footer credits, info modal (with focus trap), theme/lang toggles. |
| `src/i18n/en.json`, `src/i18n/vi.json` | UI string dictionaries. Must stay at key parity. |
| `src/styles/base.css` | All styling. Theme tokens as CSS variables under `:root[data-theme=…]`. No hardcoded colors in components. |
| `worker/src/index.js` | The API: puzzle + collection CRUD, validation, auth, ID generation. |
| `worker/wrangler.toml` | Worker config **with the real KV namespace id** — gitignored. |
| `worker/wrangler.toml.example` | Committed template; copy to `wrangler.toml` and fill in your KV id. |
| `vite.config.js` | Multi-page input map + a dev proxy from `/api` → local Worker. |
| `public/_redirects` | Cloudflare Pages short-link rewrites. |

### Data model (KV)

One KV namespace (bound as `env.PUZZLES`) holds everything, keyed by prefix:

| Key | Value |
|---|---|
| `{type}:{id}` — e.g. `connections:Ab3kD` | The full puzzle JSON (see below). `{type}` ∈ `connections`, `strands`. |
| `collection:{id}` | `{ "name": string, "createdAt": ISO8601 }` — a named group of puzzles. |

IDs are **5-character base58** (`123…XYZ…xyz`, minus `0/O/I/l` to avoid look-alikes), generated with `crypto.getRandomValues`. Collisions are retried (odds ≈ 1 in 656M/attempt).

A Connections puzzle body:

```jsonc
{
  "type": "connections",
  "size": 4,                       // grid is size×size; integer in [3, 6]
  "groups": [                      // exactly `size` groups, ordered easiest → hardest
    { "name": "Group name", "difficulty": 1, "words": ["A", "B", "C", "D"] }
    // difficulty = tier (1..size). Legacy string tiers (yellow/green/blue/red/purple) still load.
  ],
  "mistakeMode": 4,                // integer 3..6, or "endless"
  "revealOnFail": true,            // show the solution on loss (omitted when endless)
  "defaultTheme": "hpvn",          // optional; applied only if the viewer hasn't chosen one
  "defaultLang": "vi",             // optional; same rule
  "title": "My puzzle",            // optional; ≤ 80 chars
  "collectionId": "Xy9Qp",         // optional; must reference an existing collection
  "createdAt": "2026-01-01T…Z",    // used for in-collection ordering
  "pinnedLayout": [null, {"g":0,"w":2}, …]  // optional; size×size slots fixing first-load tile positions
}
```

Old puzzles saved before newer fields existed still work — the client fills sensible defaults on read (`normalizePuzzle` in `play.js`), so there is **no server-side migration**.

### API

All routes live under `/api`. Answers travel to the client in the puzzle GET response — the client validates guesses locally. Writes require the editor password.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/puzzle` | password | Create a puzzle; returns `{ id, url }`. |
| `PUT` | `/api/puzzle/:type/:id` | password | Update an existing puzzle. |
| `GET` | `/api/puzzle/:type/:id` | public | Fetch the full puzzle (including answers). |
| `POST` | `/api/collection` | password | Create a collection; returns `{ id, name, createdAt }`. |
| `GET` | `/api/collection/:id` | public | Fetch one collection's metadata. |
| `GET` | `/api/collections` | public | List all collections with their puzzles — **metadata only** (id, title, createdAt); never words or answers. |
| `GET` | `/api/auth/check` | password | Validate the editor password (used by the gate). |
| `GET` | `/api/health` | public | Liveness check. |

### Routing & short links

Puzzles share as short paths — `/c/{id}` (Connections), `/s/{id}` (Strands). `public/_redirects` 302s these to the hash route the play page reads:

```
/c/:id  /play.html#c/:id  302
/s/:id  /play.html#s/:id  302
```

Cloudflare Pages preserves the URL fragment in the redirect, so `play.js` picks the id up from `location.hash`.

### Theming

Three first-class themes — `light`, `dark`, and `hpvn` — set via `data-theme` on `<html>`, which flips CSS variables defined in `src/styles/base.css`. Initial theme priority: the puzzle's `defaultTheme` (play page only, if the viewer hasn't chosen) → the viewer's saved preference → system dark-mode → `light`. Changing theme dispatches a `theme-changed` event; components re-render off it rather than re-reading state.

### Bilinguality (EN + VI)

All UI chrome goes through `t(key)` against `src/i18n/{en,vi}.json`. Puzzle *content* is whatever the editor typed; only the *chrome* toggles languages. `en.json` and `vi.json` must carry the **same keys** — new UI strings need both in the same change. A language switch dispatches `lang-changed`, which triggers re-renders of dynamic/interpolated strings.

### Player persistence

`localStorage` only, namespaced `hpvn.`: theme, language, and per-puzzle in-progress state (`hpvn.progress.{type}.{id}`). No server-side player state, no analytics, no leaderboards.

### Security model

- **Editor auth** is a single shared password stored as the Worker secret `EDITOR_PASSWORD`, sent in the `X-Editor-Password` header and compared with a constant-time equality check. There is **no client-side password check** — the gate only decides whether to render the editor UI; every write is re-verified server-side.
- **Answers are not secret.** The full puzzle (including group answers) is returned by the public GET so the client can validate guesses offline. `revealOnFail` controls the in-UI reveal only — it is a UX choice, not a security boundary. Don't treat puzzle answers as confidential.
- **Payload caps:** puzzles ≤ 8 KB, collections ≤ 1 KB, enforced server-side after validation.
- **`wrangler.toml` is gitignored** because it carries the real KV namespace id; only `wrangler.toml.example` is committed.

### Local development

```bash
npm install

# Terminal 1 — the Worker (proxied at /api). Needs worker/wrangler.toml (see below).
cd worker && npx wrangler dev          # serves on 127.0.0.1:8787

# Terminal 2 — the frontend. Vite proxies /api → 127.0.0.1:8787.
npm run dev
```

For local dev the frontend still calls the absolute `API_BASE` in `src/lib/api.js` by default. To exercise the local Worker instead, point `API_BASE` at `/api` (relative) so Vite's proxy handles it, or at `http://127.0.0.1:8787`.

### Deploy sequence

Always deploy the **Worker before** the frontend, so the API is ready when the new pages go live:

```bash
cd worker && npx wrangler deploy       # 1. Worker
# then push to main / build the frontend for Pages
npm run build                          # 2. Frontend (Cloudflare Pages builds from the repo)
```

---

## 2. Replicate the site elsewhere (Connections-only)

This section rebuilds the site as a **Connections-only** deployment on your own hosting. It is written to be followed by a person or handed to an AI coding agent. The multi-game scaffolding (Strands) is dropped here for simplicity — everything below assumes one game type.

### What you're building

- A static frontend with three pages (home, editor, play) — identical to this repo minus the Strands references.
- A small JSON API with the eight routes in the [API table](#api), restricted to `type = connections`.
- A key-value store holding `connections:{id}` and `collection:{id}` records.

### What to keep vs. drop for Connections-only

| Keep | Drop / simplify |
|---|---|
| All of `src/` and the three HTML entrypoints | In `worker/src/index.js`: set `ALLOWED_TYPES = new Set(['connections'])` |
| `src/lib/connections.js`, `src/lib/util.js` (helpers) | In `src/lib/util.js`: `TYPE_PREFIX`/`PREFIX_TYPE` can collapse to just `c`/`connections` |
| Theming, i18n, storage libs unchanged | `public/_redirects`: keep only the `/c/:id` rule; drop `/s/:id` |
| KV schema and puzzle body shape | i18n keys `home.collections.type.strands` and any `strands` branch |

None of the Connections gameplay depends on the scaffolding, so dropping it is purely deletions.

### Prerequisites

- Node.js 18+ and npm.
- A static host for the built frontend (Cloudflare Pages, Netlify, Vercel, GitHub Pages, S3+CloudFront, or any web server).
- A place to run the API (Cloudflare Workers, or any Node/serverless runtime) and a key-value store (Cloudflare KV, Redis, DynamoDB, SQLite, Postgres — anything with get/put/list-by-prefix).

### Step-by-step (staying on Cloudflare)

1. **Get the code.** Copy this repo (or clone it). Run `npm install`.
2. **Create a KV namespace.** In the Cloudflare dashboard → *Workers & Pages → KV → Create*, name it `PUZZLES`, and copy its id.
3. **Configure the Worker.** `cd worker`, `cp wrangler.toml.example wrangler.toml`, and paste the KV id into `wrangler.toml`. Pick a unique Worker `name`.
4. **Set the editor password (secret, never committed):**
   ```bash
   cd worker && npx wrangler secret put EDITOR_PASSWORD
   ```
5. **Deploy the Worker:** `npx wrangler deploy`. Note the resulting `*.workers.dev` URL (or attach a custom domain).
6. **Point the frontend at your Worker.** Edit `API_BASE` in `src/lib/api.js` to your Worker URL.
7. **Trim to Connections-only** (see the table above) — optional but recommended.
8. **Deploy the frontend.** Connect the repo to Cloudflare Pages (build command `npm run build`, output `dist`), or run `npm run build` and upload `dist/` to your static host.
9. **Wire short links.** Ensure `public/_redirects` ships with the build so `/c/:id` rewrites to `/play.html#c/:id`.
10. **Smoke test:** open the site → *Create* → enter the password → author a puzzle → open its `/c/{id}` link and play it.

### Adapting to non-Cloudflare hosting

Only four things are Cloudflare-specific; each has a plain swap.

| Cloudflare piece | What it does | Swap it for |
|---|---|---|
| **Pages (static host)** | Serves the built `dist/` | Any static host: Netlify, Vercel, GitHub Pages, S3+CloudFront, Nginx. Just publish `dist/`. |
| **Worker (`worker/src/index.js`)** | The `/api/*` handler | Any HTTP backend. It's a single `fetch(request, env)` function using web-standard `Request`/`Response` and `crypto.getRandomValues` — port it to Node (Express/Fastify), a serverless function (Lambda, Vercel/Netlify Functions), or Deno/Bun with minimal changes. Replace `env.PUZZLES.get/put/list` with your store's client. |
| **KV (`env.PUZZLES`)** | Key-value storage with prefix listing | Redis (`GET`/`SET`/`SCAN MATCH prefix*`), DynamoDB (partition-key prefix query), SQLite/Postgres (a `puzzles(key TEXT PRIMARY KEY, value JSON)` table with `LIKE 'prefix%'`), or any KV service. The code only needs get, put, and list-by-prefix. |
| **`public/_redirects`** | Short-link rewrites | Your host's redirect mechanism: Netlify `_redirects` (same syntax), Vercel `rewrites` in `vercel.json`, or an Nginx/Apache rewrite. Or make the play page an SPA route (`/c/:id`) that reads the id from the path instead of the hash. |

The frontend is fully portable as-is — it only assumes an HTTP API at `API_BASE` returning the JSON shapes documented above. Keep the [API contract](#api) and the [KV key shapes](#data-model-kv) identical and any backend will work.

### Prompt to hand an AI agent

> Rebuild the attached vanilla-JS puzzle site as a **Connections-only** app on `<your host>` with a `<your backend>` API and `<your store>` for storage. Preserve exactly: the three page entrypoints (home/editor/play), the `src/lib` modules, the KV key shapes (`connections:{id}`, `collection:{id}`), the puzzle JSON body, and the eight `/api` routes and their auth (shared password in `X-Editor-Password`, constant-time compare, secret never in client code). Set `ALLOWED_TYPES` to connections only, keep only the `/c/:id` short link, and point `API_BASE` at the new API. Do not add accounts, analytics, frameworks, or server-side player state.

---

## 3. Migrate the puzzles

Puzzles and collections are just KV records, so migration is an export → (optional transform) → import of two key prefixes: `connections:` and `collection:`. **Preserve the keys exactly** — the id in `connections:{id}` *is* the public short link `/c/{id}`, so keeping keys unchanged keeps every shared link working.

### 1. Export from Cloudflare KV

List the keys, then read each value. With Wrangler:

```bash
cd worker

# List all keys in the namespace (by binding name, from wrangler.toml).
npx wrangler kv key list --binding PUZZLES > keys.json

# Read one value:
npx wrangler kv key get --binding PUZZLES "connections:Ab3kD"
```

To dump everything into a single bulk file (`[{ "key": …, "value": … }]`), loop the keys — for example:

```bash
npx wrangler kv key list --binding PUZZLES \
  | jq -r '.[].name' \
  | while read -r k; do
      v=$(npx wrangler kv key get --binding PUZZLES "$k")
      jq -n --arg k "$k" --arg v "$v" '{key:$k, value:$v}'
    done | jq -s '.' > kv-dump.json
```

`kv-dump.json` now holds every puzzle and collection with its exact key.

### 2. Transform (only if the backend differs)

If the new store is also KV-shaped (another Cloudflare namespace, Redis, etc.), **no transform is needed** — the values are already the JSON strings the app expects. If moving to a relational store, insert each record as `(key, value)` into your `puzzles` table; the app reads the `value` back verbatim.

Keep the values as-is. The client tolerates older puzzle shapes on read, so you do **not** need to upgrade fields during migration.

### 3. Import to the new backend

**Cloudflare → Cloudflare** (new namespace) with a bulk file shaped `[{ "key": …, "value": … }]`:

```bash
npx wrangler kv bulk put --binding PUZZLES kv-dump.json
```

**Other stores:** iterate `kv-dump.json` and write each `{ key, value }` with your store's client (`SET key value` in Redis, a row insert in SQL, `PutItem` in DynamoDB). Because the id is embedded in the key, no id remapping is required.

### 4. Preserve short IDs & links

Do not regenerate ids. As long as `connections:{id}` and `collection:{id}` keep their original keys, existing `/c/{id}` links and `collectionId` references remain valid end-to-end. If you *must* renumber, you'd have to rewrite every `collectionId` inside puzzle bodies and reissue links — avoid it.

### 5. Verify

- `GET /api/collections` on the new API returns the expected collections and puzzle counts.
- A known `GET /api/puzzle/connections/{id}` returns the full body.
- Open a real `/c/{id}` link and confirm it plays.
- Spot-check a puzzle that belongs to a collection to confirm `collectionId` still resolves (the Worker rejects orphaned references on write, but reads tolerate them).

---

## Out of scope

By design, this project does not include: frameworks (React/Vue/etc.), analytics, user accounts, leaderboards, comments, or any server-side player state. Feature requests implying these should be pushed back on.
