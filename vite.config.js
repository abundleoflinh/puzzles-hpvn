import { defineConfig } from 'vite';
import { resolve } from 'path';

// Multi-page setup: home, editor, and play all ship as separate HTML entrypoints.
// The Worker is deployed independently via wrangler and lives at /api/*.
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
    // During local dev, proxy /api/* to the local wrangler dev server.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
