import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// ESM-safe __dirname (package.json uses "type": "module")
const __dirname = dirname(fileURLToPath(import.meta.url));

// Multi-page setup: home, editor, and play all ship as separate HTML entrypoints.
// The Worker is deployed independently via wrangler and lives at its own URL.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        editor: resolve(__dirname, 'editor.html'),
        play: resolve(__dirname, 'play.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
