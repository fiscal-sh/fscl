import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  sourcemap: false,
  clean: true,
  minify: false,
  splitting: false,
  target: 'node20',
  shims: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
