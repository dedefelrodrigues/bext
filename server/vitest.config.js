import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file runs in isolation, so an in-memory DB per file is fully
    // isolated. Set before any module imports src/db.
    setupFiles: ['./test/setup.js'],
  },
});
