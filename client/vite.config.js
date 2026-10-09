import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: {
      // shadcn-svelte compatibility.
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // Override to point the dev client at another backend (a scratch DB, say).
      '/api': process.env.BEXT_API_URL ?? 'http://localhost:3001',
    },
  },
});
