import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// ESM-safe __dirname (package.json uses "type": "module")
const __dirname = dirname(fileURLToPath(import.meta.url));

// Multi-page setup: home, editor, and one play page per game type all ship as
// separate HTML entrypoints. The Worker is deployed independently via wrangler
// and lives at its own URL. When adding a new game, add a new play-<name>.html
// entrypoint here.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        editor: resolve(__dirname, 'editor.html'),
        playConnections: resolve(__dirname, 'play-connections.html'),
        playStrands: resolve(__dirname, 'play-strands.html'),
        playCatfishing: resolve(__dirname, 'play-catfishing.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
