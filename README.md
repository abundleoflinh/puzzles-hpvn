# HPVN Puzzles

Custom NYT Connections–style puzzle site, hosted on Cloudflare Pages + Workers + KV. Room for a Strands mode later.

## Stack

- **Vite** — multi-page build (`index.html`, `editor.html`, `play.html`)
- **Vanilla JS** — no framework
- **Cloudflare Pages** — static hosting, auto-deploys from `main`
- **Cloudflare Worker** — puzzle write/read API at `/api/*`
- **Cloudflare KV** — puzzle storage, keyed as `{type}:{id}`

## Phase 0 setup

### 1. Install

```bash
npm install
```

### 2. Wire up the Worker

Edit `worker/wrangler.toml` — replace `YOUR_KV_NAMESPACE_ID` with the ID from Cloudflare dashboard (Workers & Pages → KV → PUZZLES).

Set the editor password as a secret:

```bash
cd worker
npx wrangler login          # first time only
npx wrangler secret put EDITOR_PASSWORD
# paste your password when prompted
```

Deploy the Worker:

```bash
npx wrangler deploy
```

Note the URL Cloudflare gives you (e.g. `https://hpvn-puzzles-api.<your-subdomain>.workers.dev`).

### 3. Route `/api/*` from Pages to the Worker

In Cloudflare dashboard → your Pages project → **Settings → Functions → Service bindings**… actually, cleaner: use a **Worker route** on your Pages domain.

Dashboard → Workers & Pages → your Worker (`hpvn-puzzles-api`) → **Settings → Triggers → Custom Domains / Routes**. Add a route:

```
<your-pages-domain>.pages.dev/api/*
```

That way `hpvn-puzzles.pages.dev/api/health` hits the Worker, everything else serves static files.

### 4. Verify

Push to `main` → Pages auto-deploys → visit:

- `https://<your-pages-domain>.pages.dev/` — placeholder home page
- `https://<your-pages-domain>.pages.dev/api/health` — should return `{"ok":true,"ts":"..."}`

If both work, Phase 0 is done.

## Local dev (later phases)

```bash
# Terminal 1: Worker
cd worker && npx wrangler dev

# Terminal 2: Vite (proxies /api → local Worker)
npm run dev
```

## Repo layout

```
├── index.html / editor.html / play.html   # entrypoints
├── src/                                    # shared lib, styles, i18n, game modules
├── worker/                                 # Cloudflare Worker (API)
├── public/_redirects                       # short-link routing
└── vite.config.js
```
