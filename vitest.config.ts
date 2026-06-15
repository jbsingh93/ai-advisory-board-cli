import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // A few integration-style tests do real work (subprocess skill builds,
    // a live PC recon scan) and run 3–9s locally. On slower CI runners under
    // shard parallelism they exceed Vitest's default 5s per-test timeout, so
    // give them generous headroom. Fast unit tests never approach this.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
