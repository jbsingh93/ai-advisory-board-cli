import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['bin/aab.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist/bin',
  clean: true,
  dts: false,
  sourcemap: true,
  splitting: false,
  shims: false,
  banner: { js: '#!/usr/bin/env node' },
});
