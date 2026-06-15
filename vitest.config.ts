import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // A few integration-style tests do real work (subprocess skill builds,
    // a live PC recon scan). They run 3–9s locally but 25–31s on slower CI
    // runners (ubuntu/windows) under shard parallelism — enough to trip the
    // old 30s per-test ceiling and, on a blocked worker, Vitest's internal
    // "onTaskUpdate" RPC timeout. Give them generous headroom; fast unit tests
    // never approach this. (See PR #34 / #33 CI failures, 2026-06-15.)
    testTimeout: 60000,
    hookTimeout: 60000,
    teardownTimeout: 60000,
    // Run test files sequentially in a single fork. On constrained CI runners
    // (esp. windows, 2 cores) the parallel default lets ~6 forks contend while
    // the heavy integration tests (solve-orchestrator's recursive cpSync,
    // pc-scan's live scan) block their worker for 90s+, tripping Vitest's
    // worker "onTaskUpdate" RPC timeout even though every test passes. Giving
    // each file the whole machine keeps the heavy ones well under the limit.
    // Modules are still isolated per file (isolate defaults true). The suite is
    // small, so the sequential cost is modest.
    poolOptions: { forks: { singleFork: true } },
  },
});
