import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    /* Pinned, because on Windows Vite's default of `localhost` binds to `::1`
       only — and the README's http://127.0.0.1:5173 then refuses to connect. */
    host: '127.0.0.1',
    /**
     * The API is reached through `/api`, proxied to the Express server.
     *
     * Two reasons over calling `http://127.0.0.1:4000` directly. The browser
     * sees one origin, so there is no CORS to configure. And production will
     * serve both from one origin behind a reverse proxy, so the client code
     * written against `/api` is the code that ships — nothing changes between
     * development and deployment.
     *
     * `127.0.0.1` rather than `localhost`: on Windows `localhost` resolves to
     * `::1` first, which fails if the API listens on IPv4 only
     * (see README, Testing the API).
     */
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
        rewrite: (url) => url.replace(/^\/api/, ''),
      },
    },
  },
});
